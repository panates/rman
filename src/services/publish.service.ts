/**
 * Prepares the `package.json` that `npm publish` will actually read, and returns a function that
 * undoes it - always call that from a `finally`, so a failed publish leaves nothing behind.
 *
 * Which file that is depends on where the output lives:
 *
 * - **Publishing the package directory itself** - its own `package.json` is the manifest, rewritten
 *   in place: every `"workspace:"` range becomes a real, registry-consumable one (the same
 *   substitution pnpm/yarn's own publish performs - see `resolveWorkspaceRange`), since `npm
 *   publish` reads what is on disk rather than packing from a staging tarball.
 * - **Publishing a build directory** - there is no manifest there until something writes one, and
 *   that something is this: see `derivePublishManifest`.
 *
 * Returns `undefined` when there is nothing to do at all (the package directory, with no
 * `"workspace:"` range in it) - no disk write, nothing to restore.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { exec } from '../utils/exec.js';
import { GitHelper } from '../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { parseWorkspaceRange, resolveWorkspaceRange } from '../utils/workspace-range.js';
import { CiService } from './ci.service.js';
import { DEPENDENCY_KEYS } from './version.service.js';

function preparePublishManifest(
  pkg: Package,
  publishDir: string,
  packagesByName: Map<string, Package>,
): (() => void) | undefined {
  if (path.resolve(publishDir) !== path.resolve(pkg.dirname)) {
    const file = path.join(publishDir, 'package.json');
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined;
    fs.mkdirSync(publishDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(derivePublishManifest(pkg, packagesByName), undefined, 2) + '\n', 'utf-8');
    return () => {
      if (previous === undefined) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, previous, 'utf-8');
    };
  }

  const hasWorkspaceRange = DEPENDENCY_KEYS.some(depKey => {
    const deps = pkg.json[depKey];
    return deps && Object.values(deps).some(v => parseWorkspaceRange(v));
  });
  if (!hasWorkspaceRange) return undefined;

  const original = fs.readFileSync(pkg.jsonFileName, 'utf-8');
  resolveWorkspaceRanges(pkg.json, packagesByName);
  pkg.writeJson();
  return () => {
    fs.writeFileSync(pkg.jsonFileName, original, 'utf-8');
    pkg.reloadJson();
  };
}

/**
 * The manifest to publish from a build directory, derived from the package's own - generated here
 * rather than by a build script, and deliberately with nothing to configure.
 *
 * Generated at *publish* time, which is the whole point: a build script writes it when the build
 * runs, so bumping the version afterwards (or building before a bump) publishes a manifest that
 * disagrees with the package - and the `"workspace:"` rewrite above, which only ever touched the
 * package's own file, never reached the copy at all.
 *
 * What comes out is the package's `package.json` minus what a consumer of the tarball can neither
 * see nor use:
 *
 * - `devDependencies` - npm never installs a dependency's own, so they are pure noise.
 * - `scripts`, **except** `preinstall`/`install`/`postinstall`. Those three are the only ones a
 *   consumer's install actually runs, and dropping them would silently break every package that
 *   builds a native module on install. The rest (`build`, `test`, `prepare`, ...) never reach the
 *   consumer - `prepare` runs for a git dependency, which builds from the repository, not from this
 *   tarball.
 * - `private` - rman refuses to publish a private package in the first place, so carrying the flag
 *   into a manifest that is being published can only be wrong.
 * - `publishConfig.directory` - it pointed *here*; kept, it would point one level deeper again.
 */
function derivePublishManifest(pkg: Package, packagesByName: Map<string, Package>): Record<string, any> {
  const json: Record<string, any> = structuredClone(pkg.json);
  resolveWorkspaceRanges(json, packagesByName);

  delete json.devDependencies;
  delete json.private;

  if (json.scripts) {
    const kept = Object.fromEntries(Object.entries(json.scripts).filter(([name]) => CONSUMER_SCRIPTS.has(name)));
    if (Object.keys(kept).length) json.scripts = kept;
    else delete json.scripts;
  }

  if (json.publishConfig) {
    delete json.publishConfig.directory;
    if (!Object.keys(json.publishConfig).length) delete json.publishConfig;
  }

  return json;
}

/** The only lifecycle scripts a consumer's `npm install` of this package runs - see
 *  https://docs.npmjs.com/cli/using-npm/scripts. */
const CONSUMER_SCRIPTS = new Set(['preinstall', 'install', 'postinstall']);

