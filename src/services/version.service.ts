import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { type ConfigScope, interpolateConfig } from '../core/config.js';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { detectChangeHash, expandTag } from '../utils/change-hash.js';
import {
  hasBreakingChangeFooter,
  isReleaseCommit,
  parseConventionalCommit,
  parseReleaseAs,
} from '../utils/conventional-commits.js';
import { exec } from '../utils/exec.js';
import { type CommitInfo, GitHelper } from '../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import {
  expandReleaseTag,
  findLastReleaseVersion,
  formatCalendarVersion,
  isCalendarVersion,
  usesCalendarVersion,
} from '../utils/release-version.js';
import { stampVersionConstant, stampVersionLabel } from '../utils/version-stamp.js';
import { parseWorkspaceRange } from '../utils/workspace-range.js';
import { ChangelogService } from './changelog.service.js';

export namespace VersionService {
  export type BumpKeyword = 'patch' | 'minor' | 'major';

  export function isBumpKeyword(value: unknown): value is BumpKeyword {
    return value === 'patch' || value === 'minor' || value === 'major';
  }

  export interface Options extends PackageFilterOptions {
    /** A release-type keyword (applied as the severity for every group that has real changes) or
     *  a concrete semver version (applied as the literal new version wherever something changed) -
     *  either way, this replaces auto-detection entirely. Omit to auto-detect the severity per
     *  group from conventional-commit subjects since each package's/group's last release tag. */
    bump?: string;
    /** A package with uncommitted local changes is excluded from bumping (status `'skip'`)
     *  instead of aborting the whole plan (status `'error'`). Default false. */
    ignoreDirty?: boolean;
    /** Makes every computed bump a prerelease (`1.2.3` -> `1.3.0-beta.0` for a `minor`, say)
     *  tagged with this identifier, instead of a normal release - same idea as `npm version
     *  <type> --preid <name>`. A group already sitting on a matching prerelease (same identifier)
     *  just has its prerelease counter incremented instead of jumping to a new base version - see
     *  `incVersion`. Has no effect when `bump` is an explicit semver version rather than a keyword
     *  (there's no severity left to "pre-fix" at that point). */
    preid?: string;
    /** Overrides the npm registry lookup `detectChangeHash` falls back to for a package that has
     *  no release tag yet - mainly for tests, so they don't depend on network access or a real
     *  published package. Same shape as `ChangelogService.Deps`/`PublishService.Deps`' own. */
    npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>;
    /** Clock behind a monorepo root's calendar release version - injectable so tests are
     *  deterministic. Default `() => new Date()`. */
    now?: () => Date;
  }

