import fs from 'node:fs';
import path from 'node:path';
import type { Package } from '../../../core/classes/package.js';
import { Service } from '../../../core/classes/service.js';
import { type PublishTarget, targetsOf } from '../../../core/interfaces/publish-target.js';
import { GitHelper } from '../../../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../../../utils/package-filter.js';
import { runBin } from '../../../utils/run-bin.js';
import type { CloudflarePublishOptions } from './cloudflare.target.js';

/** The name this target answers to in `publish.target` and `--target`. */
export const CLOUDFLARE_TARGET = 'cloudflare';

/**
 * Deploys packages to Cloudflare Pages or Workers through `wrangler`, once per version.
 *
 * **Question B, like every target**: is *this version* already deployed? Each deploy is labelled
 * with the version - a Pages deployment's commit message is `<name>@<version>`, a Worker version's
 * tag is `v<version>` - and the plan reads those labels back, so a release run twice deploys once.
 */
/* **Pages is asked through Cloudflare's API, Workers through wrangler**, and the asymmetry is
 * wrangler's. `wrangler versions list --json` returns a version's annotations, `workers/tag`
 * among them; `wrangler pages deployment list --json` returns id, branch, a short commit hash, url
 * and status, and drops the commit message - measured in wrangler 4.81's own source. The API has
 * it (`deployment_trigger.metadata.commit_message`), with the same token wrangler uses. */
export class CloudflarePublishService extends Service {
  /** The wrangler configuration a Worker package is looked for in, in order. */
  protected readonly workerConfigFiles: readonly string[] = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

  /**
   * What `publish --target cloudflare` would do. Only packages naming `"cloudflare"` in their own
   * `publish.target` are candidates. A candidate whose config is incomplete, whose working tree is
   * dirty (unless `ignoreDirty`), or that runs without `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
   * is an `'error'`; otherwise it is `'up-to-date'` when its version is already deployed and
   * `'publish'` when it is not.
   */
  async getPlan(
    options: CloudflarePublishService.Options = {},
    deps: CloudflarePublishService.Deps = {},
  ): Promise<CloudflarePublishService.Entry[]> {
    const repository = this.repository;
    const git = new GitHelper({ cwd: repository.dirname });
    const packages = filterPackages(repository.getPackages({ toposort: true }), options).filter(
      pkg => targetsOf(this.app, pkg).some(t => t.name === CLOUDFLARE_TARGET) && !pkg.config.publish?.skip,
    );
    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const isDirty = (pkg: Package) => dirtyFiles.some(f => !path.relative(pkg.dirname, f).startsWith('..'));
    const credentials = this.credentials();
    const isDeployed = deps.isDeployed ?? ((deploy: CloudflarePublishService.Deploy) => this.isDeployed(deploy));

    return Promise.all(
      packages.map(async (pkg): Promise<CloudflarePublishService.Entry> => {
        const base = { package: pkg, version: pkg.version };
        let deploy: CloudflarePublishService.Deploy;
        try {
          deploy = this.resolveDeploy(pkg);
        } catch (e: any) {
          return { ...base, status: 'error', reason: e.message };
        }
        const located = { ...base, deploy, detail: deploy.label };
        if (isDirty(pkg)) {
          return { ...located, status: options.ignoreDirty ? 'skip' : 'error', reason: 'uncommitted local changes' };
        }
        if (!credentials) {
          return {
            ...located,
            status: 'error',
            reason: 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set to check and deploy',
          };
        }
        const deployed = await isDeployed(deploy);
        return deployed
          ? { ...located, status: 'up-to-date', reason: `${deploy.marker} is already deployed` }
          : { ...located, status: 'publish', reason: 'not deployed yet' };
      }),
    );
  }

  /**
   * Deploys every `'publish'` entry with `wrangler`, one package after another. A failure is that
   * package's alone and is reported on its entry.
   */
  async applyPlan(plan: CloudflarePublishService.Entry[]): Promise<CloudflarePublishService.Entry[]> {
    const result: CloudflarePublishService.Entry[] = [];
    for (const entry of plan) {
      if (entry.status !== 'publish' || !entry.deploy) {
        result.push(entry);
        continue;
      }
      try {
        await this.deploy(entry.deploy);
        result.push(entry);
      } catch (e: any) {
        result.push({ ...entry, status: 'error', reason: e.message });
      }
    }
    return result;
  }

