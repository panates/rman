import fs from 'node:fs';
import path from 'node:path';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { detectChangeHash, extractVersion, findLatestTag, tagPattern } from '../utils/change-hash.js';
import { parseConventionalCommit, VERSION_BUMP_PATTERN } from '../utils/conventional-commits.js';
import { type CommitInfo, GitHelper } from '../utils/git.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';

export namespace ChangelogService {
  /** Injectable dependencies shared by `getEntries`/`generate` - currently just the npm registry lookup
   *  `detectChangeHash` otherwise makes for itself; overridable so tests (and advanced callers)
   *  aren't forced through a real network call. */
  export interface Deps {
    npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>;
  }

  export interface Options extends PackageFilterOptions {
    /** Generate the changelog since this commit/hash - applied the same way to every package.
     *  Default (also `"npm"` explicitly): auto-detect it per package instead, from that package's
     *  currently-published npm version (see `detectChangeHash`); a package this can't be resolved
     *  for (unpublished, no network, no matching tag) falls back to its own commits not yet
     *  pushed to the current branch's upstream (same reference point `--changed`/
     *  `--changed-since` use). */
    from?: string;
    /** Generate for the whole repository even when the current directory is inside a single
     *  package (which otherwise scopes it to just that package) - see `Repository.currentPackage`. */
    root?: boolean;
    /** Where a package's changelog file lives, relative to *that package's own* directory -
     *  default `'CHANGELOG.md'`. Applies the same way to every package; for a package that wants
     *  its own filename instead, use `.rmanrc changelog.filePath` (cascaded, per-package
     *  overridable) rather than this option - see `resolveFilePath`. Consulted even without
     *  `write`: when auto-detecting, if this file already exists its own last-modifying commit
     *  also lower-bounds the boundary, so a stale file (last updated for an older version than
     *  what's actually published) doesn't get changes silently skipped over - see
     *  `detectChangeHash`'s `catchUpFile`. */
    filePath?: string;
  }

  /** One package's (root included) generated changelog entry - what `getEntries`/`generate`
   *  return. */
  export interface Entry {
    package: Package;
    /** Display name for this entry's heading - `"<repo dir name> repository"` for the root
     *  package, its own name otherwise (see `getEntries`'s doc comment on `{{package}}`). */
    label: string;
    /** Resolved from git tags, not package.json - see `resolveVersion`. */
    version: string;
    features: string[];
    fixes: string[];
    other: string[];
    /** The fully rendered entry, via `.rmanrc changelog.template` (or the built-in default). */
    content: string;
    /** Where this entry would be (or, with `options.write`, was) written, relative to the
     *  package's own directory - see `GetOptions.filePath`. */
    filePath: string;
  }

  /**
   * Same as `getEntries`, and additionally - for every returned entry, when `options.write` is
   * set - prepends `entry.content` into that package's own changelog file (see `Entry.filePath`).
   * Still pure with respect to console output: writing a file is a real, callable-for-its-own-
   * sake side effect (a "save this" request), not presentation, so it stays here rather than in
   * the CLI command - printing what happened is the command's job.
   */
  export async function generateToFile(
    repository: Repository,
    options: Options = {},
    deps: Deps = {},
  ): Promise<Entry[]> {
    const entries = await getEntries(repository, options, deps);
    for (const entry of entries) prependToChangelogFile(entry.package, entry.filePath, entry.content);
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
   * those types entirely instead - see `ignoreTypesConfig`. A bare version-bump commit
   * (`"6.0.1"`) is always dropped outright, regardless of `ignoreTypes` - see
   * `VERSION_BUMP_PATTERN`.
   *
   * By default (or with `--from npm` explicitly), the boundary is auto-detected per package
   * instead of one shared one - see `detectChangeHash`. A package that can't be resolved this way
   * (unpublished, no network, no matching tag) falls back to its own commits not yet pushed to
   * the current branch's upstream (the same reference point `--changed`/`--changed-since` use
   * elsewhere, via `GitHelper.listCommits`) - so the command still produces something useful even
   * for a repo that's never been published or tagged at all. Packages that end up resolving to
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
   * `options.root` says otherwise (see `Repository.currentPackage`).
   */
  export async function getEntries(repository: Repository, options: Options = {}, deps: Deps = {}): Promise<Entry[]> {
    const cwdScope = options.root ? undefined : repository.currentPackage;
    const packages = repository.getPackages().filter(p => p !== repository.rootPackage);
    const targets = cwdScope ? [cwdScope] : filterPackages([repository.rootPackage, ...packages], options);

    const git = new GitHelper({ cwd: repository.dirname });
    // dropped up front, not just while grouping - a package whose only commits are version bumps
    // should get no entry at all, rather than a heading with nothing real underneath it.
    const dropVersionBumps = (commits: CommitInfo[]) => commits.filter(c => !VERSION_BUMP_PATTERN.test(c.subject));

    // Several packages often resolve to the identical hash (an explicit --from <hash> applies to
    // all of them the same way; under fixed versioning, npm auto-detection usually does too) - so
    // the git fetch for a given hash is cached, run once no matter how many packages share it.
    const commitsByHash = new Map<string, Promise<CommitInfo[]>>();
    const listCommitsCached = (hash: string | undefined): Promise<CommitInfo[]> => {
      const key = hash ?? '';
      let promise = commitsByHash.get(key);
      if (!promise) {
        promise = git.listCommits({ hash }).then(dropVersionBumps);
        commitsByHash.set(key, promise);
      }
      return promise;
    };

    const commitsByTarget = await Promise.all(
      targets.map(async pkg => {
        const catchUpFile = path.join(pkg.dirname, resolveFilePath(pkg, options.filePath));
        const from = await detectChangeHash(git, pkg, {
          from: options.from,
          npmViewVersion: deps.npmViewVersion,
          catchUpFile: fs.existsSync(catchUpFile) ? catchUpFile : undefined,
        });
        return listCommitsCached(from);
      }),
    );

    const entries: Entry[] = [];
    for (let i = 0; i < targets.length; i++) {
      const pkg = targets[i];
      const ownCommits = commitsByTarget[i].filter(c => ownersOf(repository, c).has(pkg));
      if (!ownCommits.length) continue;
      const grouped = groupCommits(
        ownCommits.map(c => c.subject),
        ignoreTypesConfig(pkg),
      );
      // every commit could have been dropped by ignoreTypes - skip this package's entry entirely
      // rather than rendering a heading with nothing real underneath it.
      if (!grouped.features.length && !grouped.fixes.length && !grouped.other.length) continue;

      const label = pkg === repository.rootPackage ? `${path.basename(repository.dirname)} repository` : pkg.name;
      const { version, content } = await renderEntry(repository, pkg, label, grouped, git);
      entries.push({
        package: pkg,
        label,
        version,
        features: grouped.features,
        fixes: grouped.fixes,
        other: grouped.other,
        content,
        filePath: resolveFilePath(pkg, options.filePath),
      });
    }
    return entries;
  }
}

