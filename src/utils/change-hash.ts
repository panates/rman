import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Package } from '../core/package.js';
import type { GitHelper } from './git.js';

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
 *  package's own name, `*` becomes `version`. Shared by `version` (creating the tag), `publish
 *  --target github` (finding the release that tag belongs to), and `detectChangeHash`'s own npm
 *  fallback (mapping a published version back onto a tag), so all three name tags identically. */
export function expandTag(pkg: Package, version: string): string {
  return applyTagPattern(tagPattern(pkg), pkg.name, version);
}

/** The pattern expansion `expandTag` performs, on any pattern - `{name}` becomes `name`, `*` becomes
 *  `version`. Shared with the repository's own release tag, which uses a different pattern (see
 *  `releaseTagPattern`) but names tags the same way. */
export function applyTagPattern(pattern: string, name: string, version: string): string {
  const expanded = pattern.replace('{name}', name);
  const starIdx = expanded.indexOf('*');
  return starIdx === -1 ? expanded : expanded.slice(0, starIdx) + version + expanded.slice(starIdx + 1);
}

/** Strips the pattern's literal prefix (everything before its first `*`) from `tag` to get just
 *  the version part - e.g. tag `@sqb/builder@1.2.3` against pattern `@sqb/builder@*` -> `1.2.3`.
 *  A pattern with no `*` is returned as its own "version" verbatim (an exact tag, nothing to strip). */
export function extractVersion(tag: string, expandedPattern: string): string {
  const starIdx = expandedPattern.indexOf('*');
  if (starIdx === -1) return tag;
  const prefix = expandedPattern.slice(0, starIdx);
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
}

/** Looks up `name`'s currently-published version on the npm registry, or `undefined` if it isn't
 *  published there at all (private, scoped-but-unpublished, no network, ...) - the real npm CLI
 *  call `detectChangeHash` uses by default; injectable via its `npmViewVersion` option so tests
 *  aren't making real registry calls. */
export async function defaultNpmViewVersion(name: string, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', name, 'version'], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface DetectChangeHashOptions {
  /** Use this commit/hash directly instead of auto-detecting - applies the same way to every
   *  package. `"npm"` (or omitting `from` entirely) triggers auto-detection instead of being
   *  treated as a literal ref. */
  from?: string;
  /** Overrides the real npm registry lookup made when auto-detecting - mainly for tests, so they
   *  don't depend on network access or a real published package. */
  npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>;
  /** An existing record of what's already been documented (typically a changelog file) - only
   *  consulted while auto-detecting (ignored when `from` is an explicit hash). Guards against a
   *  gap: if this file's own last-modifying commit is *older* than the npm-detected tag - e.g. the
   *  file was last updated for 1.1.0, but 1.2.0-1.5.0 were released without ever documenting them,
   *  and npm now reports 1.5.0 - starting from the tag alone would silently skip everything the
   *  file never recorded. The boundary becomes the merge-base of the two, so the result always
   *  covers at least as much as the file is missing. Has no effect when the file doesn't exist. */
  catchUpFile?: string;
}

/**
 * Resolves the commit/hash a package's changes should be measured "since" - the boundary
 * `changelog --from` uses, but reusable anywhere a command wants to answer "what changed for this
 * package". An explicit `options.from` (anything but `"npm"`) is returned as-is, applying the same
 * way to every package. Otherwise, it's auto-detected in order: (1) this package's own most recent
 * release tag - the same network-free `findLatestTag` lookup `version`/`changed` themselves use,
 * so all three commands agree on "since when" for any repo whose tags are the ones `rman version`
 * actually created; (2) failing that (no tag at all yet - e.g. onboarding `rman` onto a repo with
 * real npm history but no `rman`-created tags), the package's currently-published npm version -
 * looked up via `npmViewVersion`, then mapped to a git tag using `.rmanrc changelog.tagPattern`
 * (see `tagPattern`). Either way, if `catchUpFile` is given and exists, the result is widened to
 * also cover anything that file hasn't caught up on yet (see its doc comment). Returns `undefined`
 * when nothing can be resolved at all (never tagged *and* never published, no catch-up file - a
 * genuinely first-ever release) - callers should fall back to their own default in that case (e.g.
 * the whole history, since nothing has ever been released).
 */
export async function detectChangeHash(
  git: GitHelper,
  pkg: Package,
  options: DetectChangeHashOptions = {},
): Promise<string | undefined> {
  if (options.from && options.from !== 'npm') return options.from;

  let tagHash = await findLatestTag(git, pkg);
  if (!tagHash) {
    const npmViewVersion = options.npmViewVersion ?? defaultNpmViewVersion;
    const publishedVersion = await npmViewVersion(pkg.name, git.cwd);
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

const execFileAsync = promisify(execFile);

const DEFAULT_TAG_PATTERN = 'v*';
