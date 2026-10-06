import type { Package } from '../core/classes/package.js';
import { Manifest } from '../core/interfaces/manifest.js';
import type { GitHelper } from '../utils/git.js';
import { versionLineCount } from '../utils/version-group.js';

/**
 * Release boundaries and the tag names that mark them - **the single source for both directions**.
 *
 * Every command that asks question A ("what changed since this package's last release") comes
 * through `detect`, and every command that needs to *name* a tag comes through `expandTag` /
 * `findLatestTag`. No command builds a tag name of its own; that is what keeps `version`'s tag,
 * `changelog`'s boundary and `github-release`'s lookup from drifting apart.
 *
 * A namespace for the reason `Manifest` and `Workspace` are ones: it is one subject with several
 * operations, so the operations are named for what they do rather than carrying the subject in each
 * name (`ChangeHashService.detect`, not `detectChangeHash`), and a plugin can augment it.
 */
export namespace ChangeHashService {
  /** The one keyword `from` accepts instead of a ref: "work it out per package". Omitting `from`
   *  means the same thing - this exists so a pipeline can say it explicitly. */
  export const AUTO = 'auto';

  export interface DetectOptions {
    /**
     * Use this commit/hash directly instead of auto-detecting - applies the same way to every
     * package. `AUTO` (or omitting `from` entirely) asks for auto-detection instead of being
     * treated as a literal ref.
     *
     * The keyword used to be `"npm"`, which named a *source* - and the wrong one: auto-detection is
     * mostly git, and the registry it may consult is now the ecosystem's business (see
     * `Plugin.publishedVersion`). What is being chosen here is a *mode*, so it is spelled
     * as one. **A rename, not an alias**: `--from npm` now means a ref literally called `npm`,
     * which is what it should have meant all along.
     */
    from?: string;
    /** An existing record of what's already been documented (typically a changelog file) - only
     *  consulted while auto-detecting (ignored when `from` is an explicit hash). Guards against a
     *  gap: if this file's own last-modifying commit is *older* than the tag detected from the
     *  registry - e.g. the file was last updated for 1.1.0, but 1.2.0-1.5.0 were released without
     *  ever documenting them, and the registry now reports 1.5.0 - starting from the tag alone would
     *  silently skip everything the file never recorded. The boundary becomes the merge-base of the
     *  two, so the result always covers at least as much as the file is missing. Has no effect when
     *  the file doesn't exist. */
    catchUpFile?: string;
  }

  /**
   * `.rmanrc changelog.tagPattern` (cascaded, per-package overridable) - a glob for this package's
   * release tags. `{name}` (if present) is replaced with the package's own name, e.g. `{name}@*`
   * for independent per-package versioning (`@scope/pkg@1.2.3`, the same scheme lerna/changesets
   * use - `@`/`/` are both fine in a git tag name). Without `{name}`, it's a single repo-wide tag
   * shared by every package (`v*`).
   *
   * **Undeclared, the default is derived from how many version lines the repository has**, not
   * fixed at `v*`. A repo-wide pattern has no `{name}`, so `findLatestTag` resolves it with `git
   * describe --match` - the nearest tag HEAD descends from, whichever package it belongs to. That
   * is exactly right while every package shares one line and **silently wrong** the moment they do
   * not: measured on a two-line repository, releasing `pkg-a` put `v1.1.0` on HEAD, and `pkg-b` -
   * which had a committed, unreleased `fix:` of its own sitting behind that tag - reported
   * `no-change` and shipped nothing. Under `{name}@*` the same repository answers `bump 1.0.0 ->
   * 1.0.1, changed since pkg-b@1.0.0`.
   *
   * So the choice is not a preference and should never have been one to remember: a repo-wide tag
   * can only name a release that the whole repository shares. rman already decides the root's
   * versioning scheme structurally from the same group count (`usesCalendarVersion`) - this is that
   * rule applied to the other half of a release.
   *
   * **The root keeps `v*`.** It is never a member of any group, so the count says nothing about
   * it, and the one caller that asks (`github-release`'s `releaseTagGlob`) only does so when the
   * root is *not* on a calendar version - which is the single-line case, where `v*` is the answer
   * anyway. With several lines the repository's release carries its own `version.releaseTagPattern`
   * instead.
   */
  export function tagPattern(pkg: Package): string {
    return resolvePattern(pkg).pattern;
  }