interface GroupedCommits {
  features: string[];
  fixes: string[];
  other: string[];
}

/** `.rmanrc changelog.ignoreTypes` (cascaded, per-package overridable) - Conventional Commits
 *  `type`s to drop entirely (e.g. `[chore, dev]`), not just fold into "Other Changes". Only
 *  applies to commits that actually parse as `type: ...` - a non-conventional message always
 *  still lands in Other Changes, since it has no `type` to match against. */
function ignoreTypesConfig(pkg: Package): Set<string> {
  const v = pkg.config?.changelog?.ignoreTypes;
  return new Set(Array.isArray(v) ? v.map(t => String(t).toLowerCase()) : []);
}

function groupCommits(subjects: string[], ignoreTypes: Set<string> = new Set()): GroupedCommits {
  const grouped: GroupedCommits = { features: [], fixes: [], other: [] };
  for (const subject of subjects) {
    if (VERSION_BUMP_PATTERN.test(subject)) continue;
    const parsed = parseConventionalCommit(subject);
    if (!parsed) {
      grouped.other.push(subject);
      continue;
    }
    const { type, scope, description } = parsed;
    if (ignoreTypes.has(type)) continue;
    const line = scope ? `**${scope}:** ${description}` : description;
    if (type === 'feat') grouped.features.push(line);
    else if (type === 'fix') grouped.fixes.push(line);
    else grouped.other.push(subject);
  }
  return grouped;
}

function bulletList(lines: string[]): string {
  return lines.map(l => `- ${l}`).join('\n');
}

function renderCommitsBlock(grouped: GroupedCommits): string {
  const sections: string[] = [];
  if (grouped.features.length) sections.push(`### ✨ Features\n\n${bulletList(grouped.features)}`);
  if (grouped.fixes.length) sections.push(`### 🐛 Bug Fixes\n\n${bulletList(grouped.fixes)}`);
  if (grouped.other.length) sections.push(`### 🔧 Other Changes\n\n${bulletList(grouped.other)}`);
  return sections.join('\n\n');
}

const DEFAULT_TEMPLATE = '## {{package}} {{version}} ({{date}})\n\n{{commits}}\n';

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
async function resolveVersion(git: GitHelper, pkg: Package): Promise<string> {
  const tag = await findLatestTag(git, pkg);
  return tag ? extractVersion(tag, tagPattern(pkg).replace('{name}', pkg.name)) : pkg.version || '';
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
  grouped: GroupedCommits,
  git: GitHelper,
): Promise<{ version: string; content: string }> {
  const template = resolveTemplate(repository, pkg);
  const version = await resolveVersion(git, pkg);
  const content = render(template, {
    package: label,
    version,
    date: new Date().toISOString().slice(0, 10),
    commits: renderCommitsBlock(grouped),
    features: bulletList(grouped.features),
    fixes: bulletList(grouped.fixes),
    other: bulletList(grouped.other),
  });
  return { version, content };
}

/** Prepends `content` right after the top-level "# Changelog" heading if the file already has
 *  one, otherwise creates the file (and any missing parent directory - `relFilePath` can nest one,
 *  e.g. `'docs/CHANGELOG.md'`) with one. Leaves everything already in the file untouched below it. */
function prependToChangelogFile(pkg: Package, relFilePath: string, content: string): void {
  const file = path.join(pkg.dirname, relFilePath);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const headerMatch = /^# Changelog\r?\n+/.exec(existing);
  const header = headerMatch ? headerMatch[0] : '# Changelog\n\n';
  const rest = headerMatch ? existing.slice(headerMatch[0].length) : existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header + content.trimEnd() + '\n\n' + rest);
}
