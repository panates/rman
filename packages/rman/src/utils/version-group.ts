import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';

/**
 * The identity packages are batched by when `version` plans a release - `.rmanrc group`, cascaded
 * like every unmarked key. `true` (the default) puts a package in the implicit repo-wide group, a
 * non-empty string joins exactly the packages naming the same one, and `false` makes it a group of
 * itself.
 *
 * **It lives here rather than on the planner because two unrelated things need the same answer.**
 * `VersionPlanService.resolveGroupKey` batches the plan with it; `ChangeHashService.tagPattern`
 * asks how many lines the repository releases along, which decides whether a repo-wide tag can
 * name a release at all. Two copies of five lines would be easy to write and impossible to keep in
 * step, and the failure they would produce is silent - a boundary computed under one answer and a
 * tag written under the other.
 *
 * `resolveGroupKey` stays `protected` and delegates here, so a planner can still override the
 * batching; what it cannot do is leave the tag pattern behind, which is the point.
 */
export function groupKeyOf(pkg: Package): string {
  const g = pkg.config?.group;
  if (g === false) return `solo:${pkg.name}`;
  if (typeof g === 'string' && g) return `named:${g}`;
  return 'default';
}

/**
 * How many distinct version lines this package's repository releases along - 1 when every package
 * moves together, more once anything is grouped apart.
 *
 * **Structural, exactly like `usesCalendarVersion`'s group count**, and for the same reason: two
 * lines can hold the same number today and diverge tomorrow, so reading the versions would move
 * the answer under the repository's feet.
 *
 * `1` for a package belonging to no repository yet - a bare `new Package(dir, app)`, which the test
 * fixtures build. One line is the answer that changes nothing, which is what an unknown should
 * resolve to here.
 */
export function versionLineCount(pkg: Package): number {
  const repository = pkg.repository as Repository | undefined;
  const packages = repository?.packages;
  if (!packages?.length) return 1;
  return new Set(packages.map(groupKeyOf)).size;
}
