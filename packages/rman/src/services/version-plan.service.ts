import path from 'node:path';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { assertOneScheme, type ChangeKind, semverScheme, VersionScheme } from '../core/version-scheme.js';
import { type CommitInfo, GitHelper } from '../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { findLastReleaseVersion, formatCalendarVersion, usesCalendarVersion } from '../utils/release-version.js';
import { ConventionalCommitsService } from './conventional-commits.service.js';

/**
 * Question A, computed and nothing else: **which packages have changed since their last release,
 * and what version would each get.** Reads git, the packages' current versions and `.rmanrc`;
 * writes nothing, touches no manifest, makes no commit. `VersionService.applyPlan` does the writes.
 *
 * **Abstract, so the core cannot produce a plan on its own** - a repository gets one from the
 * planner its `plugins` contribute (`@rman/node`'s `NodeVersionPlanService` for a Node repository).
 * That is not ceremony: what a release *is* differs by ecosystem, and two of the decisions below
 * have no answer that is true of repositories in general.
 *
 * What stays here is what is true of any repository rman manages, and would only be copied by every
 * plugin if it were moved out: groups, the reading of a commit as a `ChangeKind`, the in-group and
 * cross-group cascade *mechanics*, and the monorepo root's own release identity. The bump *names*
 * are not here either - they are the `VersionScheme`'s, so nothing in this file spells
 * `patch`/`minor`/`major`. `getPlan` is a template holding
 * those together - it is a plain method, not `final`, so a technology this shape genuinely does not
 * fit overrides it outright and keeps the pieces (they are all `protected`) it still wants.
 *
 * The two abstract members are the ones a plugin must answer:
 *
 * - **`detectBoundary`** - since when is a package unreleased. Git tags are the usual answer and
 *   `detectChangeHash` is exported for it, but *which* registry to fall back to when a package has
 *   no tag yet is the ecosystem's business (npm's `npm view`, another's something else).
 * - **`cascade`** - which of a group's other members a bump of a given size has to reach, named in
 *   the scheme's own `bumpNames` (so a planner and the scheme it ships with share one vocabulary
 *   and the core needs none of its own). The familiar
 *   patch/minor/major mapping is a statement about **npm's dependency ranges**, not about releases:
 *   it holds because `^1.2.0` already tolerates a patch, so a patch needs no downstream republish.
 *   An ecosystem pinning exact versions has to release every dependent for a patch too, and a core
 *   that assumed the caret would quietly be wrong for it.
 */