  /** This package's most recent release tag - the `{name}`-bearing pattern looks up that package's
   *  *own* tags directly (newest by version sort); a repo-wide pattern instead finds the nearest tag
   *  HEAD actually descends from, since no single package "owns" that tag. `undefined` if never
   *  tagged at all (a fresh package, or one that's never been released). Shared by `changelog`
   *  (reading the last-documented version) and `version` (finding the boundary a bump measures
   *  "since"). */
  /**
   * **Every pattern that may name this package's releases**, in precedence order - its own, and,
   * only where the pattern was derived, the shared `v*` a repository used before it grew a second
   * version line. One list, because two questions need it and must not disagree: `findLatestTag`
   * picks the boundary off it, and `changelog`'s `splitByRelease` cuts the range at the tags it
   * matches.
   *
   * They *did* disagree, for one commit: the boundary fell back to the shared tag while the split
   * still looked only for `{name}@*`, which a repository mid-transition has none of - so a backfill
   * reaching across twelve releases found no tag to cut at and rendered all of them as one.
   */
  export function releaseTagPatterns(pkg: Package): string[] {
    const { pattern, derived } = resolvePattern(pkg);
    const expanded = pattern.replace('{name}', pkg.name);
    return derived && expanded !== SHARED_TAG_PATTERN ? [expanded, SHARED_TAG_PATTERN] : [expanded];
  }

  export async function findLatestTag(git: GitHelper, pkg: Package): Promise<string | undefined> {
    const { pattern, derived } = resolvePattern(pkg);
    const expanded = pattern.replace('{name}', pkg.name);
    if (!pattern.includes('{name}')) return git.describeTag(expanded);

    const own = (await git.listTags(expanded))[0];
    if (own || !derived) return own;
    /**
     * **The bridge across the default changing.** A repository that released under `v*` and has
     * since grown a second version line has no `{name}` tag for this package yet - and reading the
     * whole history instead would re-propose everything ever committed. Measured on a real
     * four-package repository: every package came back on `unreleased commits` and three of them
     * jumped a major, because some commit in the full history said `feat!:`.
     *
     * Falling back to the repo-wide tag gives exactly the boundary that *was* correct - before the
     * split, every package genuinely shared it - so the first run after the split reads the same
     * commits it would have read yesterday, and writes a `{name}` tag that every run after it
     * finds directly. One transition, no manual tagging, no invented release.
     *
     * **Only when the pattern was derived.** A repository that asked for `{name}@*` in its own
     * `.rmanrc` has said what names its tags; borrowing a `v*` tag it never asked about could hand
     * a package a boundary belonging to something else entirely, and reading too little is the
     * failure that ships nothing and says nothing.
     */
    return git.describeTag(SHARED_TAG_PATTERN);
  }

  /** The forward direction of `findLatestTag`: expands `pkg`'s (cascaded) `.rmanrc
   *  changelog.tagPattern` into the concrete tag name `version` belongs under - `{name}` becomes the
   *  package's own name, `*` becomes `version`. Shared by `version` (creating the tag),
   *  `github-release` (finding the release that tag belongs to), and `detect`'s own registry
   *  fallback (mapping a published version back onto a tag), so all three name tags identically. */
  export function expandTag(pkg: Package, version: string): string {
    return applyTagPattern(tagPattern(pkg), pkg.name, version);
  }

  /** The pattern expansion `expandTag` performs, on any pattern - `{name}` becomes `name`, `*`
   *  becomes `version`. Shared with the repository's own release tag, which uses a different pattern
   *  (see `releaseTagPattern`) but names tags the same way. */
  export function applyTagPattern(pattern: string, name: string, version: string): string {
    const expanded = pattern.replace('{name}', name);
    const starIdx = expanded.indexOf('*');
    return starIdx === -1 ? expanded : expanded.slice(0, starIdx) + version + expanded.slice(starIdx + 1);
  }