/** Rewrites `json`'s `"workspace:"` ranges in place, resolving each against the in-repo package it
 *  names. Shared by both manifest paths, so they can never disagree about the substitution. */
function resolveWorkspaceRanges(json: Record<string, any>, packagesByName: Map<string, Package>): void {
  for (const depKey of DEPENDENCY_KEYS) {
    const deps = json[depKey];
    if (!deps) continue;
    for (const depName of Object.keys(deps)) {
      const parsed = parseWorkspaceRange(deps[depName]);
      if (!parsed) continue;
      const depPkg = packagesByName.get(depName);
      if (depPkg) deps[depName] = resolveWorkspaceRange(parsed, depPkg.version);
    }
  }
}

export namespace PublishService {
  /** Injectable registry lookup - mainly for tests, so they don't depend on network access or a
   *  real published package. Same shape as `detectChangeHash`'s own `npmViewVersion`. */
  export interface Deps {
    npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>;
  }

  export interface Options extends PackageFilterOptions {
    /** A package with uncommitted local changes is excluded (status `'skip'`) instead of aborting
     *  the whole plan (status `'error'`) - same as `version`'s own option. Default false. */
    ignoreDirty?: boolean;
    /** Registry to check against (and, in `applyPlan`, publish to) - `.npmrc`'s own configured
     *  registry is used when omitted. */
    registry?: string;
    /** Path to a custom `.npmrc`, for both the registry check and the actual publish. */
    userconfig?: string;
  }

  export interface ApplyOptions extends Options {
    packageManager?: CiService.PackageManager;
    /** `npm publish --access <access>` - required by the registry for a *new* scoped package. */
    access?: 'public' | 'restricted';
    /** `npm publish --tag <tag>` - the dist-tag this version is published under (default `latest`). */
    tag?: string;
    /** `npm publish --otp <otp>` - a 2FA one-time password, for registries that require it. */
    otp?: string;
    /** Subdirectory to publish from, relative to the package's own directory - only consulted when
     *  the package doesn't already declare its own `package.json` `publishConfig.directory` (npm's
     *  native mechanism for this, which always wins when present). */
    contents?: string;
  }

  /** One package's outcome in a publish plan - see `getPlan`. */
  export interface Entry {
    package: Package;
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    /** What's currently on the registry, if anything - only set once a registry check actually ran. */
    registryVersion?: string;
    reason?: string;
  }

