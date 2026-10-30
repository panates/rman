import type { Package } from '../../../core/classes/package.js';
import { Service } from '../../../core/classes/service.js';
import { type PublishTarget, targetsOf } from '../../../core/interfaces/publish-target.js';
import { filesOwnedBy } from '../../../utils/bundled-packages.js';
import { dirtyReason, GitHelper } from '../../../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../../../utils/package-filter.js';
import { runBin } from '../../../utils/run-bin.js';
import { consumerNeeds } from '../../platforms/node/utils/consumer-needs.js';
import type { SpmPublishOptions } from './spm.target.js';

/** The name this target answers to in `publish.target` and `--target`. */
export const SPM_TARGET = 'spm';

/**
 * Publishes packages to the SyncBridge registry through the repository's own `spm`.
 *
 * **Question B, like every target**: is *this version* on the registry already? `spm view <name>
 * --json` answers it, as `npm view` does for the npm target - `up-to-date` when the version is
 * listed, `publish` when it is not, `error` when the lookup itself failed.
 */
/* **A failed lookup is an `'error'`, never "not published"** - the opposite of the npm and
 * cloudflare checks, on purpose. Their catch-everything shape is a measured cost on the npm side
 * (`npmViewPackage` read a failed lookup as "never published" and proposed a republish every run),
 * and `spm view` was asked for with a distinct failure exit exactly so this one need not guess.
 *
 * **The publish is `--skip-existing`**, which makes it exact even where the lookup cannot be: a
 * private package is invisible to an anonymous read, and spm answers 409 from the write path. A
 * version it skips comes back `up-to-date`, so `--json` does not call it published. */
export class SpmPublishService extends Service {
  /** What `spm publish` prints for a version the registry already has, under `--skip-existing`. */
  protected readonly skippedPattern: RegExp = /is already published to .*: skipped/;

  /** `spm publish --no-wait`'s exit code when the registry would ask for approval. */
  protected readonly approvalRequiredExit: number = 3;

  /**
   * What `publish --target spm` would do. Only packages naming `"spm"` in their own `publish.target`
   * are candidates; one with a dirty working tree is an `'error'` (or `'skip'` under
   * `ignoreDirty`), and the rest are asked of the registry.
   */
  async getPlan(
    options: SpmPublishService.Options = {},
    deps: SpmPublishService.Deps = {},
  ): Promise<SpmPublishService.Entry[]> {
    const repository = this.repository;
    const git = new GitHelper({ cwd: repository.dirname });
    const packages = filterPackages(repository.getPackages({ toposort: true }), options).filter(
      pkg => targetsOf(this.app, pkg).some(t => t.name === SPM_TARGET) && !pkg.config.publish?.skip,
    );
    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const publishedVersions = deps.publishedVersions ?? ((pkg: Package, registry?: string) => this.view(pkg, registry));

    return Promise.all(
      packages.map(async (pkg): Promise<SpmPublishService.Entry> => {
        const settings = this.settingsOf(pkg, options);
        const base = { package: pkg, version: pkg.version, settings, detail: settings.access };
        const dirty = filesOwnedBy(dirtyFiles, pkg);
        if (dirty.length) {
          return {
            ...base,
            status: options.ignoreDirty ? 'skip' : 'error',
            reason: dirtyReason(dirty, repository.dirname),
          };
        }
        try {
          const versions = await publishedVersions(pkg, settings.registry);
          return versions.includes(pkg.version)
            ? { ...base, status: 'up-to-date', reason: `the registry already has ${pkg.name}@${pkg.version}` }
            : { ...base, status: 'publish', reason: versions.length ? `not published yet` : 'never published' };
        } catch (e: any) {
          return { ...base, status: 'error', reason: e.message };
        }
      }),
    );
  }

  /**
   * Publishes every `'publish'` entry with `spm publish --skip-existing`, one package after another,
   * in the package's own directory. A failure is reported on its entry, and every later entry whose
   * consumers need the failed package - a dependency, or a peer not marked optional - is marked
   * `'error'` without being tried.
   */
  /* **A failure stops what a consumer's install needs it for**, as the npm target does: the plan is in
   * dependency order, so a module whose dependency or required peer failed would be refused by the
   * registry anyway - its range points at a version that is not there - and trying it only adds a
   * second error further from the cause. The same `consumerNeeds` rule, so an optional peer or a
   * devDependency does not block. */
  async applyPlan(plan: SpmPublishService.Entry[]): Promise<SpmPublishService.Entry[]> {
    const result: SpmPublishService.Entry[] = [];
    const failed = new Set<string>();
    for (const entry of plan) {
      if (entry.status !== 'publish') {
        result.push(entry);
        continue;
      }
      const pkg = entry.package;
      const blocker = pkg.dependencies.find(d => failed.has(d.name) && consumerNeeds(pkg, d.name));
      if (blocker) {
        failed.add(pkg.name);
        result.push({ ...entry, status: 'error', reason: `dependency "${blocker.name}" failed to publish` });
        continue;
      }
      try {
        const skipped = await this.publish(entry);
        result.push(
          skipped
            ? {
                ...entry,
                status: 'up-to-date',
                reason: `the registry already has ${entry.package.name}@${entry.version}`,
              }
            : entry,
        );
      } catch (e: any) {
        failed.add(pkg.name);
        result.push({ ...entry, status: 'error', reason: e.message });
      }
    }
    return result;
  }

