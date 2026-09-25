import fs from 'node:fs';
import path from 'node:path';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { Service } from '../core/service.js';
import { type CommitInfo, GitHelper } from '../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { ChangeHashService } from './change-hash.service.js';
import { ConventionalCommitsService } from './conventional-commits.service.js';

/**
 * A service class - see `ListService` for the shape and `Service` for the three measured
 * consequences a namespace had. `repository` left the signature because the application carries it.
 */
export class ChangelogService extends Service {
  /**
   * Same as `getEntries`, and additionally - for every returned entry, when `options.write` is
   * set - prepends `entry.content` into that package's own changelog file (see `ChangelogService.Entry.filePath`).
   * Still pure with respect to console output: writing a file is a real, callable-for-its-own-
   * sake side effect (a "save this" request), not presentation, so it stays here rather than in
   * the CLI command - printing what happened is the command's job.
   */
  async generateToFile(options: ChangelogService.Options = {}): Promise<ChangelogService.Entry[]> {
    const entries = await this.getEntries({ ...options, write: true });
    /**
     * **Where each file is documented up to, recorded in the file itself.** Read back by
     * `resolveBoundary` on the next run, which is what makes a second `--write` append the commits
     * since this one rather than re-emitting everything since the last tag.
     *
     * **Each entry's own last commit, not HEAD** - and that distinction is not bookkeeping.
     * Measured with HEAD: under `changelog.unreleased: false` the run wrote the released history
     * and then marked the file as documented up to HEAD, so the commits it had deliberately *not*
     * written fell behind the boundary. The release that followed found nothing after the marker
     * and produced no entry at all - the work silently gone from the changelog for good.
     *
     * Entries are ordered oldest first and each prepend rewrites the one marker, so the last write
     * for a file leaves the newest documented commit behind it.
     */
    for (const entry of entries) {
      prependToChangelogFile(entry.package, entry.filePath, entry.content, entry.documentedUpTo);
    }
    return entries;
  }