  /**
   * Computes what `publish` *would* do, across every non-private package (topological order,
   * dependencies before dependents) - never touches the registry to publish anything, just
   * queries it to decide, so it's safe to call any time, including as the plan a bare `rman
   * publish` shows before asking for confirmation.
   *
   * A `private: true` package is always `'skip'`ped outright. A package with uncommitted local
   * changes is `'error'` (aborts the whole plan) unless `options.ignoreDirty` downgrades it to
   * `'skip'` instead - same rule `version` uses, since publishing untracked local edits is worse
   * than a bad commit. Otherwise, its currently-published registry version (via `npm view`,
   * queried concurrently across every remaining package) decides the rest: identical to the local
   * `package.json` version is `'up-to-date'`; anything else (including never having been
   * published at all) is `'publish'`.
   *
   * Deliberately decoupled from `version`: this only ever looks at what's *currently* on disk and
   * on the registry, never at whether `version` was just run - so it works equally well right
   * after a version bump, or standing alone in a release pipeline that bumped days earlier.
   *
   * A monorepo's root package is never a candidate at all - `repository.getPackages()` already
   * excludes it for a real monorepo (it only doubles as "the" package in a single-package repo,
   * where it's a normal candidate like any other).
   */
  export async function getPlan(repository: Repository, options: Options = {}, deps: Deps = {}): Promise<Entry[]> {
    const git = new GitHelper({ cwd: repository.dirname });
    const packages = filterPackages(repository.getPackages({ toposort: true }), options);
    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const isDirty = (pkg: Package) => dirtyFiles.some(f => !path.relative(pkg.dirname, f).startsWith('..'));

    const npmViewVersion = deps.npmViewVersion ?? ((name, cwd) => defaultNpmViewVersion(name, cwd, options));

    const entries = new Map<string, Entry>();
    const toCheck: Package[] = [];
    for (const pkg of packages) {
      if (pkg.config.publish?.skip) {
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          status: 'skip',
          reason: 'excluded via .rmanrc "publish.skip"',
        });
      } else if (pkg.isPrivate) {
        entries.set(pkg.name, { package: pkg, version: pkg.version, status: 'skip', reason: 'private package' });
      } else if (isDirty(pkg)) {
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          status: options.ignoreDirty ? 'skip' : 'error',
          reason: 'uncommitted local changes',
        });
      } else {
        toCheck.push(pkg);
      }
    }

    await Promise.all(
      toCheck.map(async pkg => {
        const registryVersion = await npmViewVersion(pkg.name, pkg.dirname);
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          registryVersion,
          status: registryVersion === pkg.version ? 'up-to-date' : 'publish',
          reason: registryVersion ? `registry has ${registryVersion}` : 'never published',
        });
      }),
    );

    return packages.map(pkg => entries.get(pkg.name)!);
  }

  /**
   * Publishes every `'publish'` entry in `plan`, topological order (already `plan`'s own order -
   * see `getPlan`), via the configured `packageManager`'s own `publish` command. Sequential, not
   * concurrent: unlike `run`/`build`, a package genuinely needs its own dependencies to have
   * landed on the registry first, and publishing is rare enough (once per release) that the
   * simplicity is worth more than the parallelism `run` gets from `power-tasks`.
   *
   * If a package fails, every other still-pending entry depending on it (transitively) is marked
   * `'error'` too and never attempted - publishing a package whose own new dependency range points
   * at a version that never actually reached the registry would hand consumers a broken install.
   * A package's own failure doesn't stop unrelated packages elsewhere in the plan, though.
   */
  export async function applyPlan(repository: Repository, plan: Entry[], options: ApplyOptions = {}): Promise<Entry[]> {
    const packageManager = CiService.resolvePackageManager(repository, options.packageManager);
    const failed = new Set<string>();
    const result: Entry[] = [];
    const packagesByName = new Map(repository.getPackages().map(p => [p.name, p]));

    for (const entry of plan) {
      if (entry.status !== 'publish') {
        result.push(entry);
        continue;
      }
      const pkg = entry.package;
      const blocker = pkg.dependencies.find(d => failed.has(d));
      if (blocker) {
        failed.add(pkg.name);
        result.push({ ...entry, status: 'error', reason: `dependency "${blocker}" failed to publish` });
        continue;
      }
      const publishDir = resolvePublishDir(pkg, options.contents);
      const restore = preparePublishManifest(pkg, publishDir, packagesByName);
      try {
        await exec(buildPublishCommand(packageManager, options), { cwd: publishDir, stdio: 'inherit' });
        result.push(entry);
      } catch (e: any) {
        failed.add(pkg.name);
        result.push({ ...entry, status: 'error', reason: e.message });
      } finally {
        restore?.();
      }
    }
    return result;
  }
}

const execFileAsync = promisify(execFile);

/** `npm view <name> version`, optionally against a custom registry/`.npmrc` - `undefined` for any
 *  failure (never published, no network, private/restricted with no access, ...), same
 *  catch-everything shape as `change-hash.ts`'s own `defaultNpmViewVersion` (kept separate here
 *  since this one also needs `--registry`/`--userconfig`, which that one has no use for). */
async function defaultNpmViewVersion(
  name: string,
  cwd: string,
  options: { registry?: string; userconfig?: string },
): Promise<string | undefined> {
  const argv = ['view', name, 'version'];
  if (options.registry) argv.push('--registry', options.registry);
  if (options.userconfig) argv.push('--userconfig', options.userconfig);
  try {
    const { stdout } = await execFileAsync('npm', argv, { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Where the publishable output lives, most specific statement first: the package's own
 *  `publishConfig.directory` (npm/pnpm's native spelling, and a statement about that one package),
 *  then `.rmanrc "publish.directory"` (which a `"[*]"` block can say once for a whole repository
 *  instead of repeating in every `package.json`), then `--contents` for a single run. */
function resolvePublishDir(pkg: Package, contentsOverride: string | undefined): string {
  const native = pkg.json.publishConfig?.directory;
  const configured = pkg.config?.publish?.directory;
  const rel = (typeof native === 'string' && native) || configured || contentsOverride;
  return rel ? path.resolve(pkg.dirname, rel) : pkg.dirname;
}

function buildPublishCommand(packageManager: CiService.PackageManager, options: PublishService.ApplyOptions): string {
  const args = ['publish'];
  if (options.access) args.push('--access', options.access);
  if (options.tag) args.push('--tag', options.tag);
  if (options.otp) args.push('--otp', options.otp);
  if (options.registry) args.push('--registry', options.registry);
  if (options.userconfig) args.push('--userconfig', options.userconfig);
  return `${packageManager} ${args.join(' ')}`;
}
