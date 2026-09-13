import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { ChangelogService } from '../../src/services/changelog.service.js';

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
const noNpm = { npmViewVersion: async () => undefined };

describe('services/changelog', () => {
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
    const repo = await Repository.create(dir);

    const output = content(await ChangelogService.getEntries(repo, {}, noNpm));

    expect(output).toContain('## pkg-a 1.0.0');
    expect(output).toContain('### ✨ Features');
    expect(output).toContain('- **pkg-a:** add a feature');
    expect(output).toContain('## pkg-b 2.0.0');
    expect(output).toContain('### 🐛 Bug Fixes');
    expect(output).toContain('- **pkg-b:** correct a bug');
    // the docs commit only touched a root-level file - it belongs to root's own entry.
    expect(output).toContain(`## ${path.basename(dir)} repository`);
    expect(output).toContain('### 🔧 Other Changes');
    expect(output).toContain('- docs: update readme');
  });

  it('labels the root entry "<repo dir name> repository", not the root package.json\'s own (often private, non-published) name', async () => {
    // Regression: a real repo's root package.json was named "sqb.v4" (a private, unpublished
    // placeholder), which used to print verbatim as the changelog heading, reading like a stray
    // version marker (e.g. "## sqb.v4 6.0.8") instead of a recognizable, obviously-root entry.
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'sqb.v4', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
    expect(output).toContain(`## ${path.basename(dir)} repository`);
    expect(output).not.toContain('sqb.v4');
  });

  it('a commit touching more than half of all packages is attributed to root alone, not fanned into every package', async () => {
    // Reproduces a real repo's report: a repo-wide doc/relicense commit touching nearly every
    // package made every single package's changelog show the exact same entry.
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));

    expect(output).toContain(`## ${path.basename(dir)} repository`);
    expect(output).toContain('- docs: refresh every README');
    expect(output).not.toContain('## pkg-a');
    expect(output).not.toContain('## pkg-b');
    expect(output).not.toContain('## pkg-c');
  });

  it('a commit touching only a minority of packages is still attributed to each of them normally', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
    expect(output).toContain('## pkg-a');
    expect(output).not.toContain('## root');
  });

  it('a repo with very few packages never treats a normal commit as "broad" just because it is most of them', async () => {
    // Regression test: with only 1-2 total packages, ">50% of all packages" is trivially true for
    // almost any commit (e.g. touching the repo's only package is "100%"), which would otherwise
    // wrongly attribute perfectly ordinary changes to root alone - see BROAD_COMMIT_MIN_PACKAGES.
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
    expect(output).toContain('## pkg-a');
    expect(output).not.toContain('## root');
  });

  it('a commit for a non-conventional subject still lands in Other Changes, not dropped', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
    expect(output).toContain('- just a plain message');
  });

  it('drops bare version-bump commits ("6.0.1") entirely, rather than listing them as changes', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
    expect(output).toContain('- a real change');
    expect(output).not.toContain('6.0.1');
  });

  it('a package whose only commits are version bumps gets no entry at all (no empty heading)', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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

    const repo = await Repository.create(dir);
    const entries = await ChangelogService.getEntries(repo, { from: baseHash });
    expect(entries).toEqual([]);
  });

  describe('.rmanrc changelog.ignoreTypes', () => {
    it('drops commits of the given conventional-commit types entirely, not just into Other Changes', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { ignoreTypes: ['chore', 'dev'] } }));
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

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
      expect(output).toContain('- a real feature');
      expect(output).not.toContain('bump a dependency');
      expect(output).not.toContain('tweak a local script');
      expect(output).not.toContain('### 🔧 Other Changes'); // nothing left to put there
    });

    it('leaves a non-conventional (typeless) commit alone - ignoreTypes only matches a real "type:" prefix', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { ignoreTypes: ['chore'] } }));
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

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
      expect(output).toContain('- a plain, non-conventional message');
    });

    it('a package can override ignoreTypes for just itself, cascading from the root default', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { ignoreTypes: ['chore'] } }));
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

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
      expect(output).not.toContain('## pkg-a'); // its only commit was ignored -> no entry
      expect(output).toContain('## pkg-b');
      expect(output).toContain('chore(pkg-b): tidy up');
    });
  });

  it('--from <hash> uses that commit as the base instead of the upstream', async () => {
    const { dir, baseHash } = fixtureWithUnpushedCommits();
    // one more commit, on top of the ones already checked in the first test
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'packages/a/more.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'feat(pkg-a): another feature');

    const repo = await Repository.create(dir);
    const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
    expect(output).toContain('- **pkg-a:** add a feature');
    expect(output).toContain('- **pkg-a:** another feature');
  });

  it('reports nothing (an empty array) when there is nothing unreleased', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');

    const repo = await Repository.create(dir);
    const entries = await ChangelogService.getEntries(repo, {}, noNpm);
    expect(entries).toEqual([]);
  });

  describe('--write', () => {
    it('prepends the entry into CHANGELOG.md, creating it with a "# Changelog" header if missing', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);

      await ChangelogService.generateToFile(repo, {}, noNpm);

      const fileContent = fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');
      expect(fileContent.startsWith('# Changelog\n')).toBe(true);
      expect(fileContent).toContain('## pkg-a 1.0.0');
    });

    it('a second run prepends above the first entry, leaving it intact below', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);
      await ChangelogService.generateToFile(repo, {}, noNpm);

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
      const repo2 = await Repository.create(dir);
      await ChangelogService.generateToFile(repo2, {}, noNpm);

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
      const repo = await Repository.create(dir);

      const entries = await ChangelogService.generateToFile(repo, {}, noNpm);

      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(true);
      expect(entries.find(e => e.label === 'pkg-a')?.filePath).toBe('CHANGELOG.md');
    });

    it('an explicit filePath applies the same way to every package, replacing the default filename', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);

      await ChangelogService.generateToFile(repo, { filePath: 'HISTORY.md' }, noNpm);

      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
      const fileContent = fs.readFileSync(path.join(dir, 'packages/a/HISTORY.md'), 'utf-8');
      expect(fileContent).toContain('## pkg-a 1.0.0');
    });

    it('a nested filePath (e.g. "docs/CHANGELOG.md") creates any missing parent directory', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);

      await ChangelogService.generateToFile(repo, { filePath: 'docs/CHANGELOG.md' }, noNpm);

      expect(fs.existsSync(path.join(dir, 'packages/a/docs/CHANGELOG.md'))).toBe(true);
    });

    it('.rmanrc "changelog.filePath" sets a per-package default, cascading from the root', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { filePath: 'HISTORY.md' } }));
      // pkg-b wants to keep the default filename, unlike the root default.
      fs.writeFileSync(
        path.join(dir, 'packages/b/.rmanrc'),
        JSON.stringify({ changelog: { filePath: 'CHANGELOG.md' } }),
      );
      const repo = await Repository.create(dir);

      await ChangelogService.generateToFile(repo, {}, noNpm);

      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/b/CHANGELOG.md'))).toBe(true);
    });

    it('an explicit option filePath wins over .rmanrc "changelog.filePath"', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { filePath: 'HISTORY.md' } }));
      const repo = await Repository.create(dir);

      await ChangelogService.generateToFile(repo, { filePath: 'NOTES.md' }, noNpm);

      expect(fs.existsSync(path.join(dir, 'packages/a/NOTES.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(false);
    });
  });

  describe('.rmanrc changelog.template (a file path, not inline text)', () => {
    it('uses the referenced template file, substituting {{package}}/{{version}}/{{features}}', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, 'my-template.md'), 'Release notes for {{package}} v{{version}}\n{{features}}\n');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { template: './my-template.md' } }));

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, {}, noNpm));
      expect(output).toContain('Release notes for pkg-a v1.0.0');
      expect(output).toContain('- **pkg-a:** add a feature');
      // the default template's own heading shouldn't appear when a custom one is used.
      expect(output).not.toContain('## pkg-a 1.0.0');
    });

    it('throws a clear error when the referenced template file does not exist', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { template: './missing-template.md' } }));
      const repo = await Repository.create(dir);
      await expect(ChangelogService.getEntries(repo, {}, noNpm)).rejects.toThrow(/changelog\.template not found/);
    });
  });

  describe('cwd scoping (Repository.currentPackage)', () => {
    it("running from inside a single package only generates that package's changelog", async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(path.join(dir, 'packages/a'));
      const output = content(await ChangelogService.getEntries(repo, {}, noNpm));
      expect(output).toContain('## pkg-a');
      expect(output).not.toContain('## pkg-b');
    });

    it('--root generates for the whole repository even from inside a single package', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(path.join(dir, 'packages/a'));
      const output = content(await ChangelogService.getEntries(repo, { root: true }, noNpm));
      expect(output).toContain('## pkg-a');
      expect(output).toContain('## pkg-b');
    });
  });

  describe('{{version}} resolution from git tags (not package.json)', () => {
    it("falls back to package.json's version when no tag matches anything", async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, {}, noNpm));
      expect(output).toContain('## pkg-a 1.0.0');
    });

    it('the default "v*" pattern uses the nearest repo-wide tag for every package, ignoring a stale package.json version', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      // package.json still says 1.0.0/2.0.0, but the repo has actually moved on to v6.0.8 -
      // exactly the kind of drift that made package.json's version untrustworthy here.
      run('tag', 'v6.0.8');

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, {}, noNpm));
      expect(output).toContain('## pkg-a 6.0.8');
      expect(output).toContain('## pkg-b 6.0.8');
      expect(output).not.toContain('1.0.0');
      expect(output).not.toContain('2.0.0');
    });

    it('"{name}@*" resolves each package\'s own independent version from its own tags', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('tag', 'pkg-a@3.1.0');
      // pkg-b is never tagged - it should still fall back to its own package.json version.
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, {}, noNpm));
      expect(output).toContain('## pkg-a 3.1.0');
      expect(output).toContain('## pkg-b 2.0.0');
    });

    it('"{name}@*" resolves a scoped package name (e.g. "@scope/name") correctly', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/builder/package.json', { name: '@sqb/builder', version: '1.0.0' });
      fs.writeFileSync(dir + '/.rmanrc', JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));
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

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, { from: baseHash }));
      expect(output).toContain('## @sqb/builder 1.2.3');
    });

    it('a package can override the tag pattern for just itself, cascading from the root default', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('tag', 'v6.0.8'); // root default pattern - applies to pkg-b
      run('tag', 'pkg-a@9.9.9'); // pkg-a's own override
      fs.writeFileSync(path.join(dir, 'packages/a/.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, {}, noNpm));
      expect(output).toContain('## pkg-a 9.9.9');
      expect(output).toContain('## pkg-b 6.0.8');
    });
  });

  describe('--from npm (auto-detect per package from its published npm version)', () => {
    it('by default, uses the tag matching the published version as the boundary - not everything unpushed', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));
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

      const repo = await Repository.create(dir);
      const output = content(
        await ChangelogService.getEntries(
          repo,
          {},
          { npmViewVersion: async name => (name === 'pkg-a' ? '1.0.0' : undefined) },
        ),
      );
      expect(output).toContain('a brand new unreleased change');
      expect(output).not.toContain('an already-published change');
    });

    it('"npm" passed explicitly behaves the same as the default', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));
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

      const repo = await Repository.create(dir);
      const output = content(
        await ChangelogService.getEntries(
          repo,
          { from: 'npm' },
          { npmViewVersion: async name => (name === 'pkg-a' ? '1.0.0' : undefined) },
        ),
      );
      expect(output).toContain('a brand new unreleased change');
      expect(output).not.toContain('an already-published change');
    });

    it('falls back to not-yet-pushed commits when the published version has no matching tag in this repo', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);
      const output = content(
        // "9.9.9" was never tagged here - tagging must have lagged behind the publish.
        await ChangelogService.getEntries(repo, {}, { npmViewVersion: async () => '9.9.9' }),
      );
      expect(output).toContain('- **pkg-a:** add a feature');
      expect(output).toContain('- **pkg-b:** correct a bug');
    });

    it('resolves a different boundary per package under independent versioning', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));
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

      const repo = await Repository.create(dir);
      const output = content(
        await ChangelogService.getEntries(
          repo,
          {},
          {
            npmViewVersion: async name => ({ 'pkg-a': '1.0.0', 'pkg-b': '2.0.0' })[name],
          },
        ),
      );
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

      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { tagPattern: '{name}@*' } }));
      run('add', '-A');
      run('commit', '-q', '-m', 'chore: add rmanrc');

      const repo = await Repository.create(dir);
      const output = content(await ChangelogService.getEntries(repo, {}, { npmViewVersion: async () => '1.5.0' }));
      expect(output).toContain('released in 1.2.0, never documented');
      expect(output).toContain('released in 1.5.0');
    });
  });

  describe('ChangelogService.getEntries() - the pure computation ChangelogService.generateToFile() writes on top of', () => {
    it('returns structured entries and never touches the console or CHANGELOG.md files', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);

      const originalLog = console.log;
      const logged: unknown[] = [];
      console.log = (...args: unknown[]) => logged.push(args);
      let entries: ChangelogService.Entry[];
      try {
        entries = await ChangelogService.getEntries(repo, {}, noNpm);
      } finally {
        console.log = originalLog;
      }

      expect(logged).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);

      const pkgA = entries.find(e => e.label === 'pkg-a');
      expect(pkgA).toBeDefined();
      expect(pkgA!.version).toBe('1.0.0');
      expect(pkgA!.features).toEqual(['**pkg-a:** add a feature']);
      expect(pkgA!.content).toContain('## pkg-a 1.0.0');
      expect(pkgA!.filePath).toBe('CHANGELOG.md');

      const root = entries.find(e => e.label === `${path.basename(dir)} repository`);
      expect(root).toBeDefined();
      expect(root!.other).toEqual(['docs: update readme']);
    });

    it('returns [] when there is nothing unreleased', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      const repo = await Repository.create(dir);
      const entries = await ChangelogService.getEntries(repo, {}, noNpm);
      expect(entries).toEqual([]);
    });
  });

  describe('ChangelogService.getEntries()/generateToFile() never touch the console themselves', () => {
    it('produces no console output at all, with or without --write', async () => {
      const { dir } = fixtureWithUnpushedCommits();
      const repo = await Repository.create(dir);

      const originalLog = console.log;
      const logged: unknown[] = [];
      console.log = (...args: unknown[]) => logged.push(args);
      try {
        await ChangelogService.getEntries(repo, {}, noNpm);
        await ChangelogService.generateToFile(repo, {}, noNpm);
      } finally {
        console.log = originalLog;
      }
      expect(logged).toEqual([]);
    });
  });
});