  /** Strips the pattern's literal prefix (everything before its first `*`) from `tag` to get just
   *  the version part - e.g. tag `@sqb/builder@1.2.3` against pattern `@sqb/builder@*` -> `1.2.3`.
   *  A pattern with no `*` is returned as its own "version" verbatim (an exact tag, nothing to
   *  strip). */
  export function extractVersion(tag: string, expandedPattern: string): string {
    const starIdx = expandedPattern.indexOf('*');
    if (starIdx === -1) return tag;
    const prefix = expandedPattern.slice(0, starIdx);
    return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  }

  /**
   * Resolves the commit/hash a package's changes should be measured "since" - the boundary
   * `changelog --from` uses, but reusable anywhere a command wants to answer "what changed for this
   * package". An explicit `options.from` (anything but `AUTO`) is returned as-is, applying the same
   * way to every package. Otherwise, it's auto-detected in order: (1) this package's own most recent
   * release tag - the same network-free `findLatestTag` lookup `version` itself uses,
   * so both commands agree on "since when" for any repo whose tags are the ones `rman version`
   * actually created; (2) failing that (no tag at all yet - e.g. onboarding `rman` onto a repo with
   * real release history but no `rman`-created tags), whatever this package's **own ecosystem**
   * reports as its published version (`Plugin.publishedVersion`), mapped to a git tag via
   * `.rmanrc changelog.tagPattern` and used only if that tag actually exists. Either way, if
   * `catchUpFile` is given and exists, the result is widened to also cover anything that file
   * hasn't caught up on yet (see its doc comment). Returns `undefined` when nothing can be resolved
   * at all (never tagged *and* never published, no catch-up file - a genuinely first-ever release) -
   * callers should fall back to their own default in that case (e.g. the whole history, since
   * nothing has ever been released).
   */
  export async function detect(git: GitHelper, pkg: Package, options: DetectOptions = {}): Promise<string | undefined> {
    if (options.from && options.from !== AUTO) return options.from;

    let tagHash = await findLatestTag(git, pkg);
    if (!tagHash) {
      /** Through the package's own ecosystem, not through npm: which registry (if any) knows about
       *  this package is the `Plugin`'s manifest members's answer, and in a polyglot repository it differs
       *  per package. A repository naming no plugin gets `undefined` here and git tags decide
       *  alone. */
      const publishedVersion = await Manifest.publishedVersion(pkg);
      if (publishedVersion) {
        const tag = expandTag(pkg, publishedVersion);
        tagHash = (await git.tagExists(tag)) ? tag : undefined;
      }
    }

    const fileHash = options.catchUpFile ? await git.lastCommitTouching(options.catchUpFile) : undefined;
    if (!fileHash) return tagHash;
    if (!tagHash) return fileHash;
    return (await git.mergeBase(tagHash, fileHash)) ?? tagHash;
  }
}

/** One tag for the whole repository - right while every package releases on one line. */
const SHARED_TAG_PATTERN = 'v*';

/** One tag per package - the scheme lerna and changesets use, and the only one that can name a
 *  release when a repository has more than one version line. */
const PER_PACKAGE_TAG_PATTERN = '{name}@*';

/**
 * The pattern plus **where it came from**, which `findLatestTag` needs and callers do not: the
 * bridge to a repo-wide tag applies only where rman changed the answer itself, never over a
 * repository's own declaration.
 */
function resolvePattern(pkg: Package): { pattern: string; derived: boolean } {
  const configured = pkg.config?.changelog?.tagPattern;
  if (typeof configured === 'string' && configured) return { pattern: configured, derived: false };
  if (pkg.isRoot) return { pattern: SHARED_TAG_PATTERN, derived: true };
  const several = versionLineCount(pkg) > 1;
  return { pattern: several ? PER_PACKAGE_TAG_PATTERN : SHARED_TAG_PATTERN, derived: true };
}
