/**
 * Conventional Commits, as rman reads them: the subject-line shape, the breaking-change markers,
 * the `Release-As:` escape hatch, and the counter-question of whether a commit is a *release
 * marker* rather than a change at all.
 *
 * A namespace for the reason `ChangeHashService` is one - one subject, several operations, named for
 * what they do rather than repeating the subject (`parseSubject`, not `parseConventionalCommit`).
 *
 * **Nothing here knows about versions.** A commit says what happened; `VersionScheme.bumpFor` turns
 * that into how a number moves. `parseReleaseAs` is the one place the two meet, and it deliberately
 * returns the word as written rather than judging it - see its own doc.
 */
export namespace ConventionalCommitsService {
  /**
   * `type(scope): description`, optionally with a `!` breaking-change marker - Conventional
   * Commits' subject-line shape. Anything that doesn't match falls into "Other Changes" as-is (for
   * changelog entries) or defaults to a patch-level change (for version bump severity) - see
   * `parseSubject`.
   */
  export const SUBJECT_PATTERN = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;

  /** A bare version-bump commit (`"6.0.1"`, `"v2.3.0-beta.1"`, ...) - many release tools commit the
   *  version bump itself with just the new version number as the message. That's a release marker,
   *  not a real change worth describing (or worth bumping a version over on its own), so it's
   *  dropped everywhere a real change is being looked for. */
  export const VERSION_BUMP_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

  /**
   * Whether `subject` is a release marker rather than a real change - dropped everywhere real
   * changes are looked for (changelog entries, and what counts as "changed" for a version bump).
   *
   * Covers the bare-version form other tools use (`VERSION_BUMP_PATTERN`) plus every message shape
   * `version` itself writes: its commit message (`commitMessageTemplate`, or the built-in
   * `"chore(release): v{version}"` when a repo doesn't override it), the multi-version form that
   * template falls back to when one commit spans several versions (`chore(release): a@1.2.0,
   * b@1.3.0`), and the monorepo root's own version-sync commit. Without this, rman's own release
   * commits show up in the changelogs it generates - visible whenever the boundary reaches back past
   * a previous release (see `ChangeHashService.detect`'s `catchUpFile`).
   */
  export function isReleaseCommit(subject: string, commitMessageTemplate?: string): boolean {
    if (VERSION_BUMP_PATTERN.test(subject)) return true;
    if (ROOT_SYNC_PATTERN.test(subject)) return true;
    if (MULTI_VERSION_RELEASE_PATTERN.test(subject)) return true;
    // The built-in message is checked even when a repo overrides it: the override only applies to
    // commits spanning a single version (see `buildCommitMessage`), and a repo that adopted one later
    // still has older releases committed under the default.
    if (templatePattern(DEFAULT_COMMIT_MESSAGE).test(subject)) return true;
    return !!commitMessageTemplate && templatePattern(commitMessageTemplate).test(subject);
  }

  export interface ParsedSubject {
    type: string;
    scope?: string;
    /** A `!` right before the `:` (e.g. `feat!:`) - Conventional Commits' inline breaking-change
     *  marker. Doesn't cover a `BREAKING CHANGE:` footer, since only the subject line is available. */
    breaking: boolean;
    description: string;
  }

  /** Parses a commit subject as Conventional Commits, or `undefined` if it doesn't match at all
   *  (a non-conventional message - still a real change, just with no `type` to key off of). */
  export function parseSubject(subject: string): ParsedSubject | undefined {
    const m = SUBJECT_PATTERN.exec(subject);
    if (!m) return undefined;
    const [, type, , scope, breakingMark, description] = m;
    return { type: type.toLowerCase(), scope, breaking: !!breakingMark, description };
  }

  /** Whether a commit `body` carries a Conventional Commits `BREAKING CHANGE:` (or
   *  `BREAKING-CHANGE:`) footer - the other, footer-based way to mark a breaking change, alongside
   *  the inline `!` the subject line alone can carry (see `parseSubject`, whose own
   *  `breaking` only ever reflects that marker, never a footer, since it only sees the subject). */
  export function hasBreakingChangeFooter(body: string): boolean {
    return /^BREAKING[ -]CHANGE:/im.test(body);
  }

  /**
   * A `Release-As: <bump>` footer in a commit `body` - lets that one commit's own contribution to the
   * detected bump be overridden by hand, regardless of what its subject line (or a `BREAKING CHANGE:`
   * footer) would otherwise imply. The motivating case: a `feat:` commit that needs to ship right now
   * as a patch, without waiting for the rest of a minor's worth of work to land - `Release-As: patch`
   * on just that commit ships it alone, at patch size, while a later genuine `feat:` (with no
   * override) still correctly triggers a minor of its own. Case-insensitive; the last match wins if a
   * body somehow has more than one, matching how multiple git trailers of the same key are
   * conventionally read (later overrides earlier).
   *
   * **Returns the word as written, and does not judge it** - which bumps exist is the package's
   * `VersionScheme.bumpNames`, and this module is about commit messages. The caller checks it against
   * those and treats anything else as *no override at all*, falling back to what the commit's own
   * subject said (see `VersionPlanService.detectBump`). That keeps two cases harmless: a typo, and release-please's own
   * `Release-As: 1.2.3`, which uses the same trailer for a literal version and appears in real
   * repositories rman gets adopted onto.
   */
  export function parseReleaseAs(body: string): string | undefined {
    const matches = [...body.matchAll(/^release-as:\s*([\w.+-]+)\s*$/gim)];
    const last = matches.at(-1);
    return last ? last[1].toLowerCase() : undefined;
  }
}

/** A semver version, as it appears inside a commit subject - the `\d+\.\d+\.\d+` core of
 *  `VERSION_BUMP_PATTERN`, reusable inside the larger patterns below. */
const SEMVER_SOURCE = String.raw`\d+\.\d+\.\d+(?:[-+][\w.]+)?`;

/** Mirrors `VersionService`'s own default `version.commitMessage` - kept in sync by
 *  `version.command.ts`'s documented default, not imported, to keep this module dependency-free. */
const DEFAULT_COMMIT_MESSAGE = 'chore(release): v{version}';

/** `VersionService.applyPlan`'s trailing commit for a monorepo root's informational version. */
const ROOT_SYNC_PATTERN = new RegExp(String.raw`^chore: sync root version to ${SEMVER_SOURCE}$`);

/** What the commit-message template falls back to when one commit covers several versions at once
 *  (a cross-group ripple) - `{version}` has nothing single to substitute, so each bumped package is
 *  listed by name instead. */
const MULTI_VERSION_RELEASE_PATTERN = new RegExp(
  String.raw`^chore\(release\): \S+@${SEMVER_SOURCE}(?:, \S+@${SEMVER_SOURCE})*$`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turns a `version.commitMessage` template into a matcher for the commits it produces: every
 *  literal part escaped, each `{version}` placeholder standing in for any semver. */
function templatePattern(template: string): RegExp {
  const source = template.split('{version}').map(escapeRegExp).join(SEMVER_SOURCE);
  return new RegExp(`^${source}$`);
}