  /**
   * Computes a changelog entry per package (root included) from real commits only - either
   * everything since a given `--from <hash>` (applied the same way to every package), or, by
   * default, auto-detected per package instead (see `detectChangeHash`). Pure: returns the
   * entries, never prints or touches `CHANGELOG.md` - see `generate` for that.
   *
   * A commit is attributed to every package its files fall under (root included, for anything
   * outside every package) - unless it's broad enough to count as a repo-wide change (see
   * `BROAD_COMMIT_THRESHOLD`/`ownersOf`), in which case it goes to root alone instead of being
   * repeated verbatim across most of the repository. Subject lines are grouped ✨ Features/🐛 Bug
   * Fixes/🔧 Other Changes on a best-effort Conventional Commits read; anything that doesn't parse
   * just lands in Other Changes as-is, so a repo that doesn't follow that convention still gets a
   * usable list. `.rmanrc changelog.ignoreTypes` (cascaded, e.g. `[chore, dev]`) drops commits of
   * those types entirely instead - see `ignoreTypesConfig`. A release marker - a bare version-bump
   * commit (`"6.0.1"`), or any of the messages `version` itself writes - is always dropped
   * outright, regardless of `ignoreTypes`; see `isReleaseCommit`.
   *
   * By default (or with `--from npm` explicitly), the boundary is auto-detected per package
   * instead of one shared one - see `detectChangeHash`. A package that can't be resolved this way
   * (unpublished, no network, no matching tag) has never been released at all, so its whole
   * history counts as unreleased - the same view `version` takes, so a first-ever release still
   * produces a real changelog. Packages that end up resolving to
   * the same hash (an explicit one, or several packages sharing one tag under fixed versioning)
   * only have their commits fetched once, not once per package.
   *
   * Formatting comes from `.rmanrc changelog.template` - a *path* to a template file (not the
   * template text itself, to keep `.rmanrc` readable), with `{{package}}`/`{{version}}`/
   * `{{date}}`/`{{commits}}` (the full grouped block) and `{{features}}`/`{{fixes}}`/`{{other}}`
   * (their bullet lists alone, for templates that want their own headings/order) - see
   * `resolveTemplate`. `{{package}}` for the repository root is `"<repo dir name> repository"`
   * (e.g. "sqb repository"), not its raw package.json name - which is often a private,
   * non-published placeholder (`"sqb.v4"`) that reads like a stray version marker rather than a
   * recognizable label. `{{version}}` comes from git tags, not package.json (which can drift out
   * of sync with what's actually been released) - see `resolveVersion`/`.rmanrc
   * changelog.tagPattern`.
   *
   * Run from inside a single package's own directory, it only covers that package unless
   * `options.fromRoot` says otherwise (see `Repository.currentPackage`).
   */
  async getEntries(options: ChangelogService.Options = {}): Promise<ChangelogService.Entry[]> {
    const repository = this.repository;
    const cwdScope = options.fromRoot ? undefined : repository.currentPackage;
    const packages = repository.getPackages().filter(p => p !== repository.rootPackage);
    const targets = (cwdScope ? [cwdScope] : filterPackages([repository.rootPackage, ...packages], options)).filter(
      pkg => options.includeSkipped || !pkg.config.publish?.skip,
    );

    const git = new GitHelper({ cwd: repository.dirname });
    const commitMessage = repository.rootPackage.config?.version?.commitMessage;
    // dropped up front, not just while grouping - a package whose only commits are release markers
    // should get no entry at all, rather than a heading with nothing real underneath it.
    const dropVersionBumps = (commits: CommitInfo[]) =>
      commits.filter(c => !ConventionalCommitsService.isReleaseCommit(c.subject, commitMessage));

    // Several packages often resolve to the identical hash (an explicit --from <hash> applies to
    // all of them the same way; under fixed versioning, npm auto-detection usually does too) - so
    // the git fetch for a given hash is cached, run once no matter how many packages share it.
    const commitsByHash = new Map<string, Promise<CommitInfo[]>>();
    const listCommitsCached = (hash: string | undefined): Promise<CommitInfo[]> => {
      const key = hash ?? '';
      let promise = commitsByHash.get(key);
      if (!promise) {
        // No boundary at all means nothing has ever been released, so everything so far is
        // unreleased - the same fallback `VersionService` makes. (Not "not yet pushed": that reads
        // as empty the moment a first release is pushed, and for a repo with no remote at all.)
        //
        /**
         * **Release markers are dropped per segment, not here.** A release tag sits on exactly the
         * commit this filter removes, so dropping first leaves `splitByRelease` matching tags
         * against shas that are no longer in the list - every cut silently missed, and the whole
         * range rendered as one release. Measured while writing it.
         */
        promise = hash ? git.listCommits({ hash }) : git.listAllCommits();
        commitsByHash.set(key, promise);
      }
      return promise;
    };

    const commitsByTarget = await Promise.all(
      targets.map(async pkg => {
        const changelogFile = path.join(pkg.dirname, resolveFilePath(pkg, options.filePath));
        const from = await resolveBoundary(git, pkg, changelogFile, options);
        return listCommitsCached(from);
      }),
    );

    const entries: ChangelogService.Entry[] = [];
    for (let i = 0; i < targets.length; i++) {
      const pkg = targets[i];
      const label = pkg === repository.rootPackage ? `${path.basename(repository.dirname)} repository` : pkg.name;

      /**
       * **One entry per release in the range, not one entry per package.** The range is whatever
       * the boundary opened up, and a release tag inside it ends a release: a changelog that does
       * not cut there is not a changelog, it is a commit list. Measured on a real repository - a
       * first `--write` with no changelog file reaches back through twelve tags, and every commit
       * in all of them landed under a single `v2.1.6` heading.
       *
       * Ordinary runs are unaffected by construction: the boundary is the last release, so no tag
       * falls inside the range and there is exactly one segment - which is what `version
       * --changelog` and `github-release` see too, since both pass an explicit boundary.
       */
      const floor = await resolveStartingPoint(git, pkg, options);
      const floorIndex = floor?.sha ? commitsByTarget[i].findIndex(c => c.sha === floor.sha) : -1;
      const withUnreleased = resolveUnreleased(pkg, options);
      const titles = resolveTitles(pkg);
      const order = resolveOrder(pkg, titles);
      for (const segment of await splitByRelease(git, pkg, commitsByTarget[i])) {
        if (!segment.tag && !withUnreleased) continue;
        if (await isBelowStartingPoint(git, pkg, segment, floor, floorIndex)) continue;
        const ownCommits = dropVersionBumps(segment.commits).filter(c => ownersOf(repository, c).has(pkg));
        if (!ownCommits.length) continue;
        const sections = groupCommits(
          ownCommits.map(c => c.subject),
          ignoreTypesConfig(pkg),
          titles,
          order,
        );
        // every commit could have been dropped by ignoreTypes - skip this package's entry entirely
        // rather than rendering a heading with nothing real underneath it.
        if (!sections.length) continue;

        const { version, content } = await renderEntry(
          repository,
          pkg,
          label,
          sections,
          titles,
          git,
          options.version,
          segment.tag,
        );
        entries.push({
          package: pkg,
          label,
          version,
          /** The last commit this entry covers - what the file's marker records. For a tagged
           *  segment that is the release commit itself, so everything up to and including the
           *  release is documented and nothing after it is claimed. */
          documentedUpTo: segment.commits[segment.commits.length - 1]!.sha,
          sections,
          ...legacyBuckets(sections, titles),
          content,
          filePath: resolveFilePath(pkg, options.filePath),
        });
      }
    }
    return entries;
  }
}

interface Section {
  title: string;
  lines: string[];
}

/** `.rmanrc changelog.ignoreTypes` (cascaded, per-package overridable) - Conventional Commits
 *  `type`s to drop entirely (e.g. `[chore, dev]`), not just fold into "Other Changes". Only
 *  applies to commits that actually parse as `type: ...` - a non-conventional message always
 *  still lands in Other Changes, since it has no `type` to match against. */
