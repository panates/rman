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
import type { Package } from '../../../../core/classes/package.js';
import type { Repository } from '../../../../core/classes/repository.js';
import { exec } from '../../../../utils/exec.js';
import { GitHelper } from '../../../../utils/git.js';
import type { PackageFilterOptions } from '../../../../utils/package-filter.js';
import { filterPackages } from '../../../../utils/package-filter.js';
import { isCalendarVersion } from '../../../../utils/release-version.js';
import { type NpmPackageView, npmViewPackage } from '../../../publish-targets/npm/npm-view.js';
import { DEPENDENCY_KEYS } from '../node-manifest.provider.js';
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
 * - `private` - **only when the package declares a `publishConfig`**. A package configured to be
 *   published that is also `private` is guarding its source tree against a stray `npm publish`,
 *   not refusing to ship; one with no `publishConfig` means it, and keeps the flag. `getPlan`
 *   decides from the manifest this produces, so the rule here *is* the publish rule - a preset
 *   writing the build directory's manifest must apply the same one.
 * - `publishConfig.directory` - it pointed *here*; kept, it would point one level deeper again.
 */
function derivePublishManifest(pkg: Package, packagesByName: Map<string, Package>): Record<string, any> {
  const json: Record<string, any> = structuredClone(pkg.manifest.raw);
  resolveWorkspaceRanges(json, packagesByName);

  delete json.devDependencies;
  if (json.publishConfig) delete json.private;

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
    /**
     * `npm stage publish` instead of `npm publish` - the version goes into npm's staging queue and
     * is not on the registry until a maintainer runs `npm stage approve`, which is where the 2FA
     * challenge moves to. `false` forces a direct publish even where the config asks for staging;
     * `undefined` leaves the decision to each package's `.rmanrc "publish.npm.staged"`.
     *
     * **A plan option, for the same reason `tag` is one**: what a run is about to do is the thing a
     * reader confirms and a pipeline gates on, and "this release will not be live when the workflow
     * goes green" is the most important sentence in the plan when it applies.
     */
    staged?: boolean;
    /** Subdirectory to publish from, relative to the package's own directory - only consulted when
     *  the package doesn't already declare its own `package.json` `publishConfig.directory` (npm's
     *  native mechanism for this, which always wins when present). A plan option, because the
     *  manifest in that directory is what the plan decides from. */
    contents?: string;
  }

  export interface ApplyOptions extends Options {
    packageManager?: CiService.PackageManager;
    /** `npm publish --access <access>` - required by the registry for a *new* scoped package. */
    access?: 'public' | 'restricted';
    /** `npm publish --otp <otp>` - a 2FA one-time password, for registries that require it. */
    otp?: string;
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
    /**
     * Whether this entry goes into npm's staging queue rather than straight to the registry -
     * `--staged`, or the package's own `.rmanrc "publish.npm.staged"`.
     *
     * Decided in the plan and read back by `applyPlan`, exactly as `distTag` is: a plan that said
     * "staged" while the command published directly would be the one disagreement that cannot be
     * undone, since a live version cannot be unpublished after 72 hours.
     *
     * **A staged entry still reads `publish`, not a status of its own**, and that is a limitation
     * rather than a decision: rman's question is "is this version on the registry", and a pending
     * version is not - `npm view` does not report the queue. So a second run proposes the same
     * package again, and whether npm accepts a duplicate stage is npm's answer to give, not rman's
     * to guess. Watch this if a run is ever repeated before an approval.
     */
    staged?: boolean;
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
   * **Whether a package is private is decided from the manifest that would be published.** From a
   * build directory that is the one `publish` derives (see `derivePublishManifest`): `private` there
   * only when the source has it and no `publishConfig`. In place it is the source's own. A build
   * directory that is missing or holds nothing but a `package.json` is an `'error'`: nothing has been
   * built to publish. Each remaining package's **dist-tag**
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
  /**
   * Why the npm target leaves `pkg` alone, from its manifest alone - `'private package'`, or
   * `undefined` when it would be published. `rman list` asks this to grey a package out.
   */
  /* **The one statement of npm's `private` rule**, called by `getPlan` and by `NpmPublishTarget.
   * skipReason` both, so the plan and the list cannot disagree. Two cases, both private:
   * - **no `publishConfig`** (`privateBySource`) - private in the published manifest too, wherever it
   *   is published from;
   * - **published in place** - the source manifest *is* the published one, so its `private` stands
   *   whatever else it declares.
   * The second sat after the build-output check in `getPlan` and moved ahead of it unchanged:
   * `hasBuildOutput` is always true in place, so nothing reached it any differently. */
  export function skipReason(pkg: Package, contentsOverride?: string): string | undefined {
    if (!pkg.manifest.raw.private) return undefined;
    if (privateBySource(pkg) || publishesInPlace(pkg, contentsOverride)) return 'private package';
    return undefined;
  }

  export async function getPlan(repository: Repository, options: Options = {}, deps: Deps = {}): Promise<Entry[]> {
    const git = new GitHelper({ cwd: repository.dirname });
    const packages = filterPackages(repository.getPackages({ toposort: true }), options);
    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const isDirty = (pkg: Package) => dirtyFiles.some(f => !path.relative(pkg.dirname, f).startsWith('..'));

    /** Per package, not per run: `resolveRegistry` reads the package's own `publishConfig.registry`
     *  when `--registry` was not given, so the question is asked where the answer lives. The test
     *  seam keeps its `(name, cwd)` shape - a stub answers from a map and has no registry to
     *  respect. */
    const viewPackage = (pkg: Package) =>
      deps.npmViewPackage
        ? deps.npmViewPackage(pkg.name, pkg.dirname)
        : npmViewPackage(pkg.name, pkg.dirname, { ...options, registry: resolveRegistry(pkg, options.registry) });

    const entries = new Map<string, Entry>();
    const toCheck: Package[] = [];
    for (const pkg of packages) {
      /** Asked before the registry is, because it is about the *invocation* rather than the
       *  package: a prerelease heading for `latest` is wrong whatever the registry says, and
       *  finding that out after a round trip per package would be a slower way to the same
       *  refusal. */
      const distTag = distTagFor(pkg, options.tag);
      const privateReason = skipReason(pkg, options.contents);
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
      } else if (privateReason) {
        entries.set(pkg.name, { package: pkg, version: pkg.version, status: 'skip', reason: privateReason });
      } else if (!hasBuildOutput(pkg, options.contents)) {
        const dir = path.relative(pkg.dirname, resolvePublishDir(pkg, options.contents)) || '.';
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          status: 'error',
          reason: `nothing to publish in "${dir}" - it is missing or empty; build the package first`,
        });
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
        const view = await viewPackage(pkg);
        const registryVersion = view?.latest;
        /** **This version**, not `latest` - the two part company the moment a prerelease is
         *  published under its own dist-tag, and `latest` then never moves however many betas go
         *  out. Asking it kept proposing an already-published version until npm answered 403. */
        const published = !!view?.versions.includes(pkg.version);
        const distTag = distTagFor(pkg, options.tag).tag;
        const staged = resolveStaged(pkg, options.staged);
        entries.set(pkg.name, {
          package: pkg,
          version: pkg.version,
          registryVersion,
          distTag,
          staged,
          /** Printed beside the package in the plan, so where a version is going is something the
           *  reader confirms rather than something they have to infer from the version string.
           *  Staging is named first because it changes what the run *does* - a reader who reads
           *  only the dist-tag would take a staged entry for one that goes live. */
          detail:
            [staged ? 'staged for approval' : undefined, distTag ? `-> dist-tag "${distTag}"` : undefined]
              .filter(Boolean)
              .join(', ') || undefined,
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
   * If a package fails, every other still-pending entry that **a consumer's install needs it for**
   * (transitively) is marked `'error'` too and never attempted - publishing a package whose own new
   * dependency range points at a version that never actually reached the registry would hand
   * consumers a broken install. A package's own failure doesn't stop unrelated packages elsewhere in
   * the plan, though, nor one that lists it only where an install does not need it (see
   * `consumerNeeds`).
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
      const blocker = pkg.dependencies.find(d => failed.has(d.name) && consumerNeeds(pkg, d.name));
      if (blocker) {
        failed.add(pkg.name);
        result.push({ ...entry, status: 'error', reason: `dependency "${blocker.name}" failed to publish` });
        continue;
      }
      const publishDir = resolvePublishDir(pkg, options.contents);
      const restore = preparePublishManifest(pkg, publishDir, packagesByName);
      try {
        /** The plan's own tag and staging decision, not recomputed ones: `getPlan` decided where
         *  this package goes, the reader confirmed that, and `applyPlan` is here to carry it out.
         *  `options.*` is the fallback only for a plan built by something other than `getPlan`. */
        await exec(
          buildPublishCommand(packageManager, {
            ...options,
            tag: entry.distTag ?? options.tag,
            staged: entry.staged ?? options.staged,
          }),
          {
            cwd: publishDir,
            app: pkg.repository.app,
            stdio: 'inherit',
          },
        );
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

/** `private` in the source with no `publishConfig` - private in every manifest derived from it too. */
/* **Decided from the manifest `npm publish` reads, which rman writes.** Publishing from a build
 * directory, that is `derivePublishManifest`'s output - written over whatever is there at publish time
 * - so `private` is the source's, kept only without a `publishConfig`. Reported from
 * `postgrejs-kysely`: its source carried `private: true` as a guard against a stray `npm publish`,
 * the plan answered `skip - private package`, and version, tag and GitHub release went through with
 * nothing on the registry.
 *
 * **2.11.1 read `build/package.json` instead, and that file is not what is published.** It is
 * whatever the build left there - the shared preset writes one, but only from the build `after` step
 * a package can replace, and `@opra/common`/`@opra/client` replace it with their own esbuild step. Both
 * had 625 and 52 built files and no `package.json`, the plan answered `error` for both, and opra's
 * release stopped after the version had been pushed.
 *
 * Asked before the build is looked for, so an unbuilt private package is skipped rather than
 * reported as unbuilt: opra's examples inherit `publish.npm.directory` and skip their build. */
function privateBySource(pkg: Package): boolean {
  return !!pkg.manifest.raw.private && !pkg.manifest.raw.publishConfig;
}

/** Whether a consumer installing `pkg` needs `name` to resolve: a `dependencies` entry, or a peer
 *  not marked optional. */
/* **Not every edge blocks a publish**, and blocking on all of them cost a release. A failed publish
 * stops its dependents because their published range would point at a version that is not there -
 * which is only true of what reaches the consumer:
 * - `devDependencies` are removed from the published manifest (`derivePublishManifest`);
 * - an optional peer that cannot be satisfied does not fail an install;
 * - `optionalDependencies` are the ones npm proceeds without "if it cannot be found or fails to
 *   install" (npm's own documentation; not measured here).
 * Measured on opra's 1.31.0 release: `@opra/api-ui` failed its first publish, and `@opra/http` -
 * which lists it as an optional peer and a devDependency only - was blocked, taking elastic, mongodb
 * and sqb with it, though none of their installs would have needed api-ui. */
function consumerNeeds(pkg: Package, name: string): boolean {
  const raw = pkg.manifest.raw;
  if (raw.dependencies?.[name] !== undefined) return true;
  return raw.peerDependencies?.[name] !== undefined && !raw.peerDependenciesMeta?.[name]?.optional;
}

/** Whether `pkg` is published from its own directory, whose `package.json` is then the manifest. */
/* In place, `private` is the source's whatever `publishConfig` says - npm refuses to publish it. */
function publishesInPlace(pkg: Package, contentsOverride: string | undefined): boolean {
  return path.resolve(resolvePublishDir(pkg, contentsOverride)) === path.resolve(pkg.dirname);
}

/** Whether the directory `pkg` is published from holds something to publish - anything besides a
 *  `package.json`, which `publish` writes itself. Always true in place. */
/* Without it `applyPlan` creates the directory, writes the derived manifest and publishes a tarball
 * holding nothing else. Not "has a package.json": that is the build's to write or not (see
 * `privateBySource`). */
function hasBuildOutput(pkg: Package, contentsOverride: string | undefined): boolean {
  if (publishesInPlace(pkg, contentsOverride)) return true;
  const dir = resolvePublishDir(pkg, contentsOverride);
  return fs.existsSync(dir) && fs.readdirSync(dir).some(name => name !== 'package.json');
}

/**
 * Which registry a package's own version is asked about, and published to.
 *
 * npm's own precedence, measured rather than assumed: `--registry` on the command line wins over
 * `package.json`'s `publishConfig.registry`, and with neither given npm resolves it itself from
 * `.npmrc` - including a scoped `@owner:registry=`, which is how a GitHub Packages repository is
 * normally set up.
 *
 * @returns the registry to pass, or `undefined` to let npm decide.
 */
/* **The check has to ask the registry the publish will use, and it did not.** `npm publish` honours
 * `publishConfig.registry` - it survives into the generated manifest, since `derivePublishManifest`
 * deletes only `publishConfig.directory` - but **`npm view` ignores it**: measured, a package whose
 * `publishConfig.registry` pointed at a dead local address was still answered from
 * registry.npmjs.org.
 *
 * So question B was asked of the wrong registry for exactly one of the three ways a registry can be
 * stated, and `npmViewPackage` swallows a failed lookup as `undefined`, which reads as "never
 * published". Two consequences, and the second is the one to fear:
 *
 * - the plan proposes a publish on **every** run, so the first succeeds and the second is rejected
 *   by the registry for republishing a version - a release job that fails for no reason of its own;
 * - if some *other* package holds that name on npmjs.org, rman reads a stranger's version list, and
 *   can report `up-to-date` for a publish that never happened.
 *
 * A scoped name in an `.npmrc` was always fine - measured, `npm view @foo/bar` with
 * `@foo:registry=http://127.0.0.1:1/` tries that address - which is why this went unnoticed.
 *
 * Returning `undefined` rather than a default is the half that keeps it working: passing an explicit
 * `--registry` would override whatever `.npmrc` says and break the case that already worked. */
function resolveRegistry(pkg: Package, override: string | undefined): string | undefined {
  const native = pkg.manifest.raw.publishConfig?.registry;
  return override || (typeof native === 'string' && native ? native : undefined);
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

/* **`stage publish`, not a `--staged` flag**, because that is npm's own spelling: `npm stage` is a
 * command with `publish`/`list`/`view`/`download`/`approve`/`reject` under it, and rman only ever
 * drives the first. The rest is a maintainer's, at a terminal with a 2FA prompt - which is the whole
 * point of staging, and the reason rman must not grow an `approve`.
 *
 * The publish flags are passed through unchanged. `--otp` is the one that reads oddly beside it,
 * since staging is what *defers* the 2FA challenge to approval time - it is passed anyway rather
 * than refused, because whether npm accepts it there is npm's to answer and a guess here would be a
 * rule rman invented. */
function buildPublishCommand(packageManager: CiService.PackageManager, options: PublishService.ApplyOptions): string {
  const args = options.staged ? ['stage', 'publish'] : ['publish'];
  if (options.access) args.push('--access', options.access);
  if (options.tag) args.push('--tag', options.tag);
  if (options.otp) args.push('--otp', options.otp);
  if (options.registry) args.push('--registry', options.registry);
  if (options.userconfig) args.push('--userconfig', options.userconfig);
  return `${packageManager} ${args.join(' ')}`;
}

/** Whether this package stages: `--staged`/`--no-staged` when given, else its own
 *  `.rmanrc "publish.npm.staged"`. */
/* Per package rather than per run, like `directory` beside it - a repository may well want its one
 * widely-depended-on package held for approval and the rest published directly, and the cascade
 * already makes "all of them" a single `"[*]"` line. */
function resolveStaged(pkg: Package, override: boolean | undefined): boolean {
  if (override !== undefined) return override;
  return !!pkg.config?.publish?.npm?.staged;
}