  export interface ApplyOptions {
    /** Push the resulting commit(s) and tag(s) to the remote once applied. Default false - same
     *  as a plain `npm version`, which never pushes on its own either. */
    push?: boolean;
    /** Overrides `.rmanrc version.commitMessage` (and the built-in default) for every group's
     *  commit this run produces - `{version}` is still substituted the same way. */
    message?: string;
    /** Also writes each bumped package's `CHANGELOG.md` (via `ChangelogService.generateToFile`,
     *  scoped to just the packages this run actually bumped) and folds those file changes into the
     *  same per-group commit, instead of requiring a separate `rman changelog --write` run. */
    changelog?: boolean;
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
   * Computes what a version bump *would* do, across every package `.rmanrc group` puts together -
   * never writes anything (no package.json edits, no git commits/tags) and safe to call any time,
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
   * sets the group's severity to the highest found among changed members; the new version
   * is that current version bumped by that severity. Which members actually receive it depends on
   * the severity: **patch** only the changed member(s) (a caret dependency range already tolerates
   * a patch bump, no republish needed downstream); **minor** also every transitive in-group
   * dependent; **major** the entire group, changed or not - see `computeGroupPlan`.
   *
   * Across groups: a package depending on another group's bumped package always gets exactly a
   * **patch** bump of its own (never inheriting the source's severity) - the dependency reference
   * itself is the only thing that changed for it. This never re-triggers *its own* group's
   * minor/major cascade (a patch never cascades), but can itself ripple into a third group, and so
   * on, until nothing new is affected - see `rippleCrossGroup`.
   *
   * A monorepo's root package is never a real member of any group (it's never published on its
   * own) - it gets one trailing entry instead, carrying the repository's own release identity: the
   * single group's version when there is one, a calendar version once there are several - see
   * `buildRootEntry`.
   *
   * "Since its own last release" is resolved by the shared `detectChangeHash` - the same boundary
   * `changelog` measures from, so the two never disagree about which commits are unreleased.
   */
  export async function getPlan(repository: Repository, options: Options = {}): Promise<Entry[]> {
    const bump = options.bump?.trim();
    const explicitSeverity = bump && isBumpKeyword(bump) ? bump : undefined;
    const explicitVersion = bump && !explicitSeverity ? (semver.valid(bump) ?? undefined) : undefined;
    if (bump && !explicitSeverity && !explicitVersion) {
      throw new Error(`Invalid "bump": "${bump}" (expected "patch", "minor", "major", or a valid semver version)`);
    }

    const git = new GitHelper({ cwd: repository.dirname });
    const packages = filterPackages(repository.getPackages(), options);

    const dirtyFiles = await git.listDirtyFiles({ absolute: true });
    const isDirty = (pkg: Package) => dirtyFiles.some(f => !path.relative(pkg.dirname, f).startsWith('..'));

    const entries = new Map<string, Entry>();
    const eligible: Package[] = [];
    for (const pkg of packages) {
      if (isDirty(pkg)) {
        entries.set(pkg.name, {
          package: pkg,
          groupKey: resolveGroupKey(pkg),
          group: groupLabel(resolveGroupKey(pkg)),
          status: options.ignoreDirty ? 'skip' : 'error',
          from: pkg.version,
          reason: 'uncommitted local changes',
        });
        continue;
      }
      eligible.push(pkg);
    }

    const commitMessage = repository.rootPackage.config?.version?.commitMessage;
    const changeByPackage = new Map<string, { severity?: BumpKeyword; reason: string }>();
    await Promise.all(
      eligible.map(async pkg => {
        if (explicitVersion) {
          changeByPackage.set(pkg.name, { severity: undefined, reason: `explicit version ${explicitVersion}` });
          return;
        }
        const since = await detectChangeHash(git, pkg, { npmViewVersion: options.npmViewVersion });
        const commits = since ? await git.listCommits({ hash: since }) : await git.listAllCommits();
        const belongsToPkg = (c: CommitInfo) => c.files.some(f => !path.relative(pkg.dirname, f).startsWith('..'));
        const real = commits.filter(c => belongsToPkg(c) && !isReleaseCommit(c.subject, commitMessage));
        if (!real.length) return;
        changeByPackage.set(pkg.name, {
          severity: explicitSeverity ?? detectSeverity(real),
          reason: since ? `changed since ${since}` : 'unreleased commits',
        });
      }),
    );

    const groups = new Map<string, Package[]>();
    for (const pkg of eligible) {
      const key = resolveGroupKey(pkg);
      const list = groups.get(key);
      if (list) list.push(pkg);
      else groups.set(key, [pkg]);
    }

    for (const [key, members] of groups) {
      computeGroupPlan(key, members, changeByPackage, explicitVersion, options.preid, entries);
    }

    rippleCrossGroup(packages, entries, options.preid);

    const result = packages.map(pkg => entries.get(pkg.name)!);
    if (repository.monorepo) {
      result.push(
        buildRootEntry(repository, result, {
          groupCount: groups.size,
          lastReleaseVersion: await findLastReleaseVersion(git, repository.rootPackage),
          now: options.now ?? (() => new Date()),
        }),
      );
    }
    return result;
  }

