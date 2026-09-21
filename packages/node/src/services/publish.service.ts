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
import fs from 'node:fs';
import path from 'node:path';
import {
  exec,
  filterPackages,
  GitHelper,
  isCalendarVersion,
  type Package,
  type PackageFilterOptions,
  type Repository,
} from 'rman';
import { DEPENDENCY_KEYS } from '../augmentation/manifest.augmentation.js';
import { type NpmPackageView, npmViewPackage } from '../utils/npm-view.js';
import { parseWorkspaceRange, resolveWorkspaceRange } from '../utils/workspace-range.js';
import { CiService } from './ci.service.js';

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
    const deps = pkg.manifest.raw[depKey];
    return deps && Object.values(deps).some(v => parseWorkspaceRange(v));
  });
  if (!hasWorkspaceRange) return undefined;

  /** The file's exact bytes, not a re-serialization: this is restored verbatim afterwards, so a
   *  round-trip through `JSON.stringify` would rewrite the author's formatting as a side effect of
   *  publishing. */
  const original = fs.readFileSync(pkg.manifestFileName, 'utf-8');
  resolveWorkspaceRanges(pkg.manifest.raw, packagesByName);
  pkg.writeManifest();
  return () => {
    fs.writeFileSync(pkg.manifestFileName, original, 'utf-8');
    pkg.reloadManifest();
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
  const json: Record<string, any> = structuredClone(pkg.manifest.raw);
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
   *  real published package. */
  export interface Deps {
    npmViewPackage?: (name: string, cwd: string) => Promise<NpmPackageView | undefined>;
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
    /**
     * `npm publish --tag <tag>` - the dist-tag to publish under, overriding what the version
     * itself implies.
     *
     * **Usually unnecessary**: a prerelease is published under its own identifier (`2.0.0-beta.1`
     * -> `beta`) and a release under npm's `latest`, neither needing to be asked for. Pass this to
     * send a release somewhere other than `latest`, or a prerelease to a tag that is not its
     * identifier (`next` for every preview, say). See `distTagFor`.
     *
     * **A plan option rather than an apply-only one**, because the tag is decided in the plan: it
     * is printed beside each package and recorded as `Entry.distTag`, so `--dry-run` and the JSON
     * a release pipeline gates on both show where a version is going.
     */
    tag?: string;
  }

  export interface ApplyOptions extends Options {
    packageManager?: CiService.PackageManager;
    /** `npm publish --access <access>` - required by the registry for a *new* scoped package. */
    access?: 'public' | 'restricted';
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
    /** What the registry's **`latest` dist-tag** points at, if anything - only set once a registry
     *  check actually ran. Reported rather than compared: whether *this* version is published is a
     *  different question, and `getPlan` answers it from the published `versions`. */
    registryVersion?: string;
    /**
     * The dist-tag this entry will publish under - `--tag` when given, otherwise the version's own
     * prerelease identifier (`2.0.0-beta.1` -> `beta`), and `undefined` for an ordinary release,
     * which npm puts on `latest`.
     *
     * **Decided in the plan and read back by `applyPlan`, rather than recomputed there.** The plan
     * is what a reader confirms and what a pipeline gates on, so the tag has to be part of what it
     * says; recomputing at publish time would let the two disagree about where a package is going.
     */
    distTag?: string;
    /** `PublishTarget.Entry`'s own field - what the core's `publish` prints beside the package
     *  name. Carries the dist-tag, so where a version is going is visible in the plan and in
     *  `--dry-run --json` without the core knowing anything about npm. */
    detail?: string;
    reason?: string;
  }

  /**
   * Computes what `publish` *would* do, across every non-private package (topological order,
   * dependencies before dependents) - never touches the registry to publish anything, just
   * queries it to decide, so it's safe to call any time, including as the plan a bare `rman
   * publish` shows before asking for confirmation.
   *
   * A `private: true` package is always `'skip'`ped outright. Each remaining package's **dist-tag**
   * is settled next (`distTagFor`): usually derived from the version itself, `'error'` in the two
   * cases with nothing to derive - that one is about the invocation rather than the package, so it
   * is answered before anything touches the network. A package with uncommitted local changes is
   * `'error'` too (aborts the whole plan) unless `options.ignoreDirty` downgrades it to `'skip'`
   * instead - same rule `version` uses, since publishing untracked local edits is worse than a bad
   * commit.
   *
   * Otherwise the registry decides, via one `npmViewPackage` per remaining package (run
   * concurrently): **the local version being among the published `versions`** is `'up-to-date'`,
   * anything else - including never having been published at all - is `'publish'`. Deliberately not
   * a comparison against `latest`, which answers a different question and disagrees with this one
   * the moment a prerelease ships under its own dist-tag; see `npmViewPackage`.
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

    const viewPackage = deps.npmViewPackage ?? ((name: string, cwd: string) => npmViewPackage(name, cwd, options));

    const entries = new Map<string, Entry>();
    const toCheck: Package[] = [];
    for (const pkg of packages) {
      /** Asked before the registry is, because it is about the *invocation* rather than the
       *  package: a prerelease heading for `latest` is wrong whatever the registry says, and
       *  finding that out after a round trip per package would be a slower way to the same
       *  refusal. */
      const distTag = distTagFor(pkg, options.tag);
      if (retiredDirectoryKey(pkg)) {
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          status: 'error',
          reason: '.rmanrc "publish.directory" is now "publish.npm.directory" - see the npm publish target',
        });
      } else if (pkg.config.publish?.skip) {
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          status: 'skip',
          reason: 'excluded via .rmanrc "publish.skip"',
        });
      } else if (pkg.isPrivate) {
        entries.set(pkg.name, { package: pkg, version: pkg.version, status: 'skip', reason: 'private package' });
      } else if (distTag.error) {
        entries.set(pkg.name, { package: pkg, version: pkg.version, status: 'error', reason: distTag.error });
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
        const view = await viewPackage(pkg.name, pkg.dirname);
        const registryVersion = view?.latest;
        /** **This version**, not `latest` - the two part company the moment a prerelease is
         *  published under its own dist-tag, and `latest` then never moves however many betas go
         *  out. Asking it kept proposing an already-published version until npm answered 403. */
        const published = !!view?.versions.includes(pkg.version);
        const distTag = distTagFor(pkg, options.tag).tag;
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          registryVersion,
          distTag,
          /** Printed beside the package in the plan, so where a version is going is something the
           *  reader confirms rather than something they have to infer from the version string. */
          detail: distTag ? `-> dist-tag "${distTag}"` : undefined,
          status: published ? 'up-to-date' : 'publish',
          reason: published
            ? `registry already has ${pkg.version}`
            : registryVersion
              ? `registry has ${registryVersion}`
              : 'never published',
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
    /** The tuple is explicit: `[p.name, p]` widens to `(string | Package)[]`, and whether `new Map`
     *  still infers `Map<string, Package>` from that came down to which declaration of
     *  `getPackages()` was in scope - the source one inferred it, the built `.d.ts` did not
     *  (measured, once the tests started type-checking). */
    const packagesByName = new Map<string, Package>(repository.getPackages().map(p => [p.name, p] as const));

    for (const entry of plan) {
      if (entry.status !== 'publish') {
        result.push(entry);
        continue;
      }
      const pkg = entry.package;
      const blocker = pkg.dependencies.find(d => failed.has(d.name));
      if (blocker) {
        failed.add(pkg.name);
        result.push({ ...entry, status: 'error', reason: `dependency "${blocker.name}" failed to publish` });
        continue;
      }
      const publishDir = resolvePublishDir(pkg, options.contents);
      const restore = preparePublishManifest(pkg, publishDir, packagesByName);
      try {
        /** The plan's own tag, not a recomputed one: `getPlan` decided where this package goes,
         *  the reader confirmed that, and `applyPlan` is here to carry it out. `options.tag` is
         *  the fallback only for a plan built by something other than `getPlan`. */
        await exec(buildPublishCommand(packageManager, { ...options, tag: entry.distTag ?? options.tag }), {
          cwd: publishDir,
          app: pkg.repository.app,
          stdio: 'inherit',
        });
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

/** Where the publishable output lives, most specific statement first: the package's own
 *  `publishConfig.directory` (npm/pnpm's native spelling, and a statement about that one package),
 *  then `.rmanrc "publish.npm.directory"` (which a `"[*]"` block can say once for a whole repository
 *  instead of repeating in every `package.json`), then `--contents` for a single run. */
function resolvePublishDir(pkg: Package, contentsOverride: string | undefined): string {
  const native = pkg.manifest.raw.publishConfig?.directory;
  const configured = pkg.config?.publish?.npm?.directory;
  const rel = (typeof native === 'string' && native) || configured || contentsOverride;
  return rel ? path.resolve(pkg.dirname, rel) : pkg.dirname;
}

/**
 * The retired `publish.directory` spelling, if a config still carries it.
 *
 * **Caught and refused, never ignored**, and the reason is what ignoring it would do: the key would
 * silently stop being read, `resolvePublishDir` would fall back to the package's own directory, and
 * the run would publish the *source tree* to npm instead of the build output. A rename that fails
 * loudly costs one error message; one that goes quiet ships TypeScript sources to the registry.
 *
 * Checked in `getPlan` rather than at the write, for the same reason `version` validates its stamp
 * list first: a configuration mistake has to surface before anything is published, and an `'error'`
 * entry aborts the whole plan.
 *
 * YAML and JSON configs are unchecked at author time - there is no JSON Schema any more - so this is
 * the only thing standing between the old spelling and a wrong publish.
 */
function retiredDirectoryKey(pkg: Package): boolean {
  return (pkg.config?.publish as Record<string, unknown> | undefined)?.directory !== undefined;
}

/**
 * Which dist-tag a package publishes under, or why the plan must refuse to publish it at all.
 *
 * **A prerelease names its own tag, so rman uses it**: `2.0.0-beta.1` goes to `beta`. That is a
 * reading rather than a guess - the identifier is written in the version - and it is the whole
 * point, because `npm publish` with no `--tag` writes **`latest`**. A beta that lands there is what
 * every plain `npm install <name>` resolves to from then on; npm is content to point `latest` at a
 * prerelease, and `npm dist-tag` can move it back only after everyone who installed in between
 * already has the beta.
 *
 * **It is recorded in the plan rather than applied silently.** The derived tag becomes the entry's
 * `distTag` and is printed beside the package, so where a version is going is something the reader
 * confirms. Deriving it and saying nothing would be the same class of mistake in the other
 * direction - the wrong tag is recoverable (`npm dist-tag add`), but only by someone who noticed.
 *
 * Two cases still refuse, because there is no honest answer to derive:
 *
 * - **an explicit `--tag latest` on a prerelease.** Someone who typed it is far likelier to have
 *   confused themselves than to mean it, and the escape hatch for genuinely meaning it - a bare
 *   `npm publish --tag latest` - is one command away.
 * - **a prerelease with no identifier to name** (`2.0.0-1`, whose prerelease part is numeric).
 *   `VersionScheme.prereleaseId` answers `undefined` there rather than inventing a tag called `1`.
 *
 * **Both questions are the scheme's, not semver's** - `isPrerelease` and `prereleaseId` - and a
 * **calendar version has to be ruled out first**: `2026.9.15-1430` carries a semver prerelease
 * identifier by construction, because that is how the time is spelled, and it says nothing about
 * the release being a preview. `github-release`'s own `resolvePrerelease` makes the same pair of
 * checks; they agree deliberately.
 */
function distTagFor(pkg: Package, tag: string | undefined): { tag?: string; error?: string } {
  const isPreview = !isCalendarVersion(pkg.version) && pkg.versionScheme.isPrerelease(pkg.version);
  if (!isPreview) return { tag };
  if (tag) {
    if (tag !== 'latest') return { tag };
    return {
      error:
        `${pkg.version} is a prerelease, so --tag latest would make it what every plain ` +
        'install resolves to - drop the flag to publish it under its own identifier instead',
    };
  }
  const derived = pkg.versionScheme.prereleaseId(pkg.version);
  if (derived) return { tag: derived };
  return {
    error:
      `${pkg.version} is a prerelease with no identifier to name a dist-tag after, and with ` +
      'no --tag npm would put it on "latest" - pass --tag <name>',
  };
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