export abstract class VersionPlanService {
  /**
   * Computes what a version bump *would* do, across every package `.rmanrc group` puts together -
   * never writes anything (no manifest edits, no git commits/tags) and safe to call any time,
   * including as the "preview" a bare `rman version` (no bump given) stops at.
   *
   * Packages are partitioned into groups by their resolved `group` value (cascaded): `true`
   * (the default) puts every such package into one implicit repo-wide group; a string joins
   * exactly the other packages sharing that same string, regardless of the repo's default; `false`
   * makes a package its own solo group. Each group's "current version" is always the highest
   * version currently found among its own members (never persisted anywhere) - see
   * `resolveGroupKey`.
   *
   * Within a group, a member with real commits since its own last release (or an explicit `bump`)
   * contributes a bump; the group takes the largest of them (`VersionScheme.highestBump`) and its
   * new version is the current one advanced by that. Which members actually receive it is
   * `cascade`'s answer, applied by `computeGroupPlan`.
   *
   * Across groups: a package depending on another group's bumped package always gets its scheme's
   * **smallest** bump of its own (never inheriting the source's) - the dependency reference itself
   * is the only thing that changed for it. Whether that re-triggers its own group's cascade is
   * `cascade`'s answer for that smallest bump (`'changed'` under npm, so it does not), but it can
   * itself ripple into a third group, and so on, until nothing new is affected - see
   * `rippleCrossGroup`.
   *
   * A monorepo's root package is never a real member of any group (it's never published on its
   * own) - it gets one trailing entry instead, carrying the repository's own release identity: the
   * single group's version when there is one, a calendar version once there are several - see
   * `buildRootEntry`.
   *
   * "Since its own last release" is `detectBoundary`'s answer, which for every plugin so far is the
   * shared `detectChangeHash` - the same boundary `changelog` measures from, so the two never
   * disagree about which commits are unreleased.
   */
  async getPlan(repository: Repository, options: VersionPlanService.Options = {}): Promise<VersionPlanService.Entry[]> {
    const bump = options.bump?.trim();
    /**
     * Both halves are the *root* scheme's to judge: an explicit `rman version <bump|version>` is one
     * value for the whole run, so there is no per-package scheme to ask. (A group numbering
     * differently from the root would have to be given its own run - `assertOneScheme` only promises
     * that a group agrees with itself.)
     */
    const scheme = repository.rootPackage.versionScheme;
    const explicitBump = bump && scheme.bumpNames.includes(bump) ? bump : undefined;
    const explicitVersion = bump && !explicitBump && scheme.isValid(bump) ? bump : undefined;
    if (bump && !explicitBump && !explicitVersion) {
      /**
       * Every word here comes from the scheme that rejected it - the bump names as well as the
       * format's name. Neither is rman's to state: `patch`/`minor`/`major` are semver's words for
       * how a number moves, and a `major.minor.build.revision` scheme has four sizes and no `patch`
       * at all. Listing the scheme's own names also beats a vague "a valid version", which leaves
       * the reader to guess which spelling they missed.
       */
      throw new Error(
        `Invalid "bump": "${bump}" (expected ${scheme.bumpNames.map(n => `"${n}"`).join(', ')}, ` +
          `or a valid ${scheme.name} version)`,
      );
    }

    const git = new GitHelper({ cwd: repository.dirname });
    const packages = filterPackages(repository.getPackages(), options);

    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const isDirty = (pkg: Package) => dirtyFiles.some(f => !path.relative(pkg.dirname, f).startsWith('..'));

    const entries = new Map<string, VersionPlanService.Entry>();
    const eligible: Package[] = [];
    for (const pkg of packages) {
      if (isDirty(pkg)) {
        entries.set(pkg.name, {
          package: pkg,
          groupKey: this.resolveGroupKey(pkg),
          group: this.groupLabel(this.resolveGroupKey(pkg)),
          status: options.ignoreDirty ? 'skip' : 'error',
          from: pkg.version,
          reason: 'uncommitted local changes',
        });
        continue;
      }
      eligible.push(pkg);
    }

    const commitMessage = repository.rootPackage.config?.version?.commitMessage;
    const changeByPackage = new Map<string, VersionPlanService.Change>();
    await Promise.all(
      eligible.map(async pkg => {
        if (explicitVersion) {
          changeByPackage.set(pkg.name, { bump: undefined, reason: `explicit version ${explicitVersion}` });
          return;
        }
        const since = await this.detectBoundary(git, pkg, options);
        const commits = since ? await git.listCommits({ hash: since }) : await git.listAllCommits();
        const belongsToPkg = (c: CommitInfo) => c.files.some(f => !path.relative(pkg.dirname, f).startsWith('..'));
        const real = commits.filter(
          c => belongsToPkg(c) && !ConventionalCommitsService.isReleaseCommit(c.subject, commitMessage),
        );
        if (!real.length) return;
        changeByPackage.set(pkg.name, {
          bump: explicitBump ?? this.detectBump(real, pkg.versionScheme),
          reason: since ? `changed since ${since}` : 'unreleased commits',
        });
      }),
    );

    const groups = new Map<string, Package[]>();
    for (const pkg of eligible) {
      const key = this.resolveGroupKey(pkg);
      const list = groups.get(key);
      if (list) list.push(pkg);
      else groups.set(key, [pkg]);
    }

    for (const [key, members] of groups) {
      this.computeGroupPlan(key, members, changeByPackage, explicitVersion, options.preid, entries);
    }

    this.rippleCrossGroup(packages, entries, options.preid);

    const result = packages.map(pkg => entries.get(pkg.name)!);
    if (repository.monorepo) {
      result.push(
        this.buildRootEntry(repository, result, {
          groupCount: groups.size,
          lastReleaseVersion: await findLastReleaseVersion(git, repository.rootPackage),
          now: options.now ?? (() => new Date()),
        }),
      );
    }
    return result;
  }

