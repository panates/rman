/**
 * `type(scope): description`, optionally with a `!` breaking-change marker - Conventional
 * Commits' subject-line shape. Anything that doesn't match falls into "Other Changes" as-is (for
 * changelog entries) or defaults to a patch-level change (for version bump severity) - see
 * `parseConventionalCommit`.
 */
export const CONVENTIONAL_PATTERN = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;

/** A bare version-bump commit (`"6.0.1"`, `"v2.3.0-beta.1"`, ...) - many release tools commit the
 *  version bump itself with just the new version number as the message. That's a release marker,
 *  not a real change worth describing (or worth bumping a version over on its own), so it's
 *  dropped everywhere a real change is being looked for. */
export const VERSION_BUMP_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

export interface ParsedCommitSubject {
  type: string;
  scope?: string;
  /** A `!` right before the `:` (e.g. `feat!:`) - Conventional Commits' inline breaking-change
   *  marker. Doesn't cover a `BREAKING CHANGE:` footer, since only the subject line is available. */
  breaking: boolean;
  description: string;
}

/** Parses a commit subject as Conventional Commits, or `undefined` if it doesn't match at all
 *  (a non-conventional message - still a real change, just with no `type` to key off of). */
export function parseConventionalCommit(subject: string): ParsedCommitSubject | undefined {
  const m = CONVENTIONAL_PATTERN.exec(subject);
  if (!m) return undefined;
  const [, type, , scope, breakingMark, description] = m;
  return { type: type.toLowerCase(), scope, breaking: !!breakingMark, description };
}

/** Whether a commit `body` carries a Conventional Commits `BREAKING CHANGE:` (or
 *  `BREAKING-CHANGE:`) footer - the other, footer-based way to mark a breaking change, alongside
 *  the inline `!` the subject line alone can carry (see `parseConventionalCommit`, whose own
 *  `breaking` only ever reflects that marker, never a footer, since it only sees the subject). */
export function hasBreakingChangeFooter(body: string): boolean {
  return /^BREAKING[ -]CHANGE:/im.test(body);
}

/**
 * A `Release-As: patch|minor|major` footer in a commit `body` - lets that one commit's own
 * contribution to a detected bump severity be overridden by hand, regardless of what its subject
 * line (or a `BREAKING CHANGE:` footer) would otherwise imply. The motivating case: a `feat:`
 * commit that needs to ship right now as a patch, without waiting for the rest of a minor's worth
 * of work to land - `Release-As: patch` on just that commit ships it alone, at patch severity,
 * while a later genuine `feat:` (with no override) still correctly triggers a minor of its own.
 * Case-insensitive; the last match wins if a body somehow has more than one, matching how multiple
 * git trailers of the same key are conventionally read (later overrides earlier).
 */
export function parseReleaseAs(body: string): 'patch' | 'minor' | 'major' | undefined {
  const matches = [...body.matchAll(/^release-as:\s*(patch|minor|major)\s*$/gim)];
  const last = matches.at(-1);
  return last ? (last[1].toLowerCase() as 'patch' | 'minor' | 'major') : undefined;
}
