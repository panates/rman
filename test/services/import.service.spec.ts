import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { ImportService } from '../../src/services/import.service.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-import-test-'));
}

describe('services/import', () => {
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

  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  }

  function initGit(dir: string) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
  }

  /** A standalone source repo with 3 real commits, ready to be imported. */
  function sourceRepoFixture(name = 'my-lib'): string {
    const src = tmp();
    writeJson(src, 'package.json', { name, version: '1.0.0' });
    initGit(src);
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'chore: init');
    fs.writeFileSync(path.join(src, 'index.js'), 'module.exports = 1;');
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'feat: add index.js');
    fs.mkdirSync(path.join(src, 'lib'));
    fs.writeFileSync(path.join(src, 'lib', 'helper.js'), 'module.exports = 2;');
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'feat: add a helper');
    return src;
  }

  function targetRepoFixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    initGit(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init target');
    return dir;
  }

  it('places the source repo\'s files under packages/<name>, defaulting the dest to "packages"', async () => {
    const src = sourceRepoFixture();
    const dir = targetRepoFixture();
    const repo = await Repository.create(dir);

    const result = await ImportService.importRepo(repo, src);

    expect(result.name).toBe('my-lib');
    expect(result.commitCount).toBe(3);
    expect(fs.existsSync(path.join(dir, 'packages/my-lib/package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'packages/my-lib/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'packages/my-lib/lib/helper.js'))).toBe(true);
  });

  it('preserves the full commit history - every original commit is now reachable in the target repo', async () => {
    const src = sourceRepoFixture();
    const dir = targetRepoFixture();
    const repo = await Repository.create(dir);

    await ImportService.importRepo(repo, src);

    const log = git(dir, 'log', '--format=%s');
    expect(log).toContain('chore: init');
    expect(log).toContain('feat: add index.js');
    expect(log).toContain('feat: add a helper');
  });

  it('--dest places it under a different subdirectory', async () => {
    const src = sourceRepoFixture();
    const dir = targetRepoFixture();
    const repo = await Repository.create(dir);

    const result = await ImportService.importRepo(repo, src, { dest: 'libs' });

    expect(fs.existsSync(path.join(dir, 'libs/my-lib/package.json'))).toBe(true);
    expect(result.targetDir).toBe(path.join(dir, 'libs/my-lib'));
  });

  it('uses the directory basename when there is no package.json name to read', async () => {
    const src = tmp();
    initGit(src);
    fs.writeFileSync(path.join(src, 'README.md'), 'hi');
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'init');
    const dir = targetRepoFixture();
    const repo = await Repository.create(dir);

    const result = await ImportService.importRepo(repo, src);
    expect(result.name).toBe(path.basename(src));
  });

  it('strips the scope for the directory name (e.g. "@scope/name" -> "name")', async () => {
    const src = sourceRepoFixture('@myorg/my-lib');
    const dir = targetRepoFixture();
    const repo = await Repository.create(dir);

    const result = await ImportService.importRepo(repo, src);
    expect(result.name).toBe('@myorg/my-lib');
    expect(fs.existsSync(path.join(dir, 'packages/my-lib/package.json'))).toBe(true);
  });

  it('rejects a source path that is not a git repository', async () => {
    const src = tmp();
    const dir = targetRepoFixture();
    const repo = await Repository.create(dir);

    await expect(ImportService.importRepo(repo, src)).rejects.toThrow(/not a git repository/);
  });

  it('rejects when the target directory already exists', async () => {
    const src = sourceRepoFixture();
    const dir = targetRepoFixture();
    fs.mkdirSync(path.join(dir, 'packages/my-lib'), { recursive: true });
    const repo = await Repository.create(dir);

    await expect(ImportService.importRepo(repo, src)).rejects.toThrow(/already exists/);
  });
});