  /**
   * The commit a package's changes are measured **since** - its last release boundary, or
   * `undefined` for a package that has never been released (the caller then reads the whole
   * history, since nothing in it has shipped).
   *
   * Abstract because the fallback is: git tags answer this for any repository and
   * `detectChangeHash` is exported for exactly that, but a package with no tag yet (rman adopted
   * onto a repository with real release history) can only be placed by asking wherever its releases
   * actually went - which is a registry only the ecosystem knows about.
   *
   * `options` is the object `getPlan` was called with, for a planner whose boundary depends on what
   * the run asked for. A planner's *own* configuration does not come through here - it is an object
   * now, so an injectable registry lookup belongs in its constructor (the `Deps` pattern
   * `ChangelogService`/`PublishService` already use), where a test can supply one without every
   * caller's options type having to know about it.
   */
  protected abstract detectBoundary(
    git: GitHelper,
    pkg: Package,
    options: VersionPlanService.Options,
  ): Promise<string | undefined>;

  /**
   * How far into its own group a bump of this size has to reach - see
   * `VersionPlanService.Cascade`.
   *
   * Abstract because the answer is a statement about how this ecosystem's packages *refer* to each
   * other, not about versions. With npm's caret ranges a dependent already accepts its dependency's
   * patch, so nothing downstream needs republishing; pin exact versions instead and every dependent
   * needs a release of its own for the same patch. There is no mapping that is true of both, and a
   * wrong one here is invisible - it produces a plan that simply releases too little.
   */
  protected abstract cascade(bump: string): VersionPlanService.Cascade;

  /**
   * The largest bump `commits` ask for, in `scheme`'s own names.
   *
   * Two steps, and keeping them apart is the point. **What happened** comes from the commit message
   * - a `!` marker or `BREAKING CHANGE:` footer is `'breaking'`, a `feat:` is `'feature'`, anything
   * else (a `fix:`, an unrecognized type, a non-conventional subject) is `'fix'`, since something
   * changed and at least the smallest release is warranted. **How the number moves** is then
   * `scheme.bumpFor`'s answer, because "patch" is a sentence about a semver number and not about a
   * commit.
   *
   * A `Release-As:` footer (see `parseReleaseAs`) replaces what that one commit's own
   * subject/footers would otherwise imply - the escape hatch for a `feat:` that has to ship as a
   * patch right now, without waiting for the rest of a minor's worth of work. It names a bump
   * directly rather than a kind, so it is checked against `scheme.bumpNames` and a word the scheme
   * does not declare falls through to what the commit itself said - which is what keeps a typo, and
   * another tool's `Release-As: 1.2.3` in history rman was adopted onto, from deciding a release.
   *
   * Not abstract: conventional commits are a convention about *commit messages*, which no ecosystem
   * owns. A planner for a repository writing them differently overrides this.
   */
  protected detectBump(commits: CommitInfo[], scheme: VersionScheme): string {
    const asked: string[] = [scheme.bumpFor('fix')];
    for (const c of commits) {
      const override = ConventionalCommitsService.parseReleaseAs(c.body);
      /**
       * Honoured only when `scheme` actually declares it. Measured, because the obvious `if
       * (override)` is wrong in a way that looks fine: a footer the scheme does not know would
       * *replace* what the commit itself said, so a `feat:` carrying release-please's own
       * `Release-As: 1.2.3` came out a patch instead of a minor. An unrecognized word means "no
       * override", exactly as it did when only three were ever recognized.
       */
      if (override && scheme.bumpNames.includes(override)) {
        asked.push(override);
        continue;
      }
      asked.push(scheme.bumpFor(kindOf(c)));
    }
    return scheme.highestBump(asked)!;
  }

