import type { Package } from '../core/classes/package.js';
import type { Repository } from '../core/classes/repository.js';

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
  if (typeof g === 'string' && g) return `named:${assertGroupName(g, pkg)}`;
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

/**
 * What a group may be called - a letter or digit, then letters, digits, `.`, `-` and `_`, up to
 * `GROUP_NAME_MAX`.
 *
 * **A group name is a file name now**, since `changelog.groupBy: 'group'` writes one
 * `CHANGELOG-<name>.md` per group, so it is no longer a key nothing outside rman ever sees. The
 * alternative was escaping it at the one place it is written, and that is the worse half of the
 * trade: an escape turns `core/api` into some `core-api.md` the repository never asked for and
 * cannot search for, and it would have to be repeated by every future reader of the name. A
 * refusal is one rule, stated once, before anything is written.
 *
 * Leading `.` and `-` are out for the two reasons a file name has: a dot-file is hidden, and a
 * leading dash reads as a flag to everything that takes a path on a command line.
 */
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * **15, and the limit is about the reader rather than any filesystem.** A group name is repeated in
 * every heading of the file it names and in the file name itself; a sentence-long one stops being a
 * label. Filesystems allow far more, which is exactly why a limit has to be a decision rather than
 * whatever the platform happens to permit.
 */
const GROUP_NAME_MAX = 15;

function assertGroupName(name: string, pkg: Package): string {
  if (name.length > GROUP_NAME_MAX)
    throw new Error(
      `Invalid group name "${name}" on package "${pkg.name}": at most ${GROUP_NAME_MAX} characters, ` +
        `and it is ${name.length}. A group name is written into a file name (CHANGELOG-${name}.md).`,
    );
  if (!GROUP_NAME.test(name))
    throw new Error(
      `Invalid group name "${name}" on package "${pkg.name}": start with a letter or digit, then ` +
        `letters, digits, ".", "-" or "_". A group name is written into a file name ` +
        `(CHANGELOG-<name>.md), so it has to be one.`,
    );
  return name;
}