function ignoreTypesConfig(pkg: Package): Set<string> {
  const v = pkg.config?.changelog?.ignoreTypes;
  return new Set(Array.isArray(v) ? v.map(t => String(t).toLowerCase()) : []);
}

/**
 * **The headings, and the order they come out in** - `.rmanrc changelog.titles`, merged **per key**
 * over the defaults rather than replacing them.
 *
 * Merging is the `vars` rule rather than a new exception, and it is what the shape of the key asks
 * for: naming `dev` adds a section, and should not silently cost a repository its `feat` and `fix`.
 * Renaming `feat` leaves it where it was, so the running order survives a rename. The cost, stated:
 * a default section cannot be *removed* by leaving it out - `changelog.ignoreTypes` is the key that
 * drops a type entirely.
 *
 * `'*'` is the heading for every type nobody named, and is always last however it was declared -
 * a catch-all in the middle of the order would silently swallow the sections after it.
 */
function resolveTitles(pkg: Package): Map<string, string> {
  const titles = new Map(DEFAULT_TITLES);
  const cfg = pkg.config?.changelog?.titles;
  if (cfg && typeof cfg === 'object') {
    for (const [type, title] of Object.entries(cfg)) {
      if (typeof title === 'string' && title) titles.set(type.toLowerCase(), title);
    }
  }
  return titles;
}

/**
 * One list of lines per heading, in the heading order, empty ones dropped.
 *
 * **The type prefix is stripped for every section, not just two.** It used to be `push(line)` for
 * `feat`/`fix` and `push(subject)` for everything else, so Features read `- the first feature`
 * while Other Changes read `- chore: write changelog` - the heading naming the type and the bullet
 * repeating it. With every type able to have a heading of its own that asymmetry has no defence
 * left. A subject that is not Conventional Commits at all has no prefix to strip and is kept whole.
 */
function groupCommits(
  subjects: string[],
  ignoreTypes: Set<string>,
  titles: Map<string, string>,
  order: string[],
): Section[] {
  const CATCH_ALL = '*';
  const byTitle = new Map<string, string[]>();
  const titleFor = (type: string) => titles.get(type) ?? titles.get(CATCH_ALL) ?? DEFAULT_TITLES.get(CATCH_ALL)!;
  const push = (title: string, line: string) => {
    const lines = byTitle.get(title);
    if (lines) lines.push(line);
    else byTitle.set(title, [line]);
  };

  for (const subject of subjects) {
    const parsed = ConventionalCommitsService.parseSubject(subject);
    if (!parsed) {
      push(titleFor(CATCH_ALL), subject);
      continue;
    }
    const { type, scope, description } = parsed;
    if (ignoreTypes.has(type)) continue;
    push(titleFor(type), scope ? `**${scope}:** ${description}` : description);
  }

  /**
   * Only a type with a heading of its own takes a position. A type nobody named resolves to the
   * catch-all, so ordering by it would drag the catch-all to wherever that type was listed -
   * measured: `sortTitles: ['docs', 'fix', 'feat']` with no `docs` heading put "Other Changes"
   * first and swallowed the sections after it.
   */
  const ordered = [...new Set(order.filter(t => t !== CATCH_ALL && titles.has(t)).map(titleFor))];
  ordered.push(titleFor(CATCH_ALL));
  const sections: Section[] = [];
  for (const title of ordered) {
    const lines = byTitle.get(title);
    if (lines?.length) sections.push({ title, lines });
    byTitle.delete(title);
  }
  /** A heading a repository named for a type nobody used is not rendered; one it named that the
   *  ordering above somehow missed still is, rather than being dropped on the floor. */
  for (const [title, lines] of byTitle) if (lines.length) sections.push({ title, lines });
  return sections;
}

/**
 * **The order the sections come out in** - `.rmanrc changelog.sortTitles`, a list of commit types.
 *
 * Separate from `titles` because they are separate decisions. Order used to fall out of the order
 * `titles` was written in, which quietly meant a repository renaming `feat` was also re-deciding
 * where it sits; a key that patches wording should not move things.
 *
 * Types it leaves out keep their place **after** the listed ones, in the order `titles` knows them
 * (the defaults first, then anything the repository added) - it is a sort, not a filter, and
 * `ignoreTypes` is what drops a type. `'*'` is appended by `groupCommits` whatever this says.
 */
function resolveOrder(pkg: Package, titles: Map<string, string>): string[] {
  const cfg = pkg.config?.changelog?.sortTitles;
  const listed = Array.isArray(cfg) ? cfg.map(t => String(t).toLowerCase()) : [];
  return [...new Set([...listed, ...titles.keys()])];
}

/**
 * `features`/`fixes`/`other` derived back out of the sections, for `{{features}}`/`{{fixes}}`/
 * `{{other}}` and for `Entry`'s own three fields.
 *
 * Both were the public surface before headings were configurable, so they keep meaning what they
 * meant: whatever `feat` and `fix` are listed under, and everything else together. A repository
 * that renames those headings still gets them here; one that adds `dev` finds it in `other`, which
 * is the only honest place for it in a shape that has three slots.
 */
