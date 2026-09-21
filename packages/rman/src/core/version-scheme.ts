import semver from 'semver';

/**
 * What the commits said *happened*, in Conventional Commits' own terms: a `!` or `BREAKING CHANGE:`
 * footer, a `feat:`, or anything else (a `fix:`, an unrecognized type, a non-conventional subject).
 *
 * Three, because three is how many sizes a commit message distinguishes - which is a fact about
 * commit messages, not about any version format. It is deliberately **not** `patch`/`minor`/`major`:
 * those are semver's words for how a *number* moves, and a scheme numbering
 * `major.minor.build.revision` has four of those and no `patch` at all. `VersionScheme.bumpFor`
 * translates one of these into a bump that scheme actually has a name for.
 */
export type ChangeKind = 'fix' | 'feature' | 'breaking';

/**
 * How a package's versions are numbered: named, ordered, validated, and advanced.
 *
 * rman's release model was written in semver - tag patterns, changelog headings, release identity,
 * "is this version on the registry yet", `"workspace:"` range rewriting all assume versions that
 * can be ordered and incremented. This is the seam for an ecosystem that numbers differently (PEP
 * 440, a date-based scheme, a build counter), and it is a *meaning* seam rather than a storage one:
 * `ManifestProvider` answers "where is the version written", this answers "what does the next one
 * look like".
 *
 * **`bumpNames` and `bumpFor` are the interesting part.** `fix:` -> patch, `feat:` -> minor,
 * `feat!:` -> major is a sentence in *semver's* vocabulary from end to end, so a scheme that numbers
 * differently does not need a different `inc()` - it needs its own set of bump names and its own
 * answer to "what does a `feat:` mean for one of my version numbers". A CalVer scheme can
 * legitimately answer all three with the same name and return today's date; that is the scheme's
 * decision to make, which is why the seam is here and not around `semver.inc`.
 *
 * **An abstract class rather than an interface**, for the reason `VersionPlanService` is one:
 * `highestVersion`, `highestBump` and `smallestBump` all *derive* from the members below them, so
 * requiring every scheme to write them would be boilerplate and a second place for two answers to
 * disagree - but each is a real decision a scheme may need to make differently (a repo maintaining
 * parallel lines has its own idea of "highest"; a four-part scheme may want the ripple bump to be
 * `build` rather than its actual smallest). Implemented here, overridable there. Subclass
 * `SemverScheme` to keep semver's numbering and change only one of these.
 */
export abstract class VersionScheme {
  /** For error messages, and for `info`. */
  abstract readonly name: string;

  /**
   * Every bump this scheme accepts by name, **smallest first** - semver's
   * `['patch', 'minor', 'major']`, a four-part `major.minor.build.revision` scheme's
   * `['revision', 'build', 'minor', 'major']`.
   *
   * The scheme's, not rman's, because these are names for how a *version number* moves and only the
   * scheme knows what parts it has. This is what `rman version <bump>` validates against and what
   * `--help` lists, so a repository is offered the bumps its own numbering actually has.
   *
   * **The order is the default ranking** read by `highestBump` and `smallestBump`.
   */
  abstract readonly bumpNames: readonly string[];

  /** Which of `bumpNames` a change of this kind calls for - the translation from what a commit said
   *  to how this scheme's numbers move. A scheme that does not distinguish them may answer all
   *  three the same. */
  abstract bumpFor(kind: ChangeKind): string;

  /** Is this a version this scheme recognizes? Used to accept an explicitly given version. */
  abstract isValid(version: string): boolean;

  /** Negative, zero or positive - `Array.prototype.sort`'s contract. */
  abstract compare(a: string, b: string): number;

  /** The version after `current`, given one of this scheme's own `bumpNames`. `preid` asks for a
   *  prerelease line (`--preid`), which a scheme without such a concept may ignore. */
  abstract next(current: string, bump: string, options?: { preid?: string }): string;

  /** Is this version a preview rather than a release? `github-release` reads it. */
  abstract isPrerelease(version: string): boolean;

  /**
   * Which prerelease line this version belongs to - `'beta'` for `2.0.0-beta.1` - or `undefined`
   * when it is not a preview, or is one with no identifier to name (`2.0.0-1`).
   *
   * **The one thing a preview needs beyond "is it one", and it is a *name*, which is why it is
   * here rather than read out of the version with a regex by whoever wants it.** npm's publish
   * target derives its dist-tag from this, so a beta lands on `beta` instead of on `latest`; the
   * identifier is written in the version itself, so that is a reading rather than a guess.
   *
   * Implemented, not abstract, and returning `undefined` by default: a scheme whose previews have
   * no name (or which has no previews at all) is answering honestly, and the caller's job is to
   * say so rather than invent one. `SemverScheme` overrides it.
   */
  prereleaseId(version: string): string | undefined {
    void version;
    return undefined;
  }

  /**
   * The highest of `versions` - a group's current version is the highest among its members, and a
   * monorepo root's release identity the highest among the groups.
   *
   * Empty in, `undefined` out: a group with no versions has no highest one, and guessing `0.0.0`
   * would put a real version line at risk. Override to answer differently - a repository
   * maintaining parallel lines (a 1.x still receiving fixes beside a 2.x) may want the line being
   * released rather than the numerically largest.
   */
  highestVersion(versions: readonly string[]): string | undefined {
    if (!versions.length) return undefined;
    return versions.reduce((highest, v) => (this.compare(v, highest) > 0 ? v : highest));
  }

