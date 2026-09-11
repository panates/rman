import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import expect from 'expect';
import { GitHelper } from '../../src/utils/git.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-git-test-'));
}

describe('utils/GitHelper', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }

  describe('listDirtyFiles()', () => {
    it('returns [] outside a git repository, without throwing', async () => {
      const dir = tmp();
      const git = new GitHelper({ cwd: dir });
      expect(await git.listDirtyFiles()).toEqual([]);
    });

    it('parses the porcelain status line correctly, including the very first file', async () => {
      // Regression test: `listDirtyFiles` used to `.trim()` the *whole* stdout before splitting,
      // which ate the leading space of the first porcelain line's fixed-width status prefix
      // (" M ") and silently chopped the first character off the first file's name.
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'v2');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listDirtyFiles()).toEqual(['file.txt']);
    });

    it('reports multiple dirty files, tracked and untracked alike', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2');
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new');

      const git = new GitHelper({ cwd: dir });
      expect((await git.listDirtyFiles()).sort()).toEqual(['tracked.txt', 'untracked.txt']);
    });

    it('with absolute:true, joins each path onto cwd', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'v1');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listDirtyFiles({ absolute: true })).toEqual([path.join(dir, 'file.txt')]);
    });
  });

  describe('listCommittedFiles()', () => {
    it('returns [] when there is no upstream configured, without throwing', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listCommittedFiles()).toEqual([]);
    });

    it('lists files committed locally but not yet pushed to the tracked upstream', async () => {
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);

      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('remote', 'add', 'origin', originDir);
      run('branch', '-M', 'main');
      run('push', '-u', 'origin', 'main', '-q');

      fs.writeFileSync(path.join(dir, 'b.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'local only');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listCommittedFiles()).toEqual(['b.txt']);
    });
  });

  describe('listChangedSince()', () => {
    it('lists files that differ from the given commit, committed diffs and uncommitted edits alike', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
      run('add', '-A');
      run('commit', '-q', '-m', 'change a');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'v2-dirty');

      const git = new GitHelper({ cwd: dir });
      expect((await git.listChangedSince(baseHash)).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('throws a clear error for an invalid hash instead of silently returning []', async () => {
      const dir = tmp();
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const git = new GitHelper({ cwd: dir });
      await expect(git.listChangedSince('not-a-real-hash')).rejects.toThrow(/Unable to compute changes since/);
    });
  });

  describe('listCommits()', () => {
    it('returns [] when there is no upstream configured and no hash given, without throwing', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listCommits()).toEqual([]);
    });

    it('without a hash, lists commits not yet pushed to the tracked upstream, oldest first, with their files', async () => {
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);

      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('remote', 'add', 'origin', originDir);
      run('branch', '-M', 'main');
      run('push', '-u', 'origin', 'main', '-q');

      fs.writeFileSync(path.join(dir, 'b.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: add b');
      fs.writeFileSync(path.join(dir, 'c.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'fix: correct c');

      const git = new GitHelper({ cwd: dir });
      const commits = await git.listCommits();
      expect(commits.map(c => c.subject)).toEqual(['feat: add b', 'fix: correct c']);
      expect(commits[0].files).toEqual([path.join(dir, 'b.txt')]);
      expect(commits[1].files).toEqual([path.join(dir, 'c.txt')]);
      expect(commits[0].sha).toMatch(/^[a-f0-9]{40}$/);
    });

    it('with a hash, lists commits made since that ref, oldest first', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
      run('add', '-A');
      run('commit', '-q', '-m', 'chore: bump a');

      const git = new GitHelper({ cwd: dir });
      const commits = await git.listCommits({ hash: baseHash });
      expect(commits.map(c => c.subject)).toEqual(['chore: bump a']);
    });

    it('throws a clear error for an invalid hash instead of silently returning []', async () => {
      const dir = tmp();
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const git = new GitHelper({ cwd: dir });
      await expect(git.listCommits({ hash: 'not-a-real-hash' })).rejects.toThrow(/Unable to list commits since/);
    });
  });

  describe('listTags()', () => {
    it('returns [] when there are no matching tags, without throwing', async () => {
      const dir = tmp();
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const git = new GitHelper({ cwd: dir });
      expect(await git.listTags('v*')).toEqual([]);
    });

    it('lists tags matching the glob, newest version first', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('tag', 'v1.0.0');
      run('tag', 'v1.2.0');
      run('tag', 'other-tag');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listTags('v*')).toEqual(['v1.2.0', 'v1.0.0']);
    });

    it('supports a scoped-package-style tag pattern (e.g. "@scope/name@*")', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('tag', '@sqb/builder@1.0.0');
      run('tag', '@sqb/builder@1.2.0');
      run('tag', '@sqb/connect@9.9.9');

      const git = new GitHelper({ cwd: dir });
      expect(await git.listTags('@sqb/builder@*')).toEqual(['@sqb/builder@1.2.0', '@sqb/builder@1.0.0']);
    });
  });

  describe('describeTag()', () => {
    it('returns undefined when no matching tag is reachable from HEAD', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      const git = new GitHelper({ cwd: dir });
      expect(await git.describeTag('v*')).toBeUndefined();
    });

    it('finds the nearest matching tag HEAD descends from, even with newer commits on top', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      run('tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
      run('add', '-A');
      run('commit', '-q', '-m', 'chore: unreleased change');

      const git = new GitHelper({ cwd: dir });
      expect(await git.describeTag('v*')).toBe('v1.0.0');
    });
  });

  describe('lastCommitTouching()', () => {
    it('returns the most recent commit that changed the file', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const firstHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'v2');
      run('add', '-A');
      run('commit', '-q', '-m', 'touches only the other file');

      const git = new GitHelper({ cwd: dir });
      expect(await git.lastCommitTouching(path.join(dir, 'a.txt'))).toBe(firstHash);
    });

    it('returns undefined for a file that has never been committed', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');

      const git = new GitHelper({ cwd: dir });
      expect(await git.lastCommitTouching(path.join(dir, 'never-committed.txt'))).toBeUndefined();
    });
  });

  describe('mergeBase()', () => {
    it('returns the common ancestor of two commits', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
      run('add', '-A');
      run('commit', '-q', '-m', 'second');
      const secondHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      const git = new GitHelper({ cwd: dir });
      // linear history - the older commit is its own common ancestor with a later descendant.
      expect(await git.mergeBase(baseHash, secondHash)).toBe(baseHash);
    });

    it('returns undefined for an invalid ref, instead of throwing', async () => {
      const dir = tmp();
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      const git = new GitHelper({ cwd: dir });
      expect(await git.mergeBase(hash, 'deadbeef')).toBeUndefined();
    });
  });
});