function legacyBuckets(sections: Section[], titles: Map<string, string>) {
  const of = (type: string) => sections.find(s => s.title === titles.get(type))?.lines ?? [];
  const features = of('feat');
  const fixes = of('fix');
  const other = sections.filter(s => s.lines !== features && s.lines !== fixes).flatMap(s => s.lines);
  return { features, fixes, other };
}

/** `feat`/`fix`/everything else, which is what rman shipped before `changelog.titles` existed and
 *  so is what a repository that sets nothing still gets, wording and order alike. */
const DEFAULT_TITLES = new Map([
  ['feat', '✨ Features'],
  ['fix', '🐛 Bug Fixes'],
  ['*', '🔧 Other Changes'],
]);

function bulletList(lines: string[]): string {
  return lines.map(l => `- ${l}`).join('\n');
}

function renderCommitsBlock(sections: Section[]): string {
  return sections.map(s => `### ${s.title}\n\n${bulletList(s.lines)}`).join('\n\n');
}

/**
 * **`{{title}}`, not `{{package}} {{version}}`** - an entry that a release tag closes is headed by
 * that tag, because the tag is what it describes.
 *
 * The old heading was assembled out of two things that do not always belong together, and the
 * repository root is where that showed: `## panates-javascript repository 2.1.6 (2026-04-30)`
 * states a version the repository does not have - its root package was `panates-style` at `0.0.5`,
 * and `2.1.6` was read off the `v2.1.6` tag. It also reads as one package's notes when the tag
 * covers the whole repository.
 *
 * `{{package}}`, `{{version}}` and `{{tag}}` are all still bound, so a repository that wants the
 * old shape - or the package's name kept beside the tag - writes its own `changelog.template`.
 */
const DEFAULT_TEMPLATE = '## {{title}} ({{date}})\n\n{{commits}}\n';

/** `.rmanrc changelog.template` is a *path* to a template file (resolved relative to the
 *  repository root, regardless of which level's `.rmanrc` declared it), not the template text
 *  itself - keeping multi-line Markdown out of `.rmanrc` so it stays readable. Falls back to a
 *  small built-in template when unset. */
function resolveTemplate(repository: Repository, pkg: Package): string {
  const templatePath = pkg.config?.changelog?.template;
  if (typeof templatePath !== 'string' || !templatePath) return DEFAULT_TEMPLATE;
  const abs = path.resolve(repository.dirname, templatePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`changelog.template not found for "${pkg.name}": "${templatePath}" (resolved to "${abs}")`);
  }
  return fs.readFileSync(abs, 'utf-8');
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

const DEFAULT_CHANGELOG_FILE = 'CHANGELOG.md';

/** Where `write` prepends this package's entry, relative to its own directory. An explicit
 *  `optionsFilePath` (`Changelog.Options.filePath`, CLI `--file-path`) applies the same way to
 *  every package and wins over `.rmanrc changelog.filePath` (cascaded, per-package overridable),
 *  which in turn wins over the default `'CHANGELOG.md'`. */
/**
 * Whether the commits that are not released yet get an entry of their own - `.rmanrc
 * changelog.unreleased`, or the flag, **defaulting to `true`**.
 *
 * `auto-changelog` defaults the equivalent off, and the opposite default here is not an oversight:
 * that tool documents a finished history, while `rman changelog` exists to answer what is *not*
 * released yet, down to the message it prints when there is none. Off by default would make the
 * common case need a flag.
 *
 * **A named release is never dropped by it.** `options.version` means the caller is describing the
 * release it is about to cut - `version --changelog` writes that entry before it commits and tags,
 * so the segment is only "unreleased" for the few seconds until it is. Without this, a repository
 * setting `unreleased: false` would find its releases silently documenting nothing.
 */
function resolveUnreleased(pkg: Package, options: ChangelogService.Options): boolean {
  if (options.version) return true;
  const cfg = pkg.config?.changelog?.unreleased;
  return options.unreleased ?? (typeof cfg === 'boolean' ? cfg : true);
}

/**
 * **Where this package's changelog begins** - `.rmanrc changelog.startingAt`, or the CLI flag,
 * which wins as everywhere.
 *
 * The need is a package whose early development is noise: a first `--write` reaches back through
 * every release there has ever been, and for something that has shipped for years most of that is
 * not what a changelog is for. `auto-changelog` spells this as two options, `--starting-version`
 * and `--starting-date`; one key taking whichever form the answer has reads better, and admits a
 * third that neither covers - a commit, for a package whose history does not begin at a tag.
 *
 * **Three forms, decided in this order**, because the shapes overlap and a rule nobody can see is
 * a trap:
 *
 * 1. `YYYY-MM-DD` - a date. Checked first because that shape is unambiguous.
 * 2. a **version or release tag** - `2.0.0`, `v2.0.0`, `@scope/pkg@2.0.0` all resolve to a version,
 *    so a repository does not have to know which spelling this key wants.
 * 3. a **commit** anything else git can resolve.
 *
 * A string that is none of the three is a configuration mistake and says so, naming all three. The
 * one genuine collision is a tag whose name is also hex (`deadbee`): the tag wins, because a
 * repository that named a tag that has said what it means.
 *
 * **Not `--from`.** That is this run's boundary, applies identically to every package and overrides
 * detection; this is a lasting fact about one package, cascaded like any other config key, and
 * still holds on the run after next. They read alike for a commit and are not the same thing.
 */