  /**
   * Same as `getPlan`, and additionally writes every `'bump'` entry's new version into its own
   * `package.json` (and refreshes any other bumped package's dependency range on it), runs that
   * package's `version.preScript`/`.script`/`.postScript` (or its own real `preversion`/`version`/
   * `postversion` npm scripts) around the write, then commits and tags **once per group** - so
   * independently-versioned groups each get their own clean commit/tag rather than one entangled
   * commit spanning unrelated version lines. Pushes only when `options.push` is set - same as a
   * plain `npm version`, this never reaches the network on its own otherwise.
   */
  export async function applyPlan(repository: Repository, plan: Entry[], options: ApplyOptions = {}): Promise<Entry[]> {
    const git = new GitHelper({ cwd: repository.dirname });
    // The root's own entry is only ever a real package to write/commit like any other when this
    // *isn't* a monorepo (see `getPlan`) - in a monorepo it's the separate, purely informational
    // entry handled below instead, since it's never published on its own.
    const isRealEntry = (e: Entry) => !(repository.monorepo && e.package === repository.rootPackage);
    const bumped = plan.filter(e => e.status === 'bump' && isRealEntry(e));
    const bumpedByName = new Map(bumped.map(e => [e.package.name, e]));
    /** Repo-relative paths of every file stamped with the new version below (a Dockerfile label, a
     *  source constant), so each lands in the same commit as the bump that made it stale - keyed by
     *  package, the way `changelogFileByPackage` is. */
    const stampedByPackage = new Map<string, string[]>();

    for (const entry of bumped) {
      const pkg = entry.package;
      /** The scope these hooks are evaluated against - the only place `${{ pkg.targetVersion }}`
       *  can mean anything, and the reason `DEFERRED_PATHS` left them raw until now. */
      const scope = repository.configScope(pkg, { targetVersion: entry.to! });
      await runVersionScript(pkg, 'before', 'preversion', scope);
      pkg.json.version = entry.to;
      for (const depKey of DEPENDENCY_KEYS) {
        const deps = pkg.json[depKey];
        if (!deps) continue;
        for (const depName of Object.keys(deps)) {
          const depEntry = bumpedByName.get(depName);
          if (!depEntry) continue;
          const workspace = parseWorkspaceRange(deps[depName]);
          if (workspace) {
            // A bare "workspace:*"/"^"/"~" selector always resolves to the dependency's *current*
            // version at publish time (see `resolveWorkspaceRange`) - nothing to rewrite here. Only
            // an explicit version/range after "workspace:" needs bumping, same as a plain range.
            if (workspace.selector === 'explicit') deps[depName] = `workspace:^${depEntry.to}`;
            continue;
          }
          deps[depName] = '^' + depEntry.to;
        }
      }
      await runVersionScript(pkg, 'exec', 'version', scope);
      pkg.writeJson();
      // Before `postversion`, so a script that reacts to the bump sees the whole new state.
      const stamped = [stampDockerfile(pkg, entry.to!), ...stampSourceFiles(pkg, entry.to!)].filter(
        (f): f is string => !!f,
      );
      if (stamped.length) {
        stampedByPackage.set(
          pkg.name,
          stamped.map(f => path.relative(repository.dirname, f)),
        );
      }
      await runVersionScript(pkg, 'after', 'postversion', scope);
    }

    const rootEntry = repository.monorepo ? plan.find(e => e.package === repository.rootPackage) : undefined;
    if (rootEntry?.status === 'bump') {
      repository.rootPackage.json.version = rootEntry.to;
      repository.rootPackage.writeJson();
    }

    /** Written before the per-group commits below so each group's changelog file lands in the
     *  *same* commit as its version bump, rather than needing a separate `changelog --write` run.
     *  Bounded by each package's own *pre-bump* tag (the same one `getPlan` measured "changed
     *  since" from - see `expandTag`) rather than `changelog`'s own default auto-detection (an npm
     *  registry lookup, falling back to not-yet-pushed commits) - that boundary can drift from the
     *  one `version` itself just used, and the not-yet-pushed fallback needs a configured remote
     *  `version` never required at all. Falls back to `changelog`'s own default only when this
     *  package genuinely has no prior tag (a first-ever release). */
    const changelogFileByPackage = new Map<string, string>();
    if (options.changelog) {
      for (const entry of bumped) {
        const fromTag = expandTag(entry.package, entry.from);
        const from = (await git.tagExists(fromTag)) ? fromTag : undefined;
        const changelogEntries = await ChangelogService.generateToFile(repository, {
          scope: entry.package.name,
          root: true,
          from,
          // The tag for this release doesn't exist yet (it's created below), so changelog's own
          // tag-derived version would resolve to the *previous* release and label the entry with it.
          version: entry.to,
          // version doesn't consult "publish.skip" at all (a package can still be meaningfully
          // versioned/changelogged without ever being published) - this entry was already decided
          // to bump, so its folded-in changelog shouldn't then be silently dropped by that flag.
          includeSkipped: true,
        });
        for (const ce of changelogEntries) {
          changelogFileByPackage.set(
            ce.package.name,
            path.relative(repository.dirname, path.join(ce.package.dirname, ce.filePath)),
          );
        }
      }
    }

    /** The root's own informational version write isn't part of any group's release, but still
     *  needs to land in *some* commit rather than being left as an uncommitted local edit. Committed
     *  *before* the group commits, so the last commit this makes is always a tagged release commit -
     *  otherwise the tag sits one commit behind HEAD and every `git tag --points-at HEAD` consumer
     *  (CI capturing the tag it just released, say) comes up empty in a monorepo. */
    if (rootEntry?.status === 'bump') {
      await git.commit(
        [path.relative(repository.dirname, repository.rootPackage.jsonFileName)],
        `chore: sync root version to ${rootEntry.to}`,
      );
    }

    const byGroup = new Map<string, Entry[]>();
    for (const entry of bumped) {
      const list = byGroup.get(entry.groupKey);
      if (list) list.push(entry);
      else byGroup.set(entry.groupKey, [entry]);
    }
    for (const [, groupEntries] of byGroup) {
      const files = groupEntries.map(e => path.relative(repository.dirname, e.package.jsonFileName));
      for (const e of groupEntries) {
        const changelogFile = changelogFileByPackage.get(e.package.name);
        if (changelogFile) files.push(changelogFile);
        files.push(...(stampedByPackage.get(e.package.name) ?? []));
      }
      await git.commit(files, buildCommitMessage(repository, groupEntries, options.message));
      const tags = new Set(groupEntries.map(e => expandTag(e.package, e.to!)));
      for (const tag of tags) if (!(await git.tagExists(tag))) await git.createTag(tag);
    }

    /** A repository release tag, on top of the per-group ones - but only once the root is on a
     *  calendar version. With a single version line the group's own tag already *is* the release
     *  (same version, same commit), and a second name for it would only add noise to every existing
     *  repo's tag space. Created last, so it lands on HEAD rather than behind whichever group
     *  happened to be committed last. */
    if (rootEntry?.status === 'bump' && isCalendarVersion(rootEntry.to!)) {
      const releaseTag = expandReleaseTag(repository.rootPackage, rootEntry.to!);
      if (await git.tagExists(releaseTag)) {
        throw new Error(
          `Release tag "${releaseTag}" already exists - a second release within the same minute. ` +
            'Wait a moment and run again.',
        );
      }
      await git.createTag(releaseTag);
    }

    if (options.push && bumped.length) await git.push();
    return plan;
  }
}

/** Every `package.json` field holding dependency ranges - shared with `PublishService`'s own
 *  `"workspace:"` rewrite-for-publish step, since it needs to scan the same fields. */
export const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

const SEVERITY_RANK: Record<VersionService.BumpKeyword, number> = { patch: 0, minor: 1, major: 2 };

/** `.rmanrc group` (cascaded): `true` (the default - see `resolveConfig`'s cascade, this is what a
 *  package inherits when nobody sets it at all) puts a package in the one implicit repo-wide
 *  group; a non-empty string joins exactly the other packages sharing that string, regardless of
 *  the repo's own default; `false` makes it a solo group of one. */
function resolveGroupKey(pkg: Package): string {
  const g = pkg.config?.group;
  if (g === false) return `solo:${pkg.name}`;
  if (typeof g === 'string' && g) return `named:${g}`;
  return 'default';
}

function groupLabel(key: string): string {
  if (key.startsWith('named:')) return key.slice('named:'.length);
  if (key.startsWith('solo:')) return key.slice('solo:'.length);
  return key;
}

/**
 * Highest bump type implied by `commits`: a `Release-As: patch|minor|major` footer (see
 * `parseReleaseAs`) replaces what that one commit's own subject/footers would otherwise imply,
 * entirely - the escape hatch for e.g. a `feat:` that needs to ship as a patch right now, without
 * waiting for the rest of a minor's worth of work. Absent that, a `!` marker or a `BREAKING
 * CHANGE:` footer wins outright; otherwise `feat` implies minor; anything else (a `fix`, an
 * unrecognized type, a non-conventional message) defaults to patch - something changed, so at
 * least a patch release is warranted.
 */
function detectSeverity(commits: CommitInfo[]): VersionService.BumpKeyword {
  let severity: VersionService.BumpKeyword = 'patch';
  for (const c of commits) {
    const override = parseReleaseAs(c.body);
    if (override === 'major') return 'major';
    if (override) {
      if (SEVERITY_RANK[override] > SEVERITY_RANK[severity]) severity = override;
      continue;
    }
    const parsed = parseConventionalCommit(c.subject);
    if (parsed?.breaking || hasBreakingChangeFooter(c.body)) return 'major';
    if (parsed?.type === 'feat') severity = 'minor';
  }
  return severity;
}

function maxVersion(versions: string[]): string {
  return versions.reduce((m, v) => (semver.gt(v, m) ? v : m), versions[0]);
}

/**
 * `semver.inc`, "pre-ified" when `preid` is given: `current` already sitting on a prerelease with
 * that *same* identifier just has its prerelease counter incremented (`'prerelease'`, e.g.
 * `1.2.3-beta.0` -> `1.2.3-beta.1`) rather than jumping to a new base version every time this
 * runs again during the same beta/rc cycle; anything else (a plain release, or a prerelease under
 * a *different* identifier - switching from `beta` to `rc`, say) starts a fresh prerelease of
 * `severity`'s own type (`'prepatch'`/`'preminor'`/`'premajor'`, e.g. `1.2.3` -> `1.3.0-beta.0`
 * for a `minor`). Without `preid`, this is just `semver.inc(current, severity)`.
 */
function incVersion(current: string, severity: VersionService.BumpKeyword, preid: string | undefined): string {
  if (!preid) return semver.inc(current, severity) ?? current;
  const existing = semver.prerelease(current);
  const releaseType = existing && String(existing[0]) === preid ? 'prerelease' : (`pre${severity}` as const);
  return semver.inc(current, releaseType, preid) ?? current;
}

/**
 * Decides one group's new version and which of its members actually receive it, writing an
 * `Entry` per member into `entries`. `changeByPackage` holds each eligible package's own detected
 * severity (or `undefined` for one with no real commits since its last tag) - `undefined` here
 * always means "unchanged", never "explicit version" (that path is handled separately below).
 */
function computeGroupPlan(
  key: string,
  members: Package[],
  changeByPackage: Map<string, { severity?: VersionService.BumpKeyword; reason: string }>,
  explicitVersion: string | undefined,
  preid: string | undefined,
  entries: Map<string, VersionService.Entry>,
): void {
  const label = groupLabel(key);
  const changed = members.filter(m => changeByPackage.has(m.name));
  if (!changed.length) {
    for (const m of members) {
      entries.set(m.name, { package: m, groupKey: key, group: label, status: 'no-change', from: m.version });
    }
    return;
  }

  const current = maxVersion(members.map(m => m.version));
  let to: string;
  let severity: VersionService.BumpKeyword | undefined;
  if (explicitVersion) {
    to = explicitVersion;
  } else {
    severity = changed.reduce<VersionService.BumpKeyword>((worst, m) => {
      const s = changeByPackage.get(m.name)!.severity!;
      return SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst;
    }, 'patch');
    to = incVersion(current, severity, preid);
  }

  const bumping = new Set<Package>(changed);
  if (!explicitVersion && severity === 'major') {
    for (const m of members) bumping.add(m);
  } else if (!explicitVersion && severity === 'minor') {
    const worklist = [...changed];
    while (worklist.length) {
      const cur = worklist.pop()!;
      for (const m of members) {
        if (bumping.has(m)) continue;
        if (m.dependencies.includes(cur.name)) {
          bumping.add(m);
          worklist.push(m);
        }
      }
    }
  }

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
        reason: own?.reason ?? `in-group dependent of a ${severity} change`,
      });
    } else {
      entries.set(m.name, { package: m, groupKey: key, group: label, status: 'no-change', from: m.version });
    }
  }
}

