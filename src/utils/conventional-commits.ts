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