  /** Where and how `pkg` deploys, from its `publish.cloudflare` - or a thrown reason it cannot. */
  protected resolveDeploy(pkg: Package): CloudflarePublishService.Deploy {
    const cf = pkg.config.publish?.cloudflare as CloudflarePublishOptions | undefined;
    if (!cf) throw new Error('"cloudflare" is a publish target but "publish.cloudflare" is not configured');
    const marker = `${pkg.name}@${pkg.version}`;
    if (cf.kind === 'pages') {
      /** Said rather than ignored: `wrangler pages deploy` has no `--env` or `--var`, and a setting
       *  that silently does nothing is the one a reader trusts. */
      for (const key of ['env', 'variables'] as const) {
        if (cf[key] !== undefined) {
          throw new Error(`"publish.cloudflare.${key}" is for kind "workers" - Pages takes settings through "files"`);
        }
      }
      const project = cf.project as string | undefined;
      if (!project) throw new Error('"publish.cloudflare.project" is required for kind "pages"');
      const branch = (cf.branch as string | undefined) || 'main';
      const directory = path.resolve(pkg.dirname, (cf.directory as string | undefined) || 'dist');
      return { kind: 'pages', pkg, marker, project, branch, directory, label: `pages ${project} (${branch})` };
    }
    if (cf.kind === 'workers') {
      const declared = cf.config as string | undefined;
      const config = declared
        ? path.resolve(pkg.dirname, declared)
        : this.workerConfigFiles.map(f => path.join(pkg.dirname, f)).find(f => fs.existsSync(f));
      if (!config || !fs.existsSync(config)) {
        throw new Error(
          declared
            ? `"publish.cloudflare.config" names ${declared}, which does not exist`
            : `kind "workers" needs a wrangler configuration - none of ${this.workerConfigFiles.join(', ')} is in the package`,
        );
      }
      const env = (cf.env as string | undefined) || undefined;
      return {
        kind: 'workers',
        pkg,
        marker,
        tag: `v${pkg.version}`,
        config,
        env,
        variables: (cf.variables as Record<string, string> | undefined) ?? {},
        label: `workers ${path.relative(pkg.dirname, config)}${env ? ` (${env})` : ''}`,
      };
    }
    throw new Error(`"publish.cloudflare.kind" must be "pages" or "workers", not ${JSON.stringify(cf.kind)}`);
  }

  /** The API token and account id wrangler reads, or `undefined` when either is missing. */
  protected credentials(): { token: string; accountId: string } | undefined {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    return token && accountId ? { token, accountId } : undefined;
  }

  /**
   * Whether this version is already deployed. A check that cannot be answered - the network, an
   * expired token - reads as "not deployed", the catch-everything shape every target's registry
   * check has: deploying a version again is harmless, failing the run over a question is not.
   */
  protected async isDeployed(deploy: CloudflarePublishService.Deploy): Promise<boolean> {
    try {
      if (deploy.kind === 'pages') return await this.pagesHas(deploy);
      return await this.workerHas(deploy);
    } catch {
      return false;
    }
  }

