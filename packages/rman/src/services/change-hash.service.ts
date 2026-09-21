import { Manifest } from '../core/manifest.js';
import type { Package } from '../core/package.js';
import type { GitHelper } from '../utils/git.js';

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

  /** `.rmanrc changelog.tagPattern` (cascaded, per-package overridable) - a glob for this package's
   *  release tags. `{name}` (if present) is replaced with the package's own name, e.g. `{name}@*`
   *  for independent per-package versioning (`@scope/pkg@1.2.3`, the same scheme lerna/changesets
   *  use - `@`/`/` are both fine in a git tag name). Without `{name}`, it's a single repo-wide tag
   *  shared by every package (e.g. the default `v*`). */
  export function tagPattern(pkg: Package): string {
    const cfg = pkg.config?.changelog;
    return typeof cfg?.tagPattern === 'string' && cfg.tagPattern ? cfg.tagPattern : DEFAULT_TAG_PATTERN;
  }

  /** This package's most recent release tag - the `{name}`-bearing pattern looks up that package's
   *  *own* tags directly (newest by version sort); a repo-wide pattern instead finds the nearest tag
   *  HEAD actually descends from, since no single package "owns" that tag. `undefined` if never
   *  tagged at all (a fresh package, or one that's never been released). Shared by `changelog`
   *  (reading the last-documented version) and `version` (finding the boundary a bump measures
   *  "since"). */
  export async function findLatestTag(git: GitHelper, pkg: Package): Promise<string | undefined> {
    const pattern = tagPattern(pkg);
    const expanded = pattern.replace('{name}', pkg.name);
    return pattern.includes('{name}') ? (await git.listTags(expanded))[0] : await git.describeTag(expanded);
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
   * release tag - the same network-free `findLatestTag` lookup `version`/`changed` themselves use,
   * so all three commands agree on "since when" for any repo whose tags are the ones `rman version`
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

const DEFAULT_TAG_PATTERN = 'v*';