/**
 * A package depending on another group's bumped package always receives exactly a patch bump of
 * its own, computed from its *own* group's current ceiling (the highest `to`/version among its
 * group right now) - never the source's version, and never the source's severity. Runs as a
 * worklist until nothing new is affected, since patching one package can itself cross into a third
 * group, and so on; never touches a same-group dependent that a plain patch deliberately left
 * alone (see `computeGroupPlan`'s patch case).
 */
function rippleCrossGroup(
  packages: Package[],
  entries: Map<string, VersionService.Entry>,
  preid: string | undefined,
): void {
  const worklist = [...entries.values()].filter(e => e.status === 'bump');
  while (worklist.length) {
    const source = worklist.shift()!;
    for (const pkg of packages) {
      const entry = entries.get(pkg.name)!;
      if (entry.status === 'bump' || entry.groupKey === source.groupKey) continue;
      if (!pkg.dependencies.includes(source.package.name)) continue;

      const groupCeiling = maxVersion(
        packages
          .filter(p => entries.get(p.name)!.groupKey === entry.groupKey)
          .map(p => entries.get(p.name)!.to ?? p.version),
      );
      const next: VersionService.Entry = {
        ...entry,
        status: 'bump',
        to: incVersion(groupCeiling, 'patch', preid),
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
function buildRootEntry(
  repository: Repository,
  memberEntries: VersionService.Entry[],
  context: { groupCount: number; lastReleaseVersion?: string; now: () => Date },
): VersionService.Entry {
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
  const to = calendar ? formatCalendarVersion(context.now()) : maxVersion(finalVersions);
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

/** `.rmanrc version.commitMessage` (root-level; `{version}` is replaced when every bumped package
 *  in this commit shares one version) - defaults to `"chore(release): v{version}"`, or a plain
 *  listing of `name@version` pairs when this particular commit spans different versions (a
 *  cross-group ripple can land a lone forced patch in a group that otherwise didn't move). */
function buildCommitMessage(repository: Repository, entries: VersionService.Entry[], messageOverride?: string): string {
  const versions = new Set(entries.map(e => e.to));
  if (versions.size === 1) {
    const template = messageOverride ?? repository.rootPackage.config?.version?.commitMessage;
    const version = entries[0].to!;
    if (typeof template === 'string' && template) return template.replace(/\{version\}/g, version);
    return `chore(release): v${version}`;
  }
  if (messageOverride) return messageOverride;
  return `chore(release): ${entries.map(e => `${e.package.name}@${e.to}`).join(', ')}`;
}

/** A `version.<key>` value: one command, or several to run in sequence - same shape as
 *  `run.<script>.script`/`.preScript`/`.postScript`. */
function normalizeScriptValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === 'string' && !!v);
    return parts.length ? parts.join(' && ') : undefined;
  }
  return undefined;
}

/**
 * Runs `pkg`'s own real npm lifecycle script (`preversion`/`version`/`postversion`) if it defines
 * one for this phase, otherwise its `.rmanrc version.<cfgKey>` equivalent if configured - neither
 * replaces the version write itself (unlike `ci`'s own-script override), they're hooks around a
 * write that always happens, since dependency ranges and tags depend on it happening consistently.
 */
async function runVersionScript(
  pkg: Package,
  cfgKey: 'before' | 'exec' | 'after',
  npmScriptName: 'preversion' | 'version' | 'postversion',
  scope: ConfigScope,
): Promise<void> {
  const own = pkg.json.scripts?.[npmScriptName];
  /** Read from `rawConfig` and evaluated here: these three paths are in `DEFERRED_PATHS`, left
   *  alone when the repository loaded because `pkg.targetVersion` did not exist yet. `scope` has it
   *  bound, so a hook can name the version about to be written. */
  const configured = interpolateConfig(pkg.rawConfig?.version?.[cfgKey], scope);
  const command = typeof own === 'string' && own ? own : normalizeScriptValue(configured);
  if (command) await exec(command, { cwd: pkg.dirname, stdio: 'inherit' });
}

/**
 * Keeps a package's Dockerfile `org.opencontainers.image.version` label in step with the version
 * just written, returning the absolute path when it actually changed (so the caller can fold it
 * into the same commit) and `undefined` otherwise.
 *
 * Here rather than in a build script: the label is a *statement of the package's version*, so it
 * belongs to whatever writes that version - which keeps it in the bump commit, leaves the tree
 * clean, and makes it right for anyone building the Dockerfile by hand. A build-time rewrite is
 * both later than it needs to be and invisible to git.
 *
 * The same path `publish --target docker` builds from (`publish.docker.dockerfile`, default
 * `Dockerfile`), so the two can never disagree about which file this is. Opt out with `.rmanrc
 * "version": { "stampDockerfile": false }`; a package with no Dockerfile, or one that doesn't
 * declare the label, is a no-op either way.
 */
function stampDockerfile(pkg: Package, version: string): string | undefined {
  if (pkg.config?.version?.stampDockerfile === false) return undefined;
  const file = path.resolve(pkg.dirname, pkg.config?.publish?.docker?.dockerfile || 'Dockerfile');
  if (!fs.existsSync(file)) return undefined;
  const stamped = stampVersionLabel(fs.readFileSync(file, 'utf-8'), version);
  if (stamped === undefined) return undefined;
  fs.writeFileSync(file, stamped, 'utf-8');
  return file;
}

/**
 * Keeps every `.rmanrc "version.stamp"` source file's `version` constant in step with the version
 * just written, returning the absolute paths of the ones that actually changed.
 *
 * Explicitly listed rather than discovered: unlike the OCI Dockerfile label there is no standard
 * saying "this file holds the version", and the assignment this matches is deliberately broad. A
 * listed file a package doesn't have is a silent no-op, which is what lets one `"[*]"` declaration
 * cover a repo where only some packages carry one.
 */
function stampSourceFiles(pkg: Package, version: string): string[] {
  const configured = pkg.config?.version?.stamp;
  const patterns = typeof configured === 'string' ? [configured] : (configured ?? []);
  const stamped: string[] = [];
  for (const rel of patterns) {
    const file = path.resolve(pkg.dirname, rel);
    if (!fs.existsSync(file)) continue;
    const next = stampVersionConstant(fs.readFileSync(file, 'utf-8'), version);
    if (next === undefined) continue;
    fs.writeFileSync(file, next, 'utf-8');
    stamped.push(file);
  }
  return stamped;
}