async function resolveStartingPoint(
  git: GitHelper,
  pkg: Package,
  options: ChangelogService.Options,
): Promise<StartingPoint | undefined> {
  const cfg = pkg.config?.changelog?.startingAt;
  const value = options.startingAt ?? (typeof cfg === 'string' ? cfg : '');
  if (!value) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };

  if (pkg.versionScheme.isValid(value)) return { version: value };
  const asTagVersion = ChangeHashService.extractVersion(
    value,
    ChangeHashService.tagPattern(pkg).replace('{name}', pkg.name),
  );
  if (pkg.versionScheme.isValid(asTagVersion)) return { version: asTagVersion };

  const sha = await git.resolveCommit(value);
  if (sha) return { sha };

  throw new Error(
    `Invalid "changelog.startingAt" for "${pkg.name}": "${value}" is not a ${pkg.versionScheme.name} ` +
      'version or release tag, a YYYY-MM-DD date, or a commit in this repository',
  );
}

interface StartingPoint {
  version?: string;
  date?: string;
  sha?: string;
}

/**
 * Whether this segment's release falls below the floor, and so is left out.
 *
 * **Only a tagged segment can**, and that is the rule rather than an edge case: the unreleased
 * segment is happening now, so no past floor is above it, and dropping it would hide the very
 * commits the run was asked about.
 *
 * All three forms are **inclusive**, matching `auto-changelog`: naming 2.0.0 keeps 2.0.0, and
 * naming a commit keeps the release that commit belongs to.
 */
async function isBelowStartingPoint(
  git: GitHelper,
  pkg: Package,
  segment: { tag?: string; endIndex: number },
  floor: StartingPoint | undefined,
  floorIndex: number,
): Promise<boolean> {
  if (!floor || !segment.tag) return false;

  if (floor.version) {
    const expanded = ChangeHashService.tagPattern(pkg).replace('{name}', pkg.name);
    const version = ChangeHashService.extractVersion(segment.tag, expanded);
    /** A tag carrying no version the scheme can read is kept - a floor is for leaving out history,
     *  never for losing what it cannot classify. */
    if (pkg.versionScheme.isValid(version) && pkg.versionScheme.compare(version, floor.version) < 0) return true;
  }
  if (floor.date) {
    const date = await git.commitDate(segment.tag);
    if (date && date < floor.date) return true;
  }
  /** The commit's own place in the range decides, so no second git call: a release that ended
   *  before the floor commit is below it. `-1` means the floor is not in this range at all -
   *  older than everything here, so nothing is below it. */
  if (floor.sha && floorIndex >= 0 && segment.endIndex < floorIndex) return true;
  return false;
}

function resolveFilePath(pkg: Package, optionsFilePath?: string): string {
  if (optionsFilePath) return optionsFilePath;
  const cfg = pkg.config?.changelog?.filePath;
  return typeof cfg === 'string' && cfg ? cfg : DEFAULT_CHANGELOG_FILE;
}

/**
 * This package's current version, from git tags rather than its (possibly stale - see the
 * `{{version}}` doc on `Changelog.getEntries`) package.json. Falls back to package.json's version
 * if no matching tag exists at all (never tagged, or a fresh package) - see `findLatestTag`.
 */
/**
 * The version an entry is headed with, **and the date that release actually happened**.
 *
 * The two used to come from different places: the version was read back from the package's latest
 * tag while the date was `new Date()`. So regenerating notes for an already-tagged release headed
 * them with that release's number and *today's* date - measured on a real repository,
 * `## @panates/eslint-config v2.1.6 (2026-09-25)` for a v2.1.6 tagged days earlier. Two halves of
 * one heading describing two different releases.
 *
 * Today's date is still right for the case it was written for: a caller that passes `version`
 * explicitly is describing a release that **does not exist yet** (`version --changelog` writes the
 * entry before it commits and tags), so there is no tag to read a date off and the clock is the
 * only answer. That is why this is decided here, beside the version, rather than at the template.
 */