  /** `.rmanrc group` (cascaded): `true` (the default - see `resolveConfig`'s cascade, this is what a
   *  package inherits when nobody sets it at all) puts a package in the one implicit repo-wide
   *  group; a non-empty string joins exactly the other packages sharing that string, regardless of
   *  the repo's own default; `false` makes it a solo group of one. */
  protected resolveGroupKey(pkg: Package): string {
    const g = pkg.config?.group;
    if (g === false) return `solo:${pkg.name}`;
    if (typeof g === 'string' && g) return `named:${g}`;
    return 'default';
  }

  /** The human-readable name behind a `groupKey` - what a plan's `group` column shows. */
  protected groupLabel(key: string): string {
    if (key.startsWith('named:')) return key.slice('named:'.length);
    if (key.startsWith('solo:')) return key.slice('solo:'.length);
    return key;
  }

  /**
   * Decides one group's new version and which of its members actually receive it, writing an
   * `Entry` per member into `entries`. `changeByPackage` holds each eligible package's own detected
   * bump (or `undefined` for one with no real commits since its last boundary) - `undefined`
   * here always means "unchanged", never "explicit version" (that path is handled separately).
   *
   * How wide the bump goes is `cascade`'s answer, and only its answer: an explicit
   * `rman version <v>` has no bump left to consult, so it reaches the changed members alone.
   */
  protected computeGroupPlan(
    key: string,
    members: Package[],
    changeByPackage: Map<string, VersionPlanService.Change>,
    explicitVersion: string | undefined,
    preid: string | undefined,
    entries: Map<string, VersionPlanService.Entry>,
  ): void {
    const label = this.groupLabel(key);
    /** One version line, so one scheme - the members are about to be compared against each other and
     *  bumped together, which two schemes would make meaningless. */
    assertOneScheme(
      members.map(m => ({ packageName: m.name, scheme: m.versionScheme })),
      label,
    );
    const scheme = members[0]?.versionScheme ?? semverScheme;
    const changed = members.filter(m => changeByPackage.has(m.name));
    if (!changed.length) {
      for (const m of members) {
        entries.set(m.name, { package: m, groupKey: key, group: label, status: 'no-change', from: m.version });
      }
      return;
    }

    const current = scheme.highestVersion(members.map(m => m.version)) ?? members[0].version;
    let to: string;
    let bump: string | undefined;
    if (explicitVersion) {
      to = explicitVersion;
    } else {
      /** The largest any changed member asked for - `changed` is non-empty here, so this always
       *  resolves; the `!` is for the type. */
      bump = scheme.highestBump(changed.map(m => changeByPackage.get(m.name)!.bump!))!;
      to = scheme.next(current, bump, { preid });
    }

    const bumping = new Set<Package>(changed);
    const cascade = bump ? this.cascade(bump) : 'changed';
    if (cascade === 'group') {
      for (const m of members) bumping.add(m);
    } else if (cascade === 'dependents') {
      const worklist = [...changed];
      while (worklist.length) {
        const cur = worklist.pop()!;
        for (const m of members) {
          if (bumping.has(m)) continue;
          if (m.dependencies.includes(cur)) {
            bumping.add(m);
            worklist.push(m);
          }
        }
      }
    }

    /** Why a member with no commits of its own is being bumped. `'group'` reaches members that
     *  depend on nothing at all, so calling those a "dependent" was simply untrue. */
    const inherited =
      cascade === 'group' ? `in-group member of a ${bump} change` : `in-group dependent of a ${bump} change`;
    for (const m of members) {
      if (bumping.has(m)) {
        const own = changeByPackage.get(m.name);
        entries.set(m.name, {
          package: m,
          groupKey: key,
          group: label,
          status: 'bump',
          from: m.version,
          to,
          reason: own?.reason ?? inherited,
        });
      } else {
        entries.set(m.name, { package: m, groupKey: key, group: label, status: 'no-change', from: m.version });
      }
    }
  }

