import type { Package } from '../core/classes/package.js';
import { Manifest } from '../core/interfaces/manifest.js';
import { skipReasonFor, targetsOf } from '../core/interfaces/publish-target.js';
import { filesUnder } from './git.js';

/**
 * Why `pkg` takes no version at all, or `undefined` when it does: `.rmanrc "version.skip"` when it
 * says so, and otherwise whether it has been kept out of publishing - `publish.skip`, or every
 * target that ships it leaving it out (npm's `private`).
 */
/* **A version nothing publishes is a number nobody can install**, and that is the user's reason
 * for reversing the old rule that `version` never reads `publish.skip`. Measured on
 * `panates/syncbridge`: fourteen packages kept out of publishing were still bumped, tagged and
 * written into changelogs on every release - tags with nothing on the registry behind them, and a
 * version line that had jumped by the time publishing was switched back on.
 *
 * `version.skip` decides first, both ways: `true` holds back a package that does publish, `false`
 * versions one that does not - an application deployed by other means, whose number still
 * matters. A monorepo's root never reaches here; its version is the repository's release
 * identity, decided by `buildRootEntry`.
 *
 * **A package no target ships to is still versioned**, deliberately. Tried the other way first,
 * and it stopped versioning every package of a repository that has no publish target at all - one
 * that versions with rman and publishes by other means, or a technology rman has no target for -
 * which is most of the core's own spec fixtures. Only a package kept out *on purpose* is left
 * out.
 *
 * **Here rather than on `VersionPlanService`**, which delegates to it, because `ChangelogService`
 * asks the same question through `bundledPackages` and must work in a repository with no planner -
 * the `groupKeyOf` arrangement. */
export function unversionedReason(pkg: Package): string | undefined {
  const declared = pkg.config.version?.skip;
  if (declared === true) return 'excluded via .rmanrc "version.skip"';
  if (declared === false) return undefined;
  if (pkg.config.publish?.skip) return 'not published - .rmanrc "publish.skip"';
  const app = pkg.repository?.app;
  if (!app) return undefined;
  const targets = targetsOf(app, pkg);
  if (!targets.length) return undefined;
  const reasons = targets.map(target => skipReasonFor(pkg, target));
  if (reasons.every(Boolean)) return `not published - ${reasons[0]}`;
  return undefined;
}

/**
 * The in-repo packages whose commits count as `pkg`'s own: those it needs at run time that take no
 * version themselves, and theirs in turn - a versioned one stops the walk, since it releases on its
 * own and reaches `pkg` through the ordinary cascade. Empty for a package that is itself not
 * versioned.
 *
 * `isUnversioned` is the planner's answer when one is asking; `unversionedReason` otherwise.
 */
/* **Asked for on `panates/syncbridge-cloud`**: the server ships as a Docker image built from four
 * workspace packages that are `publish.skip`, so take no version. A fix to one of them changed the
 * image and left the server `no-change` - the four were out of the plan before any commit was read,
 * and a commit counted only for the package whose directory held its files. A package kept out of
 * publishing that a published one needs at run time can reach anyone only inside that published
 * package's artifact, so a change to it *is* a change to the artifact.
 *
 * **Run-time edges only** (`Manifest.runtimeDependenciesOf`): a test helper kept out of publishing
 * that a library lists under `devDependencies` would otherwise release the library on every change
 * to it. */
export function bundledPackages(
  pkg: Package,
  isUnversioned: (p: Package) => boolean = p => !!unversionedReason(p),
): Package[] {
  const repository = pkg.repository;
  if (!repository || isUnversioned(pkg)) return [];
  const candidates = repository.packages;
  const result: Package[] = [];
  const visit = (from: Package) => {
    for (const dep of Manifest.runtimeDependenciesOf(from, candidates)) {
      if (dep === pkg || result.includes(dep) || !isUnversioned(dep)) continue;
      result.push(dep);
      visit(dep);
    }
  };
  visit(pkg);
  return result;
}

/**
 * The files of `files` that are `pkg`'s - under its own directory or under one of the packages it
 * carries (`bundledPackages`). What every "is this package dirty" check asks, so an artifact is
 * never built from a carried package's uncommitted changes.
 */
export function filesOwnedBy(files: readonly string[], pkg: Package): string[] {
  const dirs = [pkg, ...bundledPackages(pkg)].map(p => p.dirname);
  return [...new Set(dirs.flatMap(dir => filesUnder(files, dir)))];
}