async function resolveHeading(
  git: GitHelper,
  pkg: Package,
  label: string,
  versionOverride: string | undefined,
  segmentTag: string | undefined,
): Promise<{ version: string; date: string; title: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const expanded = ChangeHashService.tagPattern(pkg).replace('{name}', pkg.name);

  /** A segment that a release tag closes is headed by **that** release, whatever the newest one
   *  is - which is the whole point of splitting, and the reason an override cannot win here: a
   *  caller naming a version is naming the *unreleased* one, the segment with no tag. */
  if (segmentTag) {
    return {
      version: ChangeHashService.extractVersion(segmentTag, expanded),
      date: (await git.commitDate(segmentTag)) ?? today,
      title: segmentTag,
    };
  }

  /**
   * A caller naming the version is naming the one being **prepared** - `version --changelog` writes
   * the entry before it commits and tags. So the heading is the tag that release is about to get,
   * which keeps every heading in the file the same kind of thing, and the date is today because
   * that is when it is happening.
   */
  if (versionOverride) {
    return { version: versionOverride, date: today, title: ChangeHashService.expandTag(pkg, versionOverride) };
  }

  /**
   * **Nothing else is a release**, so nothing else gets a release's heading. This used to read the
   * package's latest tag and use its version *and its date* - so the commits that are not released
   * yet were headed with the number and the day of the release before them. In the repository root
   * that produced `## panates-javascript repository 2.1.6 (2026-04-30)` sitting above the real
   * `## v2.1.6 (2026-04-30)`: the same release named twice, once wrongly.
   *
   * **The label stays in it**, which `Unreleased` alone loses: `rman changelog` prints every
   * package's entry to one stream, and three consecutive `## Unreleased` blocks say nothing about
   * which package each belongs to. Measured - 22 specs caught exactly that.
   *
   * `version` is still what it always was, for a template that wants it - only the heading changed.
   */
  return { version: pkg.version || '', date: today, title: `Unreleased — ${label}` };
}

/**
 * The range cut into releases: each **release tag inside it** closes a segment, and whatever
 * follows the last one is the unreleased segment (`tag: undefined`).
 *
 * Oldest first, because `generateToFile` prepends each entry in turn - so the last one written is
 * the one that ends up at the top of the file.
 *
 * The tagged commit belongs to the segment it **closes**: a release tag sits on the release commit,
 * which comes after the work it releases. That commit is then dropped by `dropVersionBumps` like
 * any other release marker, so it heads the segment without appearing in it.
 *
 * A tag pointing at a commit outside the range simply never matches, which is what should happen -
 * it belongs to a release this run is not describing.
 */
async function splitByRelease(git: GitHelper, pkg: Package, commits: CommitInfo[]): Promise<Segment[]> {
  if (!commits.length) return [];
  const tagBySha = new Map<string, string>();
  for (const pattern of ChangeHashService.releaseTagPatterns(pkg)) {
    /** Earlier patterns win: a package with tags under its own name is described by those, and the
     *  shared `v*` is only there to cover the releases it predates. */
    for (const { tag, sha } of await git.listTagCommits(pattern)) if (!tagBySha.has(sha)) tagBySha.set(sha, tag);
  }
  if (!tagBySha.size) return [{ commits, endIndex: commits.length - 1 }];

  const segments: Segment[] = [];
  let current: CommitInfo[] = [];
  for (const [index, commit] of commits.entries()) {
    current.push(commit);
    const tag = tagBySha.get(commit.sha);
    if (tag) {
      segments.push({ tag, commits: current, endIndex: index });
      current = [];
    }
  }
  if (current.length) segments.push({ commits: current, endIndex: commits.length - 1 });
  return segments;
}

interface Segment {
  tag?: string;
  commits: CommitInfo[];
  /** Where this segment ends in the range it was cut from - what a commit-shaped
   *  `changelog.startingAt` is compared against, with no second git call. */
  endIndex: number;
}

/** The most specific package whose directory contains `file` - the repository root itself as the
 *  fallback for anything outside every package (e.g. root-level config files). Mirrors
 *  `Repository.currentPackage`'s longest-prefix logic, but always resolves to *something*
 *  (root), rather than `undefined`, since every file belongs to some changelog. */
function owningPackage(repository: Repository, file: string): Package {
  let best: Package = repository.rootPackage;
  for (const pkg of repository.packages) {
    const rel = path.relative(pkg.dirname, file);
    const isSelfOrDescendant = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (isSelfOrDescendant && pkg.dirname.length > best.dirname.length) best = pkg;
  }
  return best;
}

/** A commit touching more than this fraction of all packages (a repo-wide relicense, a doc
 *  update stamped into every package's README, ...) is treated as a repo-wide change rather than
 *  attributed to each of them - see `ownersOf`. Without this, one such commit would show up
 *  verbatim in every single package's changelog, making them all look identical. */
const BROAD_COMMIT_THRESHOLD = 0.5;

/** ...but only once at least this many packages are actually touched - without a floor, a repo
 *  with only 1 or 2 packages would have *every* normal commit look "broad" (100% > 50% of a
 *  1-package repo is trivially true), wrongly attributing ordinary changes to root alone. */
const BROAD_COMMIT_MIN_PACKAGES = 3;

/**
 * A commit can touch more than one package at once (or a package plus root-level files) - it's
 * attributed to every package its files map to, not just one. The exception is a commit broad
 * enough to touch at least `BROAD_COMMIT_MIN_PACKAGES` packages *and* more than
 * `BROAD_COMMIT_THRESHOLD` of all of them: that's a repo-wide maintenance change (relicensing, a
 * doc pass across every package, ...), not something that belongs in each package's own release
 * notes individually - it's attributed to the root alone.
 */