  /** The access and registry `pkg` publishes with: the flag, else its `.rmanrc "publish.spm"`. */
  protected settingsOf(pkg: Package, options: SpmPublishService.Options): SpmPublishService.Settings {
    const config = pkg.config.publish?.spm as SpmPublishOptions | undefined;
    return {
      access: options.access ?? (config?.access as SpmPublishService.Settings['access']),
      registry: options.registry ?? (config?.registry as string | undefined),
    };
  }

  /** The versions of `pkg` the registry lists - `spm view <name> --json`. Throws when the lookup
   *  failed, with spm's own reason. */
  protected async view(pkg: Package, registry: string | undefined): Promise<string[]> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await this.spm(pkg, ['view', pkg.name, '--json', ...this.registryArgs(registry)], (line, stream) =>
        (stream === 'stdout' ? stdout : stderr).push(line),
      );
    } catch (e: any) {
      /** spm missing is its own sentence - "spm view failed" would hide how to fix it. */
      if (!stderr.length) throw e;
      throw new Error(`spm view ${pkg.name} failed${tail(stderr)}`, { cause: e });
    }
    let answer: { versions?: unknown };
    try {
      answer = JSON.parse(stdout.join('\n'));
    } catch {
      throw new Error(
        `spm view ${pkg.name} did not answer JSON - @syncbridge/syncbuild 2.2.0 or later has the command`,
      );
    }
    if (!Array.isArray(answer?.versions)) throw new Error(`spm view ${pkg.name} answered no "versions" list`);
    return answer.versions.filter((v): v is string => typeof v === 'string');
  }

  /** Runs the publish, its output shown on stderr as it comes. `true` when spm skipped the version
   *  because the registry has it. */
  protected async publish(entry: SpmPublishService.Entry): Promise<boolean> {
    const { access, registry } = entry.settings;
    const argv = [
      'publish',
      '--skip-existing',
      ...(this.unattended() ? ['--no-wait'] : []),
      ...(access ? ['--access', access] : []),
      ...this.registryArgs(registry),
    ];
    const lines: string[] = [];
    try {
      await this.spm(entry.package, argv, line => {
        lines.push(line);
        process.stderr.write(line + '\n');
      });
    } catch (e: any) {
      if (e?.code === this.approvalRequiredExit) {
        throw new Error(
          'the registry asks for approval in Console - publish from a terminal, or from GitHub Actions ' +
            'with "permissions: id-token: write"',
          { cause: e },
        );
      }
      throw new Error(`spm publish failed${tail(lines)}`, { cause: e });
    }
    return lines.some(l => this.skippedPattern.test(l));
  }

  /**
   * Whether nobody can approve a publish: not GitHub Actions (where spm publishes as the job, through
   * its OIDC token) and no terminal. spm is then told `--no-wait`, and refuses at once rather than
   * polling for an approval.
   */
  /* `publish --yes` means "no prompt", and spm outside CI polls for up to ten minutes for a Console
   * approval. `--no-wait` exists for this caller - asked of spm rather than decided here, so a
   * registry that asks no approval (SB_PUBLISH_APPROVAL off) still publishes. */
  protected unattended(): boolean {
    const ci = !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    return !ci && !process.stdin.isTTY;
  }

  protected registryArgs(registry: string | undefined): string[] {
    return registry ? ['--registry', registry] : [];
  }

  /** `spm` from the package's own or the repository's `node_modules`. */
  protected async spm(
    pkg: Package,
    argv: string[],
    onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<void> {
    try {
      await runBin('spm', argv, { cwd: pkg.dirname, app: this.app, logLevel: 'silent', onLine });
    } catch (e: any) {
      if (/was not found/.test(e?.message ?? '')) {
        throw new Error('"spm" is not installed in this repository - add @syncbridge/syncbuild as a devDependency', {
          cause: e,
        });
      }
      throw e;
    }
  }
}

export namespace SpmPublishService {
  /** Injectable registry lookup, so a spec needs neither network nor spm. */
  export interface Deps {
    publishedVersions?(pkg: Package, registry: string | undefined): Promise<string[]>;
  }

  export interface Options extends PackageFilterOptions {
    /** `--ignore-dirty`: a package with uncommitted changes is skipped rather than an error. */
    ignoreDirty?: boolean;
    /** `--spm-access`, over every package's `publish.spm.access`. */
    access?: 'public' | 'private';
    /** `--spm-registry`, over every package's `publish.spm.registry`. */
    registry?: string;
  }

  export interface Settings {
    access?: 'public' | 'private';
    registry?: string;
  }

  export interface Entry extends PublishTarget.Entry {
    /** What the plan decided to publish with, read back by `applyPlan` rather than recomputed. */
    settings: Settings;
  }
}

declare module '../../../core/classes/service.js' {
  interface ServiceMap {
    spmPublish: SpmPublishService;
  }
}

/** The lines of a failed spm run worth a reason - those saying "error", at most four; else the
 *  last two spm printed, which is where it says why (`... could not be reached: bad port`). */
function tail(lines: string[]): string {
  const said = lines.map(l => l.trim()).filter(Boolean);
  const errors = [...new Set(said.filter(l => /error|refused|denied|not signed/i.test(l)))].slice(0, 4);
  const picked = errors.length ? errors : said.slice(-2);
  return picked.length ? ':\n' + picked.map(l => `    ${l}`).join('\n') : '';
}
