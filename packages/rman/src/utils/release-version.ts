import type { Package } from '../core/package.js';
import { ChangeHashService } from '../services/change-hash.service.js';
import type { GitHelper } from './git.js';

/**
 * A calendar release version: `YYYY.M.D-HHmm`, every part **unpadded** (`2026.9.5-930`, not
 * `2026.09.05-0930`). The padding isn't a style choice - semver forbids leading zeroes in numeric
 * identifiers, so a padded month or time makes the version invalid, and a monorepo root's
 * `package.json` has to hold a valid one. Unpadded still orders correctly: the date parts compare
 * numerically as major/minor/patch, and the time compares numerically as a prerelease identifier
 * (`930` < `1430`).
 */
export const CALENDAR_VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}-\d+$/;

/** `.rmanrc version.releaseTagPattern` (root-level) - the tag naming the repository's own release,
 *  as opposed to the per-package/group tags `changelog.tagPattern` names. Deliberately a **separate**
 *  pattern with a non-`v` default: `findLatestTag` resolves a repo-wide package pattern with `git
 *  describe --match`, so a release tag that also matched `v*` would be picked up as some package's
 *  own last release - corrupting both its changelog boundary and the version its entry is headed
 *  with. */
export function releaseTagPattern(root: Package): string {
  const cfg = root.config?.version?.releaseTagPattern;
  return typeof cfg === 'string' && cfg ? cfg : DEFAULT_RELEASE_TAG_PATTERN;
}

export function isCalendarVersion(version: string): boolean {
  return CALENDAR_VERSION_PATTERN.test(version);
}

/** `date` as a calendar release version - see `CALENDAR_VERSION_PATTERN` for why nothing is padded.
 *  The time becomes a single number (`14:30` -> `1430`, `09:30` -> `930`), which is both unpadded
 *  by construction and ordered the way the clock is. */
export function formatCalendarVersion(date: Date): string {
  const time = date.getHours() * 100 + date.getMinutes();
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}-${time}`;
}

/**
 * Whether this repository's releases are identified by a calendar version rather than a shared
 * semver one. Derived, never configured - a repo that picked "highest package version" would only
 * be picking a bug: with two version lines the highest can stay put while a lower one releases,
 * leaving the release with no identity of its own.
 *
 * `groupCount > 1` makes the first call: with several version lines there is no meaningful shared
 * number, so any semver-looking identity would claim something untrue. The other two make it
 * **sticky** - going back would *lower* the root version (`2026.9.15-1430` -> `1.4.0` compares as a
 * decrease), so once a calendar release exists the repo stays on calendar even if its groups later
 * collapse back to one. The last-release-tag check is the authoritative one (tags record what was
 * actually released); the root's own current version covers the case where tags aren't available
 * at all, e.g. a shallow clone.
 */
export function usesCalendarVersion(options: {
  groupCount: number;
  rootVersion: string;
  lastReleaseVersion?: string;
}): boolean {
  if (options.lastReleaseVersion && isCalendarVersion(options.lastReleaseVersion)) return true;
  if (isCalendarVersion(options.rootVersion)) return true;
  return options.groupCount > 1;
}

/** The tag naming a given repository release - `releaseTagPattern` run forward, the way
 *  `expandTag` runs `changelog.tagPattern` forward for a package. */
export function expandReleaseTag(root: Package, version: string): string {
  return ChangeHashService.applyTagPattern(releaseTagPattern(root), root.name, version);
}

/** The version of the repository's most recent release, from its release tags (highest by version
 *  sort) - `undefined` for a repo that has never cut one, or whose tags aren't available (a shallow
 *  clone). The authoritative half of `usesCalendarVersion`'s stickiness check: tags record what was
 *  actually released, unlike a `package.json` that can drift. */
export async function findLastReleaseVersion(git: GitHelper, root: Package): Promise<string | undefined> {
  const glob = releaseTagPattern(root).replace('{name}', root.name);
  const tag = (await git.listTags(glob))[0];
  return tag ? ChangeHashService.extractVersion(tag, glob) : undefined;
}

const DEFAULT_RELEASE_TAG_PATTERN = 'release-*';