function ownersOf(repository: Repository, commit: CommitInfo): Set<Package> {
  const owners = new Set<Package>();
  for (const f of commit.files) owners.add(owningPackage(repository, f));

  const totalPackages = repository.packages.length;
  const nonRootOwners = [...owners].filter(p => p !== repository.rootPackage).length;
  if (
    totalPackages > 0 &&
    nonRootOwners >= BROAD_COMMIT_MIN_PACKAGES &&
    nonRootOwners > totalPackages * BROAD_COMMIT_THRESHOLD
  ) {
    return new Set([repository.rootPackage]);
  }
  return owners;
}

async function renderEntry(
  repository: Repository,
  pkg: Package,
  label: string,
  sections: Section[],
  titles: Map<string, string>,
  git: GitHelper,
  versionOverride: string | undefined,
  segmentTag: string | undefined,
): Promise<{ version: string; content: string }> {
  const template = resolveTemplate(repository, pkg);
  const { version, date, title } = await resolveHeading(git, pkg, label, versionOverride, segmentTag);
  const content = render(template, {
    package: label,
    version,
    tag: segmentTag ?? '',
    title,
    date,
    commits: renderCommitsBlock(sections),
    ...Object.fromEntries(Object.entries(legacyBuckets(sections, titles)).map(([k, v]) => [k, bulletList(v)])),
  });
  return { version, content };
}

/**
 * **Where a changelog file says it is documented up to**, written by `--write` and read back by
 * `resolveBoundary`. An HTML comment, so it renders as nothing at all.
 *
 * The alternative was parsing the topmost version heading back out of the file, and it fails on the
 * one thing this has to survive: `changelog.template` is the *repository's*, so the heading is a
 * shape rman did not choose and cannot reliably read. The other alternative - the file's own last
 * modifying commit - is what `catchUpFile` already does, and it cannot be the boundary because any
 * unrelated edit (a typo, a hand-written note) would move it forward and drop every commit in
 * between, silently.
 */
const MARKER = /^<!-- rman:documented-up-to ([0-9a-f]{7,40}) -->[ \t]*\r?\n+/m;

/**
 * The boundary this package's notes start from.
 *
 * `--from` wins outright, as everywhere. Otherwise, **for a `--write` run only**, the changelog
 * file decides - it is the thing being appended to, so where it stopped is the question:
 *
 * - **A marker** - start there. Measured without it: a second `--write` re-listed every commit
 *   since the last tag on top of the entry that already held them, so one commit appeared twice
 *   under two headings carrying the same version number.
 * - **No file at all** - the whole history, because nothing has been documented. Measured without
 *   it: the first `--write` in a repository with a `v1.0.0` tag documented only the commits *after*
 *   that tag, and the ones before it were never written anywhere and never would be.
 * - **A file with no marker** - one rman did not write, or wrote before markers existed. Fall back
 *   to ordinary detection, which is where `catchUpFile` still earns its place: it widens the tag
 *   boundary backwards to the file's last commit, so a stale changelog catches up rather than
 *   skipping. The next write leaves a marker, so this is the one run that has to guess.
 *
 * A **print** run is deliberately none of this: nothing is being appended, and answering "the notes
 * for this release" with "nothing, it is all documented" would be the wrong question answered.
 */
async function resolveBoundary(
  git: GitHelper,
  pkg: Package,
  changelogFile: string,
  options: ChangelogService.Options,
): Promise<string | undefined> {
  if (options.from && options.from !== ChangeHashService.AUTO) return options.from;

  if (options.write) {
    const exists = fs.existsSync(changelogFile);
    if (!exists) return undefined;
    const marker = MARKER.exec(fs.readFileSync(changelogFile, 'utf-8'));
    if (marker) return marker[1];
  }

  return ChangeHashService.detect(git, pkg, {
    from: options.from,
    catchUpFile: fs.existsSync(changelogFile) ? changelogFile : undefined,
  });
}

/** Prepends `content` right after the top-level "# Changelog" heading if the file already has
 *  one, otherwise creates the file (and any missing parent directory - `relFilePath` can nest one,
 *  e.g. `'docs/CHANGELOG.md'`) with one. Leaves everything already in the file untouched below it. */
function prependToChangelogFile(
  pkg: Package,
  relFilePath: string,
  content: string,
  documentedUpTo: string | undefined,
): void {
  const file = path.join(pkg.dirname, relFilePath);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const headerMatch = /^# Changelog\r?\n+/.exec(existing);
  const header = headerMatch ? headerMatch[0] : '# Changelog\n\n';
  /** The previous marker goes with the header it sat under - there is one per file, rewritten
   *  each time, never accumulated. */
  const rest = (headerMatch ? existing.slice(headerMatch[0].length) : existing).replace(MARKER, '');
  const marker = documentedUpTo ? `<!-- rman:documented-up-to ${documentedUpTo} -->\n\n` : '';
  /** A rule **between** releases, so it is the writer's and not the template's: an entry printed
   *  to stdout, or handed to `github-release` as a body, has nothing below it to be separated
   *  from. Only written when there is something below. */
  const separator = rest.trim() ? '\n---\n\n' : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header + marker + content.trimEnd() + '\n' + separator + rest);
}

