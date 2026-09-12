import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Package } from '../../src/core/package.js';
import { detectChangeHash } from '../../src/utils/change-hash.js';
import { GitHelper } from '../../src/utils/git.js';

describe('utils/detectChangeHash', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-change-hash-test-'));
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function makePackage(dir: string, name = 'pkg-a', extraJson: Record<string, unknown> = {}): Package {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extraJson }));
    return new Package(dir);
  }

  function initRepo(dir: string): void {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
  }

  it('returns an explicit hash verbatim, without consulting npm at all', async () => {
    const dir = tmp();
    const pkg = makePackage(dir);
    initRepo(dir);
    const git = new GitHelper({ cwd: dir });

    const hash = await detectChangeHash(git, pkg, {
      from: 'deadbeef',
      npmViewVersion: async () => {
        throw new Error('should not be called for an explicit hash');
      },
    });
    expect(hash).toBe('deadbeef');
  });

  it('auto-detects (default, no "from") the tag matching the published npm version', async () => {
    const dir = tmp();
    const pkg = makePackage(dir);
    initRepo(dir);
    execFileSync('git', ['tag', 'v1.2.3'], { cwd: dir });
    const git = new GitHelper({ cwd: dir });

    const hash = await detectChangeHash(git, pkg, { npmViewVersion: async () => '1.2.3' });
    expect(hash).toBe('v1.2.3');
  });

  it('"from: npm" behaves the same as the default', async () => {
    const dir = tmp();
    const pkg = makePackage(dir);
    initRepo(dir);
    execFileSync('git', ['tag', 'v1.2.3'], { cwd: dir });
    const git = new GitHelper({ cwd: dir });

    const hash = await detectChangeHash(git, pkg, { from: 'npm', npmViewVersion: async () => '1.2.3' });
    expect(hash).toBe('v1.2.3');
  });

  it('respects {name} in tagPattern for independent per-package versioning', async () => {
    const dir = tmp();
    const pkg = makePackage(dir, '@scope/pkg-a');
    // `config` is normally cascaded in by Repository - set directly here since this test
    // constructs a bare Package, to keep the fixture focused on detectChangeHash/tagPattern.
    pkg.config = { changelog: { tagPattern: '{name}@*' } };
    initRepo(dir);
    execFileSync('git', ['tag', '@scope/pkg-a@2.0.0'], { cwd: dir });
    const git = new GitHelper({ cwd: dir });

    const hash = await detectChangeHash(git, pkg, { npmViewVersion: async () => '2.0.0' });
    expect(hash).toBe('@scope/pkg-a@2.0.0');
  });

  it('returns undefined when the package is not published on npm at all', async () => {
    const dir = tmp();
    const pkg = makePackage(dir);
    initRepo(dir);
    const git = new GitHelper({ cwd: dir });

    const hash = await detectChangeHash(git, pkg, { npmViewVersion: async () => undefined });
    expect(hash).toBeUndefined();
  });

  it('returns undefined when the published version has no matching tag in this repo', async () => {
    const dir = tmp();
    const pkg = makePackage(dir);
    initRepo(dir);
    // no "v9.9.9" tag exists here - tagging lagged behind the publish.
    const git = new GitHelper({ cwd: dir });

    const hash = await detectChangeHash(git, pkg, { npmViewVersion: async () => '9.9.9' });
    expect(hash).toBeUndefined();
  });

  describe('catchUpFile (avoiding a documentation gap)', () => {
    it("widens the boundary to the file's own last-modifying commit when it is older than the npm-detected tag", async () => {
      // Reproduces a real gap: a changelog file was last written for 1.1.0, but 1.2.0 and 1.5.0
      // were released without ever documenting them - npm now reports 1.5.0 as published. Using
      // the v1.5.0 tag alone would silently skip the undocumented 1.2.0 change entirely.
      const dir = tmp();
      const pkg = makePackage(dir);
      initRepo(dir);
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

      const changelogFile = path.join(dir, 'CHANGELOG.md');
      fs.writeFileSync(changelogFile, '# Changelog\n\n## 1.1.0\n- initial\n');
      run('add', '-A');
      run('commit', '-q', '-m', 'docs: write changelog for 1.1.0');

      fs.writeFileSync(path.join(dir, 'gap.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: released in 1.2.0, never documented');
      run('tag', 'v1.2.0');

      fs.writeFileSync(path.join(dir, 'more.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: released in 1.5.0');
      run('tag', 'v1.5.0');
      const gapStartHash = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: dir }).toString().trim();

      const git = new GitHelper({ cwd: dir });
      const hash = await detectChangeHash(git, pkg, {
        npmViewVersion: async () => '1.5.0',
        catchUpFile: changelogFile,
      });
      // the commit right before "released in 1.2.0" - i.e. exactly where the file left off,
      // not the v1.5.0 tag, which would have skipped the 1.2.0 change.
      expect(hash).toBe(gapStartHash);
    });

    it('has no effect when the file does not exist', async () => {
      const dir = tmp();
      const pkg = makePackage(dir);
      initRepo(dir);
      execFileSync('git', ['tag', 'v1.5.0'], { cwd: dir });
      const git = new GitHelper({ cwd: dir });

      const hash = await detectChangeHash(git, pkg, {
        npmViewVersion: async () => '1.5.0',
        catchUpFile: path.join(dir, 'CHANGELOG.md'),
      });
      expect(hash).toBe('v1.5.0');
    });

    it('is ignored when "from" is an explicit hash', async () => {
      const dir = tmp();
      const pkg = makePackage(dir);
      initRepo(dir);
      const changelogFile = path.join(dir, 'CHANGELOG.md');
      fs.writeFileSync(changelogFile, '# Changelog\n');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'docs'], {
        cwd: dir,
      });
      const git = new GitHelper({ cwd: dir });

      const hash = await detectChangeHash(git, pkg, { from: 'deadbeef', catchUpFile: changelogFile });
      expect(hash).toBe('deadbeef');
    });

    it("falls back to the file's commit alone when the package is not published on npm", async () => {
      const dir = tmp();
      const pkg = makePackage(dir);
      initRepo(dir);
      const changelogFile = path.join(dir, 'CHANGELOG.md');
      fs.writeFileSync(changelogFile, '# Changelog\n');
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('add', '-A');
      run('commit', '-q', '-m', 'docs: write changelog');
      const docsHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      const git = new GitHelper({ cwd: dir });
      const hash = await detectChangeHash(git, pkg, {
        npmViewVersion: async () => undefined,
        catchUpFile: changelogFile,
      });
      expect(hash).toBe(docsHash);
    });
  });
});