  /**
   * A package depending on another group's bumped package always receives its scheme's **smallest**
   * bump, computed from its *own* group's current ceiling (the highest `to`/version among its group
   * right now) - never the source's version, and never the source's bump. Runs as a worklist until
   * nothing new is affected, since bumping one package can itself cross into a third group, and so
   * on; never touches a same-group dependent that `cascade` deliberately left alone.
   *
   * The smallest regardless of ecosystem, and not by oversight: nothing about the dependent changed
   * except the reference it carries, so there is nothing for a larger bump to describe. Which bump
   * *is* the smallest is the scheme's to say (`smallestBump`) - `patch` under semver, `revision` for
   * a four-part scheme. A planner for which a changed dependency is not a release at all overrides
   * this to do nothing.
   */
  protected rippleCrossGroup(
    packages: Package[],
    entries: Map<string, VersionPlanService.Entry>,
    preid: string | undefined,
  ): void {
    const worklist = [...entries.values()].filter(e => e.status === 'bump');
    while (worklist.length) {
      const source = worklist.shift()!;
      for (const pkg of packages) {
        const entry = entries.get(pkg.name)!;
        if (entry.status === 'bump' || entry.groupKey === source.groupKey) continue;
        if (!pkg.dependencies.includes(source.package)) continue;

        /** The group always contains `pkg` itself, so there is always at least one version here -
         *  the fallback is for the type, not for a case that can happen. */
        const groupCeiling =
          pkg.versionScheme.highestVersion(
            packages
              .filter(p => entries.get(p.name)!.groupKey === entry.groupKey)
              .map(p => entries.get(p.name)!.to ?? p.version),
          ) ?? pkg.version;
        const next: VersionPlanService.Entry = {
          ...entry,
          status: 'bump',
          to: pkg.versionScheme.next(groupCeiling, pkg.versionScheme.smallestBump(), { preid }),
          reason: `depends on ${source.package.name}@${source.to}`,
        };
        entries.set(pkg.name, next);
        worklist.push(next);
      }
    }
  }

  /**
   * A monorepo root is never published on its own, but its version is still the repository's release
   * identity - what a GitHub Release is named after. How it's computed depends on how many version
   * lines the repo has, derived rather than configured (see `usesCalendarVersion`):
   *
   * - **One group**: the root simply follows it, so the repo and its packages share one number.
   * - **Several groups** (or a repo already on calendar): a calendar version (`2026.9.15-1430`).
   *   There is no meaningful shared number to report - the old "highest version among the groups"
   *   rule would leave the root standing still whenever a *lower* line released, so a release could
   *   happen with no identity of its own, and a semver-looking identity would anyway claim something
   *   untrue about packages sitting on entirely different lines.
   *
   * Reports `'no-change'` (not `'bump'`) when nothing in the repository changed at all.
   */
  protected buildRootEntry(
    repository: Repository,
    memberEntries: VersionPlanService.Entry[],
    context: { groupCount: number; lastReleaseVersion?: string; now: () => Date },
  ): VersionPlanService.Entry {
    const root = repository.rootPackage;
    const anyBumped = memberEntries.some(e => e.status === 'bump');
    if (!anyBumped) {
      return { package: root, groupKey: '__root__', group: 'root', status: 'no-change', from: root.version };
    }
    const calendar = usesCalendarVersion({
      groupCount: context.groupCount,
      rootVersion: root.version,
      lastReleaseVersion: context.lastReleaseVersion,
    });
    const finalVersions = memberEntries.map(e => e.to ?? e.from);
    const to = calendar
      ? formatCalendarVersion(context.now())
      : (root.versionScheme.highestVersion(finalVersions) ?? root.version);
    return {
      package: root,
      groupKey: '__root__',
      group: 'root',
      status: 'bump',
      from: root.version,
      to,
      reason: calendar
        ? 'repository release identity - several version lines, so no shared number to report'
        : 'informational - monorepo root is never published on its own',
    };
  }
}

export namespace VersionPlanService {
  /**
   * How far into its own group a bump reaches - `VersionPlanService.cascade`'s answer, per bump.
   *
   * - `'changed'` - only the members with commits of their own.
   * - `'dependents'` - those, plus every in-group package that (transitively) depends on one.
   * - `'group'` - every member, changed or not.
   */
  export type Cascade = 'changed' | 'dependents' | 'group';

