import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { ChangeHashService } from '../../src/services/change-hash.service.js';
import type { ChangelogService } from '../../src/services/changelog.service.js';
import { createRepository, registryVersions, service, useTestEcosystem } from '../_fixture.js';

/** The `<!-- rman:documented-up-to <sha> -->` line `--write` leaves behind. */
const MARKER_LINE = /<!-- rman:documented-up-to [0-9a-f]{7,40} -->/;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-changelog-test-'));
}

/** Joins every entry's rendered content, in order - the shape most of these tests care about. */
function content(entries: ChangelogService.Entry[]): string {
  return entries.map(e => e.content).join('\n');
}

/** Stub `deps` for every test that doesn't pass an explicit `--from <hash>` - none of these
 *  fixtures are actually published, but without this the default "npm" auto-detect would still
 *  make a real `npm view` network call before falling back to the unpushed-commits default. */

/**
 * **A heading naming `name`**, whatever shape the heading happens to take - `## v1.2.0`,
 * `## Unreleased — pkg-a`, or a repository's own `changelog.template`. Asserting the literal
 * `'## pkg-a 1.0.0'` pinned the default template's layout in twenty-two places, so changing the
 * heading - which is a presentation decision - turned every one of them red for no defect.
 */
function headingFor(name: string): RegExp {
  return new RegExp(`^## .*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm');
}

/**
 * Bullet lines with the trailing ` (short sha)` removed, for the assertions that compare a section's
 * lines **exactly**.
 *
 * A fixture's shas are new on every run, so an exact comparison cannot name them - and the two
 * choices are this or loosening those assertions to `toContain`, which would stop them noticing an
 * extra line. The sha itself is pinned by its own cases below, on a shape a spec can state.
 */
function withoutSha(lines: string[]): string[] {
  return lines.map(l => l.replace(/ \([0-9a-f]{7}\)$/, ''));
}

describe('services/changelog', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  /** A monorepo with two packages and a bare origin, some commits already pushed and some not -
   *  the baseline every "no --from" test builds on. */
  function fixtureWithUnpushedCommits(): { dir: string; baseHash: string } {
    const dir = tmp();
    const originDir = tmp();
    fs.rmSync(originDir, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--bare', originDir]);

    writeJson(dir, 'package.json', { name: 'root', private: true, version: '1.0.0', workspaces: ['packages/*'] });

    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,

     *  since it runs before the plugins that would know what a package is. */

    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '2.0.0' });

    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    run('remote', 'add', 'origin', originDir);
    run('branch', '-M', 'main');
    run('push', '-u', 'origin', 'main', '-q');

    fs.writeFileSync(path.join(dir, 'packages/a/feature.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'feat(pkg-a): add a feature');

    fs.writeFileSync(path.join(dir, 'packages/b/bug.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'fix(pkg-b): correct a bug');

    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'docs: update readme');

    return { dir, baseHash };
  }

  it('generates a changelog per package from commits not yet pushed, grouped Features/Bug Fixes/Other', async () => {
    const { dir } = fixtureWithUnpushedCommits();
    await createRepository(dir);

    const output = content(await service('changelog').getEntries({}));

    expect(output).toMatch(headingFor('pkg-a'));
    expect(output).toContain('### ✨ Features');
    expect(output).toContain('- **pkg-a:** add a feature');
    expect(output).toMatch(headingFor('pkg-b'));
    expect(output).toContain('### 🐛 Bug Fixes');
    expect(output).toContain('- **pkg-b:** correct a bug');
    // the docs commit only touched a root-level file - it belongs to root's own entry.
    expect(output).toMatch(headingFor(`${path.basename(dir)} repository`));
    expect(output).toContain('### 💬 General Changes');
    /** The bullet no longer repeats the type its heading already names - see `changelog.titles`. */
    expect(output).toContain('- update readme');
  });

  it('labels the root entry "<repo dir name> repository", not the root package.json\'s own (often private, non-published) name', async () => {
    // Regression: a real repo's root package.json was named "sqb.v4" (a private, unpublished
    // placeholder), which used to print verbatim as the changelog heading, reading like a stray
    // version marker (e.g. "## sqb.v4 6.0.8") instead of a recognizable, obviously-root entry.
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'sqb.v4', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'docs: a root-level change');

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));
    expect(output).toMatch(headingFor(`${path.basename(dir)} repository`));
    expect(output).not.toContain('sqb.v4');
  });

  it('a commit touching more than half of all packages is attributed to root alone, not fanned into every package', async () => {
    // Reproduces a real repo's report: a repo-wide doc/relicense commit touching nearly every
    // package made every single package's changelog show the exact same entry.
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    // touches all 3 packages at once - a repo-wide maintenance change, not per-package work.
    for (const pkg of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `packages/${pkg}/README.md`), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'docs: refresh every README');

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));

    expect(output).toMatch(headingFor(`${path.basename(dir)} repository`));
    expect(output).toContain('- refresh every README');
    expect(output).not.toMatch(headingFor('pkg-a'));
    expect(output).not.toMatch(headingFor('pkg-b'));
    expect(output).not.toMatch(headingFor('pkg-c'));
  });

  it('a commit touching only a minority of packages is still attributed to each of them normally', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });
    writeJson(dir, 'packages/d/package.json', { name: 'pkg-d', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    // touches only 1 of 4 packages - well under the broad-commit threshold.
    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'feat(pkg-a): a normal change');

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));
    expect(output).toMatch(headingFor('pkg-a'));
    expect(output).not.toMatch(headingFor('root'));
  });

  it('a repo with very few packages never treats a normal commit as "broad" just because it is most of them', async () => {
    // Regression test: with only 1-2 total packages, ">50% of all packages" is trivially true for
    // almost any commit (e.g. touching the repo's only package is "100%"), which would otherwise
    // wrongly attribute perfectly ordinary changes to root alone - see BROAD_COMMIT_MIN_PACKAGES.
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', "feat(pkg-a): a normal change in the repo's only package");

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));
    expect(output).toMatch(headingFor('pkg-a'));
    expect(output).not.toMatch(headingFor('root'));
  });

  it('a commit for a non-conventional subject still lands in General Changes, not dropped', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'just a plain message');

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));
    expect(output).toContain('- just a plain message');
  });

  /**
   * **A repository with a run of identical subjects, which is the shape this is for.** Measured on
   * `panates/postgrejs`, whose `v2.22.1` entry read `Updated config` five times under one heading -
   * five commits that really were worded the same, so it is not rman inventing them, and the
   * repetition states nothing the first line did not.
   */
  function repoWithRepeatedSubjects(): { dir: string; baseHash: string } {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    for (const [i, subject] of [
      'Updated config',
      'Updated config',
      'feat(pkg-a): a feature',
      'Updated config',
    ].entries()) {
      fs.writeFileSync(path.join(dir, `packages/a/f${i}.txt`), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', subject);
    }
    return { dir, baseHash };
  }

  it('writes a repeated subject once per section, keeping the first commit of the run', async () => {
    const { dir, baseHash } = repoWithRepeatedSubjects();
    await createRepository(dir);

    const entry = (await service('changelog').getEntries({ from: baseHash })).find(e => e.label === 'pkg-a')!;
    expect(withoutSha(entry.other)).toEqual(['Updated config']);
    /** `listCommits` returns oldest-first, so the survivor is the earliest of the run - stated here
     *  because "the first" is otherwise ambiguous about which end. */
    const shas = execFileSync('git', ['log', '--reverse', '--format=%h', `${baseHash}..HEAD`], { cwd: dir })
      .toString()
      .trim()
      .split('\n');
    expect(entry.other).toEqual([`Updated config (${shas[0]})`]);
  });

  /** **The control for keying the check on the message rather than the rendered line.** With the sha
   *  appended first, every duplicate is textually unique and the deduplication would never fire -
   *  so this asserts the two together, which is the only combination that can catch that order. */
  it('deduplicates across the whole section, not just consecutive lines, and only within a section', async () => {
    const { dir, baseHash } = repoWithRepeatedSubjects();
    await createRepository(dir);

    const entry = (await service('changelog').getEntries({ from: baseHash })).find(e => e.label === 'pkg-a')!;
    // The third "Updated config" sits after the feat commit, so a consecutive-only check would keep
    // it. And the feature keeps its own line - a different section is a different claim.
    expect(entry.other).toHaveLength(1);
    expect(withoutSha(entry.features)).toEqual(['**pkg-a:** a feature']);
  });

  it('appends each commit\'s short sha, and "commitHash: false" turns it off', async () => {
    const { dir, baseHash } = repoWithRepeatedSubjects();
    await createRepository(dir);

    const on = content(await service('changelog').getEntries({ from: baseHash }));
    expect(on).toMatch(/^- \*\*pkg-a:\*\* a feature \([0-9a-f]{7}\)$/m);

    const off = content(await service('changelog').getEntries({ from: baseHash, commitHash: false }));
    expect(off).toContain('- **pkg-a:** a feature\n');
    expect(off).not.toMatch(/\([0-9a-f]{7}\)/);
  });

  it('drops bare version-bump commits ("6.0.1") entirely, rather than listing them as changes', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'feat: a real change');
    fs.writeFileSync(path.join(dir, 'packages/a/y.txt'), 'y');
    run('add', '-A');
    run('commit', '-q', '-m', '6.0.1');

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));
    expect(output).toContain('- a real change');
    expect(output).not.toContain('6.0.1');
  });

  it('a package whose only commits are version bumps gets no entry at all (no empty heading)', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'v2.3.0-beta.1');

    await createRepository(dir);
    const entries = await service('changelog').getEntries({ from: baseHash });
    expect(entries).toEqual([]);
  });

  describe('.rmanrc "publish.skip"', () => {
    function fixtureWithSkippedPackage(): { dir: string; baseHash: string } {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', rman: { publish: { skip: true } } });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: a feature in the skipped package');
      fs.writeFileSync(path.join(dir, 'packages/b/x.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: a feature in the normal package');
      return { dir, baseHash };
    }

    it('excludes the package by default - no heading, even though it has real changes', async () => {
      const { dir, baseHash } = fixtureWithSkippedPackage();
      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      expect(output).not.toMatch(headingFor('pkg-a'));
      expect(output).not.toContain('a feature in the skipped package');
      expect(output).toMatch(headingFor('pkg-b'));
      expect(output).toContain('a feature in the normal package');
    });

    it('--include-skipped (includeSkipped: true) generates it anyway', async () => {
      const { dir, baseHash } = fixtureWithSkippedPackage();
      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash, includeSkipped: true }));
      expect(output).toMatch(headingFor('pkg-a'));
      expect(output).toContain('a feature in the skipped package');
    });
  });

  describe('.rmanrc changelog.ignoreTypes', () => {
    it('drops commits of the given conventional-commit types entirely, not just into General Changes', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { changelog: { ignoreTypes: ['chore', 'dev'] } } }),
      );
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      fs.writeFileSync(path.join(dir, 'packages/a/a.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: a real feature');
      fs.writeFileSync(path.join(dir, 'packages/a/b.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'chore: bump a dependency');
      fs.writeFileSync(path.join(dir, 'packages/a/c.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'dev: tweak a local script');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      expect(output).toContain('- a real feature');
      expect(output).not.toContain('bump a dependency');
      expect(output).not.toContain('tweak a local script');
      expect(output).not.toContain('### 💬 General Changes'); // nothing left to put there
    });

    it('leaves a non-conventional (typeless) commit alone - ignoreTypes only matches a real "type:" prefix', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { ignoreTypes: ['chore'] } } }));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      fs.writeFileSync(path.join(dir, 'packages/a/a.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'a plain, non-conventional message');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      expect(output).toContain('- a plain, non-conventional message');
    });

    it('a package can override ignoreTypes for just itself, cascading from the root default', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { ignoreTypes: ['chore'] } } }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      // pkg-b wants to see "chore" commits in its own changelog, unlike the root default.
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ changelog: { ignoreTypes: [] } }));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      fs.writeFileSync(path.join(dir, 'packages/a/a.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'chore(pkg-a): tidy up');
      fs.writeFileSync(path.join(dir, 'packages/b/b.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'chore(pkg-b): tidy up');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      expect(output).not.toMatch(headingFor('pkg-a')); // its only commit was ignored -> no entry
      expect(output).toMatch(headingFor('pkg-b'));
      /** The scope survives as `**pkg-b:**`; the type does not, the heading having said it. */
      expect(output).toContain('**pkg-b:** tidy up');
    });
  });

  it('--from <hash> uses that commit as the base instead of the upstream', async () => {
    const { dir, baseHash } = fixtureWithUnpushedCommits();
    // one more commit, on top of the ones already checked in the first test
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'packages/a/more.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'feat(pkg-a): another feature');

    await createRepository(dir);
    const output = content(await service('changelog').getEntries({ from: baseHash }));
    expect(output).toContain('- **pkg-a:** add a feature');
    expect(output).toContain('- **pkg-a:** another feature');
  });

  it('reports nothing (an empty array) when there is nothing unreleased', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    run('tag', 'v1.0.0'); // released right here - so there is genuinely nothing since

    await createRepository(dir);
    const entries = await service('changelog').getEntries({});
    expect(entries).toEqual([]);
  });

  describe('--write', () => {
    it('prepends the entry into CHANGELOG.md, creating it with a "# Changelog" header if missing', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      await service('changelog').generateToFile({});

      const fileContent = fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');
      expect(fileContent.startsWith('# Changelog\n')).toBe(true);
      expect(fileContent).toMatch(headingFor('pkg-a'));
    });

    it('a second run prepends above the first entry, leaving it intact below', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      await service('changelog').generateToFile({});

      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      // commit the CHANGELOG.md files the first --write left uncommitted, then push everything
      // so far, so the next commit (and the "not yet pushed" status behind it) covers only the
      // genuinely new file below - not those changelog files getting swept in by "add -A" too.
      run('add', '-A');
      run('commit', '-q', '-m', 'chore: release');
      run('push', '-q');
      fs.writeFileSync(path.join(dir, 'packages/a/second.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-a): a second feature');
      // re-create the Repository so the new commit is picked up by "not yet pushed" status.
      await createRepository(dir);
      await service('changelog').generateToFile({});

      const fileContent = fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');
      const firstIdx = fileContent.indexOf('add a feature');
      const secondIdx = fileContent.indexOf('a second feature');
      expect(secondIdx).toBeGreaterThanOrEqual(0);
      expect(firstIdx).toBeGreaterThan(secondIdx); // newest entry ends up on top
      expect(fileContent.match(/# Changelog/g)?.length).toBe(1); // header not duplicated
    });
  });

  describe('--file-path (where --write prepends into)', () => {
    it('defaults to "CHANGELOG.md" in each package\'s own directory', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      const entries = await service('changelog').generateToFile({});

      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(true);
      expect(entries.find(e => e.label === 'pkg-a')?.filePath).toBe('CHANGELOG.md');
    });

    it('an explicit filePath applies the same way to every package, replacing the default filename', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      await service('changelog').generateToFile({ filePath: 'HISTORY.md' });

      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
      const fileContent = fs.readFileSync(path.join(dir, 'packages/a/HISTORY.md'), 'utf-8');
      expect(fileContent).toMatch(headingFor('pkg-a'));
    });

    it('a nested filePath (e.g. "docs/CHANGELOG.md") creates any missing parent directory', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      await service('changelog').generateToFile({ filePath: 'docs/CHANGELOG.md' });

      expect(fs.existsSync(path.join(dir, 'packages/a/docs/CHANGELOG.md'))).toBe(true);
    });

    it('.rmanrc "changelog.filePath" sets a per-package default, cascading from the root', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { filePath: 'HISTORY.md' } } }));
      // pkg-b wants to keep the default filename, unlike the root default.
      fs.writeFileSync(
        path.join(dir, 'packages/b/.rmanrc'),
        JSON.stringify({ changelog: { filePath: 'CHANGELOG.md' } }),
      );
      await createRepository(dir);

      await service('changelog').generateToFile({});

      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/b/CHANGELOG.md'))).toBe(true);
    });

    it('an explicit option filePath wins over .rmanrc "changelog.filePath"', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { filePath: 'HISTORY.md' } } }));
      await createRepository(dir);

      await service('changelog').generateToFile({ filePath: 'NOTES.md' });

      expect(fs.existsSync(path.join(dir, 'packages/a/NOTES.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(false);
    });
  });

  describe('.rmanrc changelog.template (a file path, not inline text)', () => {
    it('uses the referenced template file, substituting {{package}}/{{version}}/{{features}}', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, 'my-template.md'), 'Release notes for {{package}} v{{version}}\n{{features}}\n');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { changelog: { template: './my-template.md' } } }),
      );

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('Release notes for pkg-a v1.0.0');
      expect(output).toContain('- **pkg-a:** add a feature');
      // the default template's own heading shouldn't appear when a custom one is used.
      expect(output).not.toMatch(headingFor('pkg-a'));
    });

    it('throws a clear error when the referenced template file does not exist', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { changelog: { template: './missing-template.md' } } }),
      );
      await createRepository(dir);
      await expect(service('changelog').getEntries({})).rejects.toThrow(/changelog\.template not found/);
    });
  });

  describe('cwd scoping (Repository.currentPackage)', () => {
    it("running from inside a single package only generates that package's changelog", async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(path.join(dir, 'packages/a'));
      const output = content(await service('changelog').getEntries({}));
      expect(output).toMatch(headingFor('pkg-a'));
      expect(output).not.toMatch(headingFor('pkg-b'));
    });

    it('--from-root generates for the whole repository even from inside a single package', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(path.join(dir, 'packages/a'));
      const output = content(await service('changelog').getEntries({ fromRoot: true }));
      expect(output).toMatch(headingFor('pkg-a'));
      expect(output).toMatch(headingFor('pkg-b'));
    });
  });

  describe('{{version}} resolution from git tags (not package.json)', () => {
    it("falls back to package.json's version when no tag matches anything", async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      const output = content(await service('changelog').getEntries({}));
      expect(output).toMatch(headingFor('pkg-a'));
    });

    it('the default "v*" pattern uses the nearest repo-wide tag for every package, ignoring a stale package.json version', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      // package.json still says 1.0.0/2.0.0, but the repo has actually moved on to v6.0.8 -
      // exactly the kind of drift that made package.json's version untrustworthy here. An explicit
      // "from" (rather than auto-detection) keeps this test about {{version}} display only - v6.0.8
      // now also being a real, resolvable release tag would otherwise make it the "since" boundary
      // too (it's the newest tag, sitting right at HEAD - nothing "since" it by definition).
      run('tag', 'v6.0.8');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      /** A tagged segment is headed by its tag, so the tag *is* the version on display - which is
       *  what this spec is about. The package name is no longer in that heading; see the note on
       *  `{{title}}` in `changelog.service.ts`. */
      expect(output).toContain('## v6.0.8');
      expect(output).not.toContain('1.0.0');
      expect(output).not.toContain('2.0.0');
    });

    it('"{name}@*" resolves each package\'s own independent version from its own tags', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('tag', 'pkg-a@3.1.0');
      // pkg-b is never tagged - it should still fall back to its own package.json version.
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { tagPattern: '{name}@*' } } }));

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      /** pkg-a's segment is closed by its own tag, so that tag heads it. pkg-b has none, so its
       *  entry is the unreleased one - which is where the package label still shows. */
      expect(output).toContain('## pkg-a@3.1.0');
      expect(output).toMatch(headingFor('pkg-b'));
    });

    it('"{name}@*" resolves a scoped package name (e.g. "@scope/name") correctly', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/builder/package.json', { name: '@sqb/builder', version: '1.0.0' });
      fs.writeFileSync(dir + '/.rmanrc', JSON.stringify({ '[*]': { changelog: { tagPattern: '{name}@*' } } }));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      run('tag', '@sqb/builder@1.2.3');
      fs.writeFileSync(path.join(dir, 'packages/builder/x.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: something new');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      expect(output).toMatch(headingFor('@sqb/builder'));
    });

    it('a package can override the tag pattern for just itself, cascading from the root default', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('tag', 'v6.0.8'); // root default pattern - applies to pkg-b
      run('tag', 'pkg-a@9.9.9'); // pkg-a's own override
      fs.writeFileSync(path.join(dir, 'packages/a/.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: baseHash }));
      /**
       * Each package is headed by the tag its **own** pattern resolved - `pkg-a@9.9.9` for the one
       * that overrode it, the repo-wide `v6.0.8` for the one that did not. Which is also the
       * clearest demonstration of what tag headings cost on the *print* path: the root's entry and
       * pkg-b's are both `## v6.0.8`, and only their contents tell them apart. In a changelog
       * **file** there is no ambiguity - the file is the package's - but `rman changelog` writes
       * every package to one stream.
       */
      expect(output).toContain('## pkg-a@9.9.9');
      expect(output.match(/^## v6\.0\.8/gm)).toHaveLength(2);
      expect(output).toContain('**pkg-b:** correct a bug');
    });
  });

  describe('--from npm (auto-detect per package from its published npm version)', () => {
    it('by default, uses the tag matching the published version as the boundary - not everything unpushed', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { tagPattern: '{name}@*' } } }));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      // already published as pkg-a@1.0.0 - should NOT show up in the changelog.
      fs.writeFileSync(path.join(dir, 'packages/a/old.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: an already-published change');
      run('tag', 'pkg-a@1.0.0');

      // real unreleased work on top of that publish.
      fs.writeFileSync(path.join(dir, 'packages/a/new.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: a brand new unreleased change');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('a brand new unreleased change');
      expect(output).not.toContain('an already-published change');
    });

    it('"npm" passed explicitly behaves the same as the default', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { tagPattern: '{name}@*' } } }));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/old.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: an already-published change');
      run('tag', 'pkg-a@1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/new.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: a brand new unreleased change');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({ from: ChangeHashService.AUTO }));
      expect(output).toContain('a brand new unreleased change');
      expect(output).not.toContain('an already-published change');
    });

    it('falls back to not-yet-pushed commits when the published version has no matching tag in this repo', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      // "9.9.9" was never tagged here - tagging must have lagged behind the publish, so the
      // borrowed version maps onto a tag that does not exist and resolves nothing.
      registryVersions.set('pkg-a', '9.9.9');
      registryVersions.set('pkg-b', '9.9.9');
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('- **pkg-a:** add a feature');
      expect(output).toContain('- **pkg-b:** correct a bug');
    });

    it('falls back to the package\'s own release tag (not "not yet pushed") when it has never been on npm at all', async () => {
      // The scenario a Docker-only package hits: never published to npm, but has a real release
      // tag from a previous "version" run - and, unlike fixtureWithUnpushedCommits above, the
      // commits are already pushed (as they would be by the time a CI "release notes" step runs
      // right after "version --push"), so the "not yet pushed" fallback alone would find nothing.
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'docker-pkg',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'org/docker-pkg' } } },
      });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('tag', 'v1.0.0');
      run('remote', 'add', 'origin', originDir);
      run('branch', '-M', 'main');
      run('push', '-q', '-u', 'origin', 'main');
      run('push', '-q', 'origin', 'v1.0.0');

      fs.writeFileSync(path.join(dir, 'packages/a/feature.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: a feature in the never-published docker package');
      run('push', '-q');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('a feature in the never-published docker package');
    });

    it('resolves a different boundary per package under independent versioning', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { tagPattern: '{name}@*' } } }));
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      // pkg-a published at 1.0.0, then got one more (unreleased) change.
      fs.writeFileSync(path.join(dir, 'packages/a/old.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-a): already published at 1.0.0');
      run('tag', 'pkg-a@1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/new.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-a): unreleased since 1.0.0');

      // pkg-b published later, at 2.0.0, then also got one more (unreleased) change.
      fs.writeFileSync(path.join(dir, 'packages/b/old.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-b): already published at 2.0.0');
      run('tag', 'pkg-b@2.0.0');
      fs.writeFileSync(path.join(dir, 'packages/b/new.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-b): unreleased since 2.0.0');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('unreleased since 1.0.0');
      expect(output).not.toContain('already published at 1.0.0');
      expect(output).toContain('unreleased since 2.0.0');
      expect(output).not.toContain('already published at 2.0.0');
    });

    it("a stale CHANGELOG.md (last written for an older version than what's published) still gets the gap in between, not just the latest change", async () => {
      // Exactly the scenario reported: npm says 1.5.0 is published, but CHANGELOG.md was last
      // written for 1.1.0 - versions 1.2.0-1.5.0 were released without ever being documented.
      // Using the v1.5.0 tag alone as "from" would silently skip that undocumented stretch.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.1.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      fs.writeFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), '# Changelog\n\n## pkg-a 1.1.0\n- initial\n');
      run('add', '-A');
      run('commit', '-q', '-m', 'docs: changelog for 1.1.0');

      fs.writeFileSync(path.join(dir, 'packages/a/gap.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: released in 1.2.0, never documented');
      run('tag', 'pkg-a@1.2.0');

      fs.writeFileSync(path.join(dir, 'packages/a/more.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: released in 1.5.0');
      run('tag', 'pkg-a@1.5.0');

      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { changelog: { tagPattern: '{name}@*' } } }));
      run('add', '-A');
      run('commit', '-q', '-m', 'chore: add rmanrc');

      await createRepository(dir);
      registryVersions.set('pkg-a', '1.5.0');
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('released in 1.2.0, never documented');
      expect(output).toContain('released in 1.5.0');
    });
  });

  describe('ChangelogService.getEntries() - the pure computation ChangelogService.generateToFile() writes on top of', () => {
    it('returns structured entries and never touches the console or CHANGELOG.md files', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      const originalLog = console.log;
      const logged: unknown[] = [];
      console.log = (...args: unknown[]) => logged.push(args);
      let entries: ChangelogService.Entry[];
      try {
        entries = await service('changelog').getEntries({});
      } finally {
        console.log = originalLog;
      }

      expect(logged).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);

      const pkgA = entries.find(e => e.label === 'pkg-a');
      expect(pkgA).toBeDefined();
      expect(pkgA!.version).toBe('1.0.0');
      expect(withoutSha(pkgA!.features)).toEqual(['**pkg-a:** add a feature']);
      expect(pkgA!.content).toMatch(headingFor('pkg-a'));
      expect(pkgA!.filePath).toBe('CHANGELOG.md');

      const root = entries.find(e => e.label === `${path.basename(dir)} repository`);
      expect(root).toBeDefined();
      // nothing has ever been released here (no tag, nothing on npm), so the boundary-free view
      // reaches all the way back to the first commit.
      /** **`update readme` before `init`, which is not chronological order.** `other` is every
       *  section that is not Features or Bug Fixes, flattened in *section* order - and `docs:` has
       *  a heading of its own now, which sorts above the catch-all that `init` (not a conventional
       *  subject) falls into. The commits are still the two this fixture makes; only which section
       *  each lands in changed. */
      expect(withoutSha(root!.other)).toEqual(['update readme', 'init']);
    });

    it('returns [] when there is nothing unreleased', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('tag', 'v1.0.0'); // released right here - so there is genuinely nothing since

      await createRepository(dir);
      const entries = await service('changelog').getEntries({});
      expect(entries).toEqual([]);
    });

    it('a never-released repository reports its whole history, not nothing', async () => {
      // No tag, nothing on npm: there is no boundary, so everything so far is unreleased - the
      // same view "version" takes. Reading this as "nothing changed" would leave a first-ever
      // release with an empty changelog the moment its commits had been pushed.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-a): the very first feature');

      await createRepository(dir);
      const output = content(await service('changelog').getEntries({}));
      expect(output).toContain('the very first feature');
    });
  });

  describe('ChangelogService.getEntries()/generateToFile() never touch the console themselves', () => {
    it('produces no console output at all, with or without --write', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      const originalLog = console.log;
      const logged: unknown[] = [];
      console.log = (...args: unknown[]) => logged.push(args);
      try {
        await service('changelog').getEntries({});
        await service('changelog').generateToFile({});
      } finally {
        console.log = originalLog;
      }
      expect(logged).toEqual([]);
    });
  });

  /**
   * **`changelog.groupBy: 'group'` - one file per set of packages that release together.**
   *
   * The fixture's `.rmanrc` is `{}`, so every package is in the implicit `default` group and the
   * whole repository shares one file. `group: false` makes a package a group of itself, which is
   * what makes this one rule rather than two.
   */
  describe('changelog.groupBy', () => {
    /** The config is left uncommitted on purpose: committing it would put a `chore:` commit of the
     *  fixture's own making into every range these cases read, and `.rmanrc` only has to be on disk
     *  for `ConfigReader` to see it. */
    function groupFixture(rmanrc: unknown): { dir: string; baseHash: string } {
      const fixture = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(fixture.dir, '.rmanrc'), JSON.stringify(rmanrc));
      return fixture;
    }

    it("defaults to 'package', so no repository's layout changes until it asks", async () => {
      const { dir, baseHash } = groupFixture({});
      await createRepository(dir);

      const entries = await service('changelog').getEntries({ from: baseHash });

      expect(entries.length).toBeGreaterThan(1);
      expect(new Set(entries.map(e => e.file)).size).toBe(entries.length);
    });

    it('writes one entry at the repository root for the whole default group', async () => {
      const { dir, baseHash } = groupFixture({});
      await createRepository(dir);

      const entries = await service('changelog').getEntries({ from: baseHash, groupBy: 'group' });

      expect(entries).toHaveLength(1);
      expect(entries[0].file).toBe(path.join(dir, 'CHANGELOG.md'));
      /** Every member's commits in the one file - which is the point: a reader sees the whole
       *  release rather than one package's slice of it. */
      expect(entries[0].content).toContain('- **pkg-a:** add a feature');
      expect(entries[0].content).toContain('- **pkg-b:** correct a bug');
      expect(entries[0].content).toContain('- update readme');
    });

    it('leaves a group: false package its own file, which is the same rule and not a second one', async () => {
      const { dir, baseHash } = groupFixture({ '[pkg-a]': { group: false } });
      await createRepository(dir);

      const entries = await service('changelog').getEntries({ from: baseHash, groupBy: 'group' });
      const byFile = new Map(entries.map(e => [path.relative(dir, e.file), e]));

      expect([...byFile.keys()].sort()).toEqual(['CHANGELOG.md', path.join('packages', 'a', 'CHANGELOG.md')]);
      expect(byFile.get(path.join('packages', 'a', 'CHANGELOG.md'))!.content).toContain('- **pkg-a:** add a feature');
      /** pkg-a left the default group, so its commit is not in the group's file either. */
      expect(byFile.get('CHANGELOG.md')!.content).not.toContain('add a feature');
    });

    it("names a named group's file after it, at the root", async () => {
      const { dir, baseHash } = groupFixture({ '[*]': { group: 'core' } });
      await createRepository(dir);

      const entries = await service('changelog').getEntries({ from: baseHash, groupBy: 'group' });
      const core = entries.find(e => e.label === 'core');

      expect(core).toBeDefined();
      expect(core!.file).toBe(path.join(dir, 'CHANGELOG-core.md'));
      expect(core!.content).toContain('- **pkg-a:** add a feature');
      expect(core!.content).toContain('- **pkg-b:** correct a bug');
    });

    it("keeps changelog.filePath's directory and extension when it suffixes a group name", async () => {
      const { dir, baseHash } = groupFixture({ '[*]': { group: 'core' } });
      await createRepository(dir);

      const entries = await service('changelog').getEntries({
        from: baseHash,
        groupBy: 'group',
        filePath: 'docs/HISTORY.md',
      });

      expect(entries.find(e => e.label === 'core')!.file).toBe(path.join(dir, 'docs/HISTORY-core.md'));
    });

    /** A group's file may not be headed by one member's tag: under `{name}@*` the heading would
     *  name whichever member happens to sort first, over a file describing all of them. */
    it("heads a group's entry with the group, not with a member's tag name", async () => {
      const { dir, baseHash } = groupFixture({ '[*]': { group: 'core' }, changelog: { tagPattern: '{name}@*' } });
      await createRepository(dir);

      const entries = await service('changelog').getEntries({
        from: baseHash,
        groupBy: 'group',
        version: '3.1.0',
      });
      const core = entries.find(e => e.label === 'core')!;

      expect(core.content).toContain('## core 3.1.0');
      expect(core.content).not.toContain('pkg-a@3.1.0');
    });

    it('writes the group file once, however many members it has', async () => {
      const { dir } = groupFixture({});
      await createRepository(dir);

      const entries = await service('changelog').generateToFile({ groupBy: 'group' });

      expect(entries).toHaveLength(1);
      const written = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf-8');
      expect(written.match(/- \*\*pkg-a:\*\* add a feature/g)).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
    });

    /**
     * **`changelog.groupFiles` - a named group's file wherever the repository wants it.** Without it
     * a named group always went to the root as `CHANGELOG-<group>.md`; the default group's file was
     * already movable through `changelog.filePath`, so the map covers named groups and nothing else.
     */
    describe('changelog.groupFiles', () => {
      /** Two named groups, the root left in the default one - the shape every case below needs to
       *  tell "listed", "unlisted" and "default" apart. */
      const twoGroups = { '[pkg-a]': { group: 'core' }, '[pkg-b]': { group: 'dialects' } };

      it('writes a listed group where the map says, relative to the repository root', async () => {
        const { dir, baseHash } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: 'packages/a/CHANGELOG.md' } },
        });
        await createRepository(dir);

        const entries = await service('changelog').getEntries({ from: baseHash, groupBy: 'group' });

        expect(entries.find(e => e.label === 'core')!.file).toBe(path.join(dir, 'packages/a/CHANGELOG.md'));
        /** An unlisted group is untouched - which is what makes the key additive: no repository's
         *  layout changes until it names a group. */
        expect(entries.find(e => e.label === 'dialects')!.file).toBe(path.join(dir, 'CHANGELOG-dialects.md'));
      });

      it('writes the file and its marker at the mapped path, end to end', async () => {
        const { dir } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: 'docs/core/HISTORY.md' } },
        });
        await createRepository(dir);

        await service('changelog').generateToFile({ groupBy: 'group' });

        const written = fs.readFileSync(path.join(dir, 'docs/core/HISTORY.md'), 'utf-8');
        expect(written).toContain('- **pkg-a:** add a feature');
        /** The marker is what the next `--write` starts from, so it has to be in *this* file. */
        expect(written).toMatch(/rman:documented-up-to [0-9a-f]+/);
        expect(fs.existsSync(path.join(dir, 'CHANGELOG-core.md'))).toBe(false);
      });

      /** rman drops an unknown config key in silence, so a typo here would leave the group on the
       *  default rule with nothing saying so. The groups are known, so the key is checked. */
      it('refuses a key naming no group, and lists the groups there are', async () => {
        const { dir, baseHash } = groupFixture({ ...twoGroups, changelog: { groupFiles: { cor: 'x.md' } } });
        await createRepository(dir);

        await expect(service('changelog').getEntries({ from: baseHash, groupBy: 'group' })).rejects.toThrow(
          /names a group "cor" that no package belongs to\. Named groups here: core, dialects/,
        );
      });

      it('refuses a path outside the repository', async () => {
        const { dir, baseHash } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: '../elsewhere/CHANGELOG.md' } },
        });
        await createRepository(dir);

        await expect(service('changelog').getEntries({ from: baseHash, groupBy: 'group' })).rejects.toThrow(
          /points outside the repository/,
        );
      });

      /**
       * **The collision this exists to refuse.** The `documented-up-to` marker is one per file, so two
       * groups writing into one would each read the other's marker as its own boundary - entries
       * missing or written twice, and nothing failing.
       */
      it('refuses two groups mapped to one file', async () => {
        const { dir, baseHash } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: 'CHANGES.md', dialects: 'CHANGES.md' } },
        });
        await createRepository(dir);

        await expect(service('changelog').getEntries({ from: baseHash, groupBy: 'group' })).rejects.toThrow(
          /core and dialects both resolve to CHANGES\.md/,
        );
      });

      it("refuses a group mapped onto the default group's file", async () => {
        const { dir, baseHash } = groupFixture({ ...twoGroups, changelog: { groupFiles: { core: 'CHANGELOG.md' } } });
        await createRepository(dir);

        await expect(service('changelog').getEntries({ from: baseHash, groupBy: 'group' })).rejects.toThrow(
          /the default group and core both resolve to CHANGELOG\.md/,
        );
      });

      /** The subtle one: nobody wrote two equal paths, but an *unlisted* group's suffixed default
       *  lands on a listed group's path. Only checking the map against itself would miss it. */
      it("refuses a listed path that an unlisted group's default name already takes", async () => {
        const { dir, baseHash } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: 'CHANGELOG-dialects.md' } },
        });
        await createRepository(dir);

        await expect(service('changelog').getEntries({ from: baseHash, groupBy: 'group' })).rejects.toThrow(
          /both resolve to CHANGELOG-dialects\.md/,
        );
      });

      /** A collision is a fact about the configuration, so a `--scope` leaving one of the two groups
       *  out of this run must not be what lets it through. */
      it('refuses a collision even when the run is scoped to one of the two groups', async () => {
        const { dir, baseHash } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: 'CHANGES.md', dialects: 'CHANGES.md' } },
        });
        await createRepository(dir);

        await expect(
          service('changelog').getEntries({ from: baseHash, groupBy: 'group', scope: 'pkg-a', fromRoot: true }),
        ).rejects.toThrow(/both resolve to CHANGES\.md/);
      });

      /** `--file-path` names this run's file and already beats `changelog.filePath`; it beats the map
       *  the same way, and still suffixes named groups so two of them cannot collide under it. */
      it('lets an explicit --file-path override the map for that run', async () => {
        const { dir, baseHash } = groupFixture({
          ...twoGroups,
          changelog: { groupFiles: { core: 'packages/a/CHANGELOG.md' } },
        });
        await createRepository(dir);

        const entries = await service('changelog').getEntries({
          from: baseHash,
          groupBy: 'group',
          filePath: 'NOTES.md',
        });

        expect(entries.find(e => e.label === 'core')!.file).toBe(path.join(dir, 'NOTES-core.md'));
        expect(entries.find(e => e.label === 'dialects')!.file).toBe(path.join(dir, 'NOTES-dialects.md'));
      });
    });
  });

  /**
   * **A group name is a file name now**, so it is checked where it is read rather than escaped
   * where it is written - see `assertGroupName`. Refused for every command, not only `changelog`:
   * `groupKeyOf` is what `version` batches its plan by too.
   */
  describe('group names', () => {
    function repoWithGroup(name: string): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ group: name }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      return dir;
    }

    it('refuses one longer than 15 characters, naming the length', async () => {
      const dir = repoWithGroup('a-very-long-group-name');
      const repository = await createRepository(dir);
      expect(() => repository.getPackages().map(p => p.config.group)).not.toThrow();
      await expect(service('changelog').getEntries({ groupBy: 'group' })).rejects.toThrow(
        /at most 15 characters, and it is 22/,
      );
    });

    it('refuses a character a file name should not carry, and says what is allowed', async () => {
      const dir = repoWithGroup('core/api');
      await createRepository(dir);
      await expect(service('changelog').getEntries({ groupBy: 'group' })).rejects.toThrow(
        /start with a letter or digit/,
      );
    });

    it('accepts letters, digits, dot, dash and underscore', async () => {
      const dir = repoWithGroup('core_v2.1-x');
      await createRepository(dir);
      await expect(service('changelog').getEntries({ groupBy: 'group' })).resolves.toBeDefined();
    });
  });

  /**
   * **`rebuild` regenerates a file instead of appending to it.** The two things that narrow a
   * boundary - the file's own marker and `catchUpFile` - are both records of what a previous run
   * wrote, so a rebuild ignores them; and the file is emptied before anything is prepended, or the
   * regenerated history lands on top of the history already there.
   */
  describe('--rebuild', () => {
    it('ignores the marker and re-reads the whole range', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      await service('changelog').generateToFile({});
      const first = fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');
      expect(first).toMatch(MARKER_LINE);

      /** A plain second write finds the marker and has nothing left to say. */
      const appended = await service('changelog').generateToFile({});
      expect(appended.some(e => e.label === 'pkg-a')).toBe(false);

      const rebuilt = await service('changelog').generateToFile({ rebuild: true });
      expect(rebuilt.some(e => e.label === 'pkg-a')).toBe(true);
    });

    it('replaces the file rather than prepending, so running it twice changes nothing', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      const file = path.join(dir, 'packages/a/CHANGELOG.md');

      await service('changelog').generateToFile({ rebuild: true });
      const once = fs.readFileSync(file, 'utf-8');
      await service('changelog').generateToFile({ rebuild: true });
      const twice = fs.readFileSync(file, 'utf-8');

      expect(twice).toBe(once);
      expect(twice.match(/add a feature/g)).toHaveLength(1);
    });

    it('leaves a file this run has nothing to say about alone', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      /** pkg-b owns no commit in this range, so no entry names its file - emptying it would lose
       *  what is there and put nothing back. */
      const untouched = path.join(dir, 'packages/b/CHANGELOG.md');
      fs.writeFileSync(untouched, '# Changelog\n\nhand written, keep me\n');

      await service('changelog').generateToFile({ rebuild: true, scope: 'pkg-a' });

      expect(fs.readFileSync(untouched, 'utf-8')).toContain('hand written, keep me');
    });

    it('an explicit from still wins over it', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      const entries = await service('changelog').getEntries({ rebuild: true, from: baseHash });

      expect(entries.length).toBeGreaterThan(0);
    });
  });

  /**
   * **What a run reports.** The service prints nothing itself - `version --changelog` drives it in
   * the middle of its own output - so the CLI's panel is fed from here.
   */
  describe('Options.progress', () => {
    it('reports every label up front, then a phase per label, then whether it wrote', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      const events: string[] = [];
      await service('changelog').getEntries({
        from: baseHash,
        progress: {
          start: labels => events.push(`start:${labels.length}`),
          step: (label, phase) => events.push(`step:${label}:${phase}`),
          done: (label, wrote) => events.push(`done:${label}:${wrote}`),
        },
      });

      expect(events[0]).toBe('start:3');
      expect(events).toContain('step:pkg-a:detect');
      expect(events).toContain('step:pkg-a:commits');
      expect(events).toContain('step:pkg-a:render');
      expect(events).toContain('done:pkg-a:true');
      /** Every label reaches `done`, including one that produced nothing - a caller rendering a
       *  panel would otherwise leave that row spinning for the rest of the run. */
      expect(events.filter(e => e.startsWith('done:'))).toHaveLength(3);
    });

    /**
     * **The per-commit count, which is the only thing that moves during the slow phase.** Without
     * it a panel shows one row for the whole run - measured on `panates/sqb`, a rebuild sat at the
     * same line for minutes while 1825 commits were read, because the unit shown was files to
     * write and `changelog.groupBy: 'group'` has exactly one.
     */
    it('counts the commits it reads, starting with the total', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      await createRepository(dir);

      const ticks: [number, number][] = [];
      await service('changelog').getEntries({
        from: baseHash,
        progress: {
          start: () => {},
          step: () => {},
          done: () => {},
          commits: (_label, done, total) => ticks.push([done, total]),
        },
      });

      /** `(0, total)` first, so a caller knows the total while the count is still zero - otherwise
       *  there is nothing to draw for the whole of the first commit. */
      expect(ticks[0][0]).toBe(0);
      expect(ticks[0][1]).toBeGreaterThan(0);
      const total = ticks[0][1];
      /** One tick per commit on top of that opening one, ending exactly at the total. */
      expect(ticks).toHaveLength(total + 1);
      expect(ticks[ticks.length - 1]).toEqual([total, total]);
    });

    it('leaves the count out without complaint - it is the one optional member', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      const phases: string[] = [];
      await expect(
        service('changelog').getEntries({
          from: baseHash,
          progress: { start: () => {}, step: (_l, p) => phases.push(p), done: () => {} },
        }),
      ).resolves.toBeDefined();
      expect(phases).toContain('commits');
    });
    it('is optional - nothing is reported and nothing throws without it', async () => {
      const { dir, baseHash } = fixtureWithUnpushedCommits();
      await createRepository(dir);
      await expect(service('changelog').getEntries({ from: baseHash })).resolves.toBeDefined();
    });
  });
});