  /** A Pages deployment of the project whose commit message is this version's marker. */
  protected async pagesHas(deploy: CloudflarePublishService.PagesDeploy): Promise<boolean> {
    const { token, accountId } = this.credentials()!;
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/` +
      `${encodeURIComponent(deploy.project)}/deployments`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      result?: { deployment_trigger?: { metadata?: { commit_message?: string } } }[];
    };
    return (body.result ?? []).some(d => d.deployment_trigger?.metadata?.commit_message === deploy.marker);
  }

  /** A version of the Worker tagged with this version - among the ten most recent wrangler lists. */
  protected async workerHas(deploy: CloudflarePublishService.WorkersDeploy): Promise<boolean> {
    const lines: string[] = [];
    const argv = ['versions', 'list', '--json', '--config', deploy.config, ...this.envArgs(deploy)];
    await this.wrangler(deploy.pkg, argv, (line, stream) => {
      if (stream === 'stdout') lines.push(line);
    });
    const versions = JSON.parse(lines.join('\n')) as { annotations?: Record<string, string> }[];
    return versions.some(v => v.annotations?.['workers/tag'] === deploy.tag);
  }

  /** Runs the deploy, its output shown on stderr as it comes and kept for the reason if it fails. */
  protected async deploy(deploy: CloudflarePublishService.Deploy): Promise<void> {
    if (deploy.kind === 'pages' && !fs.existsSync(deploy.directory)) {
      throw new Error(
        `${path.relative(deploy.pkg.dirname, deploy.directory)} does not exist - build the package first`,
      );
    }
    const argv =
      deploy.kind === 'pages'
        ? [
            'pages',
            'deploy',
            deploy.directory,
            '--project-name',
            deploy.project,
            '--branch',
            deploy.branch,
            '--commit-message',
            deploy.marker,
            '--commit-dirty=true',
          ]
        : [
            'deploy',
            '--config',
            deploy.config,
            ...this.envArgs(deploy),
            ...Object.entries(deploy.variables).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
            '--tag',
            deploy.tag,
            '--message',
            deploy.marker,
          ];
    const lines: string[] = [];
    try {
      await this.wrangler(deploy.pkg, argv, line => {
        lines.push(line);
        process.stderr.write(line + '\n');
      });
    } catch (e: any) {
      const tail = lines.filter(l => /error|✘/i.test(l)).slice(-4);
      throw new Error(e.message + (tail.length ? ':\n' + tail.map(l => `    ${l.trim()}`).join('\n') : ''), {
        cause: e,
      });
    }
  }

  /** `--env <name>` when the Worker deploys to a named wrangler environment - for the deploy and for
   *  the versions list, which would otherwise ask about a different Worker. */
  protected envArgs(deploy: CloudflarePublishService.WorkersDeploy): string[] {
    return deploy.env ? ['--env', deploy.env] : [];
  }

  /**
   * `wrangler`, from the package's own or the repository's `node_modules` when it is installed there,
   * and through `npx` when it is not - so a package that never added it as a dependency still
   * deploys.
   */
  protected async wrangler(
    pkg: Package,
    argv: string[],
    onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<void> {
    const options = { cwd: pkg.dirname, app: this.app, logLevel: 'silent' as const, onLine };
    try {
      await runBin('wrangler', argv, options);
    } catch (e: any) {
      if (!/was not found/.test(e?.message ?? '')) throw e;
      await runBin('npx', ['--yes', 'wrangler', ...argv], options);
    }
  }
}

export namespace CloudflarePublishService {
  /** Injectable "is this version deployed" check, so a spec needs neither network nor wrangler. */
  export interface Deps {
    isDeployed?: (deploy: Deploy) => Promise<boolean>;
  }

  export interface Options extends PackageFilterOptions {
    /** A package with uncommitted local changes is excluded (`'skip'`) instead of aborting the
     *  plan (`'error'`) - the same option every target takes. */
    ignoreDirty?: boolean;
  }

  interface DeployBase {
    pkg: Package;
    /** `<name>@<version>` - the Pages commit message and the Worker version's message, and what
     *  the plan looks for on a Pages project. */
    marker: string;
    /** What the plan prints beside the package. */
    label: string;
  }

  export interface PagesDeploy extends DeployBase {
    kind: 'pages';
    project: string;
    branch: string;
    /** Absolute. */
    directory: string;
  }

  export interface WorkersDeploy extends DeployBase {
    kind: 'workers';
    /** `v<version>` - the Worker version's tag, which the plan looks for. */
    tag: string;
    /** Absolute path of the wrangler configuration. */
    config: string;
    /** The wrangler environment, when one is named. */
    env?: string;
    /** `--var` entries. */
    variables: Record<string, string>;
  }

  export type Deploy = PagesDeploy | WorkersDeploy;

  /** One package's outcome - a `PublishTarget.Entry` carrying where it deploys. */
  export interface Entry extends PublishTarget.Entry {
    /** Unset only on an `'error'` entry whose config could not be read. */
    deploy?: Deploy;
  }
}

declare module '../../../core/classes/service.js' {
  interface ServiceMap {
    cloudflarePublish: CloudflarePublishService;
  }
}