  /**
   * The largest of `bumps` - what a group takes when its changed members ask for different sizes.
   * Empty in, `undefined` out.
   *
   * A name this scheme does not declare ranks **below** every name it does, rather than throwing -
   * a comparison helper is the wrong place to fail a release. It is a second line of defence, not
   * the guard: `detectBump` already drops an unrecognized `Release-As:` footer before it gets here,
   * because ranking such a word low is not the same as ignoring it (ranked low it still *replaces*
   * what the commit's own subject said - measured, and it turned a `feat:` into a patch).
   *
   * Override for bumps that are not totally ordered, or to refuse an unknown name outright.
   */
  highestBump(bumps: readonly string[]): string | undefined {
    if (!bumps.length) return undefined;
    return bumps.reduce((highest, b) => (this.bumpNames.indexOf(b) > this.bumpNames.indexOf(highest) ? b : highest));
  }

  /**
   * What a package bumped *only* because a dependency of it moved receives - there being nothing
   * about the package itself for a larger bump to describe. `bumpNames`' first entry by default.
   *
   * Throws when this scheme declares no bumps at all: such a scheme cannot express a release, and
   * finding out here beats silently leaving every rippled package unbumped. Override to nominate a
   * different one - a four-part scheme may reserve `revision` for something else and want `build`.
   */
  smallestBump(): string {
    const smallest = this.bumpNames[0];
    if (!smallest) {
      throw new Error(`Version scheme "${this.name}" declares no "bumpNames", so no version can be bumped.`);
    }
    return smallest;
  }
}

/**
 * Semver, exported as a class so a scheme that numbers in semver but decides one thing differently
 * can subclass it instead of restating all of it.
 */
export class SemverScheme extends VersionScheme {
  readonly name = 'semver';
  readonly bumpNames = ['patch', 'minor', 'major'] as const;

  bumpFor(kind: ChangeKind): string {
    switch (kind) {
      case 'breaking':
        return 'major';
      case 'feature':
        return 'minor';
      case 'fix':
        return 'patch';
    }
  }

  isValid(version: string): boolean {
    return !!semver.valid(version);
  }

  compare(a: string, b: string): number {
    return semver.compare(a, b);
  }

  next(current: string, bump: string, options?: { preid?: string }): string {
    const releaseType = bump as semver.ReleaseType;
    const preid = options?.preid;
    if (!preid) return semver.inc(current, releaseType) ?? current;
    /**
     * Already on a prerelease under **this same identifier**: just advance its counter
     * (`1.2.3-beta.0` -> `1.2.3-beta.1`), rather than jumping to a new base version every run of
     * the same beta cycle. Anything else - a plain release, or a prerelease under a *different*
     * identifier (`beta` -> `rc`) - starts a fresh prerelease of `bump`'s own type.
     *
     * Comparing the identifier, not merely "is a prerelease": treating any prerelease as the same
     * line makes switching `beta` to `rc` silently continue the beta counter.
     */
    const existing = semver.prerelease(current);
    const sameLine = existing && String(existing[0]) === preid;
    const preType = sameLine ? 'prerelease' : (`pre${releaseType}` as semver.ReleaseType);
    return semver.inc(current, preType, preid) ?? current;
  }

  isPrerelease(version: string): boolean {
    return !!semver.prerelease(version);
  }

  /**
   * semver's first prerelease identifier, when it is a word: `2.0.0-beta.1` -> `'beta'`.
   *
   * **`undefined` for a numeric-only prerelease** (`2.0.0-1`, whose identifiers are `[1]`), because
   * there is no name there to use - and a caller turning that into a dist-tag called `1` would be
   * inventing one. Same answer for a release, which has no prerelease at all.
   */
  prereleaseId(version: string): string | undefined {
    const first = semver.prerelease(version)?.[0];
    return typeof first === 'string' ? first : undefined;
  }
}

/**
 * The default, and what every package gets unless something says otherwise - so nothing about
 * rman's behaviour changes by this seam existing.
 */
export const semverScheme: VersionScheme = new SemverScheme();

/**
 * Refuses a group whose packages do not agree on a scheme.
 *
 * A group is one version line: its members are compared against each other and bumped together, so
 * two schemes in one group makes both of those undefined. Better to say so than to compare a PEP
 * 440 version against a semver one and act on whatever falls out.
 *
 * A free function rather than a member, unlike the three above: this is a question about a *set of
 * packages*, and asking one of the disagreeing schemes to arbitrate would be asking a party to the
 * dispute.
 */
export function assertOneScheme(schemes: { packageName: string; scheme: VersionScheme }[], group: string): void {
  const first = schemes[0];
  if (!first) return;
  const odd = schemes.find(s => s.scheme.name !== first.scheme.name);
  if (!odd) return;
  throw new Error(
    `Group "${group}" mixes version schemes: "${first.packageName}" uses ${first.scheme.name} and ` +
      `"${odd.packageName}" uses ${odd.scheme.name}.\n` +
      `  A group is one version line - its packages are compared and bumped together, which two ` +
      `schemes make meaningless. Put them in separate groups (.rmanrc "group").`,
  );
}