export namespace ChangelogService {
  export interface Options extends PackageFilterOptions {
    /** Generate the changelog since this commit/hash - applied the same way to every package.
     *  Default (also `"auto"` explicitly): auto-detect it per package instead, from that package's
     *  own most recent release tag first - the same lookup `VersionService`/`changed` use, so this
     *  never disagrees with them - falling back to whatever its own ecosystem's registry reports
     *  only when it has no tag yet (`Plugin.publishedVersion`, and only ever to guess a
     *  tag name - see `detectChangeHash`); a package this can't be resolved for either way (never
     *  tagged, unpublished, no plugin) has never been released at all, so its whole history counts
     *  as unreleased - the same view `version` takes. */
    from?: string;
    /** Generate for the whole repository even when the current directory is inside a single
     *  package (which otherwise scopes it to just that package) - see `Repository.currentPackage`. */
    fromRoot?: boolean;
    /** Where a package's changelog file lives, relative to *that package's own* directory -
     *  default `'CHANGELOG.md'`. Applies the same way to every package; for a package that wants
     *  its own filename instead, use `.rmanrc changelog.filePath` (cascaded, per-package
     *  overridable) rather than this option - see `resolveFilePath`. Consulted even without
     *  `write`: when auto-detecting, if this file already exists its own last-modifying commit
     *  also lower-bounds the boundary, so a stale file (last updated for an older version than
     *  what's actually published) doesn't get changes silently skipped over - see
     *  `detectChangeHash`'s `catchUpFile`. */
    filePath?: string;
    /** A package with `.rmanrc "publish.skip"` is excluded by default - little point changelogging
     *  something that's never actually released. Set true to generate for it anyway. */
    includeSkipped?: boolean;
    /** The version these entries are being generated *for* - what `{{version}}` renders as.
     *  Without it the version is read back from git tags (see `resolveVersion`), which is only
     *  correct once the release being described has actually been tagged. A caller generating
     *  notes for a release that doesn't exist yet - `version --changelog` writing the entry before
     *  it commits and tags, or a CI step producing release notes ahead of the bump - already knows
     *  the number and has to say so, otherwise every entry ends up labelled with the *previous*
     *  release's version. */
    version?: string;
    /**
     * Set by `generateToFile`; there is no reason for a caller to pass it. It tells `getEntries`
     * that the entries are about to be **appended to a file**, which is what makes the file's own
     * record of where it stopped the right boundary - see `resolveBoundary`. A print run asks a
     * different question and deliberately ignores all of it.
     */
    write?: boolean;
    /** Where this package's changelog begins - a version or release tag, a `YYYY-MM-DD` date, or a
     *  commit. Releases below it are left out. `.rmanrc changelog.startingAt` when omitted; see
     *  `resolveStartingPoint` for how the three forms are told apart. */
    startingAt?: string;
    /** Whether the not-yet-released commits get an entry - `.rmanrc changelog.unreleased` when
     *  omitted, and `true` when neither says. A caller passing `version` always gets it, since that
     *  names the release being cut; see `resolveUnreleased`. */
    unreleased?: boolean;
  }

  /** One package's (root included) generated changelog entry - what `getEntries`/`generate`
   *  return. */
  export interface Entry {
    package: Package;
    /** Display name for this entry's heading - `"<repo dir name> repository"` for the root
     *  package, its own name otherwise (see `getEntries`'s doc comment on `{{package}}`). */
    label: string;
    /** `options.version` when the caller gave one, otherwise resolved from git tags rather than
     *  package.json - see `resolveVersion`. */
    version: string;
    /** The last commit this entry covers. `generateToFile` writes it into the file as the marker
     *  the next run starts from - see `Entry.filePath`. */
    documentedUpTo: string;
    /** Every section this entry renders, in the order it renders them - the heading a repository
     *  chose through `.rmanrc changelog.titles`, and the lines under it. */
    sections: { title: string; lines: string[] }[];
    /** The three buckets `Entry` carried before headings were configurable, derived from
     *  `sections` so they keep meaning what they meant: whatever `feat` and `fix` are listed under,
     *  and everything else together. A repository that adds a section of its own finds it in
     *  `other` - the only honest slot for it in a shape that has three. */
    features: string[];
    fixes: string[];
    other: string[];
    /** The fully rendered entry, via `.rmanrc changelog.template` (or the built-in default). */
    content: string;
    /** Where this entry would be (or, with `options.write`, was) written, relative to the
     *  package's own directory - see `GetOptions.filePath`. */
    filePath: string;
  }
}

declare module '../core/service.js' {
  interface ServiceMap {
    changelog: ChangelogService;
  }
}