  /** What was found for one package before groups are resolved: the bump its own commits ask for
   *  (in its scheme's names, or `undefined` when an explicit version makes the question moot) and
   *  why, which becomes the plan entry's `reason`. */
  export interface Change {
    bump?: string;
    reason: string;
  }

  export interface Options extends PackageFilterOptions {
    /** One of the root scheme's own `bumpNames` (applied to every group that has real changes) or a
     *  concrete version it recognizes (applied as the literal new version wherever something
     *  changed) - either way, this replaces auto-detection entirely. Omit to auto-detect the bump
     *  per group from conventional-commit subjects since each package's/group's last release tag. */
    bump?: string;
    /** A package with uncommitted local changes is excluded from bumping (status `'skip'`)
     *  instead of aborting the whole plan (status `'error'`). Default false. */
    ignoreDirty?: boolean;
    /** Makes every computed bump a prerelease (`1.2.3` -> `1.3.0-beta.0` for a `minor`, say)
     *  tagged with this identifier, instead of a normal release - same idea as `npm version
     *  <type> --preid <name>`. A group already sitting on a matching prerelease (same identifier)
     *  just has its prerelease counter incremented instead of jumping to a new base version - see
     *  `VersionScheme.next`. Has no effect when `bump` is an explicit semver version rather than a keyword
     *  (there's no bump left to "pre-fix" at that point). */
    preid?: string;
    /** Clock behind a monorepo root's calendar release version - injectable so tests are
     *  deterministic. Default `() => new Date()`. */
    now?: () => Date;
  }

  /** One package's outcome in a version plan - see `getPlan`. */
  export interface Entry {
    package: Package;
    /** Internal group identity packages are batched by (not for display) - see `resolveGroupKey`. */
    groupKey: string;
    /** Human-readable group name: `'default'` for the implicit repo-wide group, the configured
     *  name for a named `group`, or the package's own name when it isn't grouped with anyone. */
    group: string;
    status: 'bump' | 'skip' | 'error' | 'no-change';
    from: string;
    /** Only set when `status === 'bump'`. */
    to?: string;
    /** Human-readable explanation - e.g. why a package was skipped, or why it's being bumped
     *  despite having no commits of its own (a dependency of it changed elsewhere). */
    reason?: string;
  }

  /**
   * Registers the planner every `version`/`changed` run will use, replacing any previous one.
   *
   * **One slot, last registration wins** - unlike `Manifest`/`Workspace`, which keep a list and take
   * the first provider that *recognizes* a repository. A planner has nothing to recognize: asked for
   * a plan it always has one, so "first that answers" would just mean "first registered" and a
   * repository layering its own policy plugin after `@rman/node` could never take effect - which is
   * the only reason to name two in the first place.
   */
  export function setPlanner(planner: VersionPlanService): void {
    current = planner;
  }

  /** For tests, which would otherwise leak a planner into every later case in the process. */
  export function clearPlanner(): void {
    current = undefined;
  }

  /**
   * The registered planner. **Throws** when there is none, rather than falling back to some
   * built-in default: `Manifest` and `Workspace` can degrade honestly (a package named after its
   * directory, a repository that is its own single package), but there is no version plan that is
   * merely a diminished one - a wrong cascade or a wrong boundary reports a release that is
   * plausible and untrue.
   */
  export function getPlanner(): VersionPlanService {
    if (!current) {
      throw new Error(
        'No version planner is registered, so no version plan can be computed. Name a plugin that ' +
          'contributes one in .rmanrc "plugins" - "@rman/node" for a Node repository.',
      );
    }
    return current;
  }

  let current: VersionPlanService | undefined;
}

/** What one commit says happened, with no reference to any version format - `VersionScheme.bumpFor`
 *  turns it into a number's movement. Everything unrecognized is a `'fix'`: something changed, so
 *  the smallest release is still warranted. */
function kindOf(commit: CommitInfo): ChangeKind {
  const parsed = ConventionalCommitsService.parseSubject(commit.subject);
  if (parsed?.breaking || ConventionalCommitsService.hasBreakingChangeFooter(commit.body)) return 'breaking';
  return parsed?.type === 'feat' ? 'feature' : 'fix';
}
