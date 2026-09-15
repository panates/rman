import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import expect from 'expect';
import { Repository } from '../../src/core/repository.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-repository-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

describe('core/Repository', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }

  describe('create()', () => {
    it('detects a monorepo from a "workspaces" field and discovers its packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.monorepo).toBe(true);
      expect(
        repo
          .getPackages()
          .map(p => p.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-b']);
    });

    it('treats a directory with no "workspaces" field as a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.monorepo).toBe(false);
      expect(repo.getPackages().map(p => p.name)).toEqual(['solo']);
      expect(repo.rootPackage.name).toBe('solo');
    });

    it('walks upward from a nested cwd to find the workspace root', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const nested = path.join(dir, 'packages', 'a', 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });

      const repo = await Repository.create(nested);
      expect(repo.dirname).toBe(dir);
      expect(repo.monorepo).toBe(true);
    });

    it('stops walking upward at a ".git" boundary that has no "workspaces"', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, '.git'));
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      const nested = path.join(dir, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      writeJson(nested, 'package.json', { name: 'nested', version: '1.0.0' });

      const repo = await Repository.create(nested);
      expect(repo.monorepo).toBe(false);
      expect(repo.rootPackage.name).toBe('nested');
    });
  });

  describe('getPackages() / getPackage()', () => {
    async function fixtureRepo(): Promise<Repository> {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', {
        name: 'pkg-c',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      return Repository.create(dir);
    }

    it('getPackage() finds a package by name, or returns undefined', async () => {
      const repo = await fixtureRepo();
      expect(repo.getPackage('pkg-b')?.name).toBe('pkg-b');
      expect(repo.getPackage('does-not-exist')).toBeUndefined();
    });

    it('getPackages({toposort:true}) orders dependencies before their dependents', async () => {
      const repo = await fixtureRepo();
      const order = repo.getPackages({ toposort: true }).map(p => p.name);
      expect(order.indexOf('pkg-a')).toBeLessThan(order.indexOf('pkg-b'));
      expect(order.indexOf('pkg-b')).toBeLessThan(order.indexOf('pkg-c'));
    });

    it('getPackages({scope}) filters to just the named package(s)', async () => {
      const repo = await fixtureRepo();
      expect(repo.getPackages({ scope: 'pkg-b' }).map(p => p.name)).toEqual(['pkg-b']);
      expect(
        repo
          .getPackages({ scope: ['pkg-a', 'pkg-c'] })
          .map(p => p.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-c']);
      expect(repo.getPackages({ scope: 'does-not-exist' })).toEqual([]);
    });
  });

  describe('currentPackage', () => {
    function fixtureDir(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      return dir;
    }

    it('is undefined when the repository was created from its own root', async () => {
      const dir = fixtureDir();
      expect((await Repository.create(dir)).currentPackage).toBeUndefined();
    });

    it('resolves to the package whose directory the repository was created from', async () => {
      const dir = fixtureDir();
      const repo = await Repository.create(path.join(dir, 'packages/a'));
      expect(repo.currentPackage?.name).toBe('pkg-a');
    });

    it('resolves to the owning package even from a directory nested deep inside it', async () => {
      const dir = fixtureDir();
      const nested = path.join(dir, 'packages/a', 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });
      const repo = await Repository.create(nested);
      expect(repo.currentPackage?.name).toBe('pkg-a');
    });

    it('is undefined for a non-monorepo (a single-package repository is always "at the root")', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      expect((await Repository.create(dir)).currentPackage).toBeUndefined();
    });
  });

  describe('dependency resolution', () => {
    it('populates .dependencies from dependencies/devDependencies/peerDependencies/optionalDependencies, limited to in-repo packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0', lodash: '^4.0.0' },
        devDependencies: { 'pkg-nonexistent': '1.0.0' },
      });
      const repo = await Repository.create(dir);
      // lodash and pkg-nonexistent aren't workspace packages, so they're excluded.
      expect(repo.getPackage('pkg-b')?.dependencies).toEqual(['pkg-a']);
    });

    it('resolves transitive dependencies (a depends on b depends on c => a lists both)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-c': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.dependencies.sort()).toEqual(['pkg-b', 'pkg-c']);
    });

    it('does not loop forever on a 2-cycle, and a package never ends up depending on itself', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.dependencies).toEqual(['pkg-b']);
      expect(repo.getPackage('pkg-b')?.dependencies).toEqual(['pkg-a']);
    });

    it('does not loop forever on a 3-cycle either, and still excludes self from each package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-c': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', {
        name: 'pkg-c',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });

      const repo = await Repository.create(dir);
      // each package transitively reaches the other two, but never itself.
      expect(repo.getPackage('pkg-a')?.dependencies.sort()).toEqual(['pkg-b', 'pkg-c']);
      expect(repo.getPackage('pkg-b')?.dependencies.sort()).toEqual(['pkg-a', 'pkg-c']);
      expect(repo.getPackage('pkg-c')?.dependencies.sort()).toEqual(['pkg-a', 'pkg-b']);
    });

    it('adds extra dependencies declared via a root .rmanrc selector', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[pkg-b]': { dependencies: ['pkg-a'] } }));

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-b')?.dependencies).toEqual(['pkg-a']);
    });
  });

  describe('config cascading (pkg.config)', () => {
    it('the root\'s own config stays the root\'s; a "[*]" block is what reaches the packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ foo: 'root-only', '[*]': { foo: 'all', bar: 'all' } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ bar: 'b-own' }));

      const repo = await Repository.create(dir);
      expect(repo.config).toEqual({ foo: 'root-only' });
      expect(repo.getPackage('pkg-a')?.config).toEqual({ foo: 'all', bar: 'all' });
      expect(repo.getPackage('pkg-b')?.config).toEqual({ foo: 'all', bar: 'b-own' });
    });

    it('evaluates ${{ ... }} per package, in every string value', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '2.0.0', workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            clean: { include: ['build', '../../coverage/${{ basename }}'] },
            changelog: { filePath: '${{ name.split("/")[1] }}-v${{ semver.major(version) }}.md' },
          },
        }),
      );
      writeJson(dir, 'packages/builder/package.json', { name: '@sqb/builder', version: '6.0.9' });

      const repo = await Repository.create(dir);
      // `basename` is the directory, not the package name - they differ for a scoped package.
      expect(repo.getPackage('@sqb/builder')?.config.clean?.include).toEqual(['build', '../../coverage/builder']);
      // Real JavaScript, so there is no list of substitutions to keep growing.
      expect(repo.getPackage('@sqb/builder')?.config.changelog?.filePath).toBe('builder-v6.md');
    });

    it("a string that is nothing but one expression keeps the value's own type", async () => {
      // Otherwise this could only ever produce strings, and a boolean setting like
      // run.<script>.skip would be unreachable from an expression.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': { run: { build: { skip: '${{ pkg.private === true }}', concurrency: '${{ 2 + 2 }}' } } },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', private: true });

      const repo = await Repository.create(dir);
      const cfg = repo.getPackage('pkg-a')?.config.run?.build as Record<string, unknown>;
      expect(cfg.skip).toBe(true);
      expect(cfg.concurrency).toBe(4);
    });

    it('leaves a bare {{...}} alone - it belongs to whatever else reads the command', async () => {
      // `helm template --set tag={{.Values.tag}}` must survive untouched; that is why the
      // delimiter is ${{ }} and not {{ }}.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { run: { deploy: 'helm template --set tag={{.Values.tag}}' } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.deploy).toBe('helm template --set tag={{.Values.tag}}');
    });

    it('a failing expression names the config path holding it, instead of passing through', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { run: { build: { after: ['ok', '${{ nope.split("/") }}'] } } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      await expect(Repository.create(dir)).rejects.toThrow(/run\.build\.after\[1\]/);
    });
  });

  describe('listStatus()', () => {
    let dir: string;
    let originDir: string;
    let repo: Repository;
    let baseHash: string;

    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();

    before(async () => {
      dir = tmp();
      originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);

      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/untouched/package.json', { name: 'untouched', version: '1.0.0' });
      writeJson(dir, 'packages/committed/package.json', { name: 'committed', version: '1.0.0' });
      writeJson(dir, 'packages/dirty/package.json', { name: 'dirty', version: '1.0.0' });

      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      baseHash = git('rev-parse', 'HEAD');

      git('remote', 'add', 'origin', originDir);
      git('branch', '-M', 'main');
      git('push', '-u', 'origin', 'main', '-q');

      fs.writeFileSync(path.join(dir, 'packages/committed/file.txt'), 'v2');
      git('add', '-A');
      git('commit', '-q', '-m', 'change committed pkg');

      fs.writeFileSync(path.join(dir, 'packages/dirty/file.txt'), 'uncommitted');

      repo = await Repository.create(dir);
    });

    it('reports dirty/committed/clean relative to upstream when no hash is given', async () => {
      const status = await repo.listStatus();
      expect(status.dirty).toBe('dirty');
      expect(status.committed).toBe('committed');
      expect(status.untouched).toBe('clean');
    });

    it('dirty always takes priority over committed', async () => {
      // the "committed" package has no working-tree changes, so it should never show as dirty.
      const status = await repo.listStatus();
      expect(status.committed).not.toBe('dirty');
    });

    it('with a hash, resolves to changed/clean instead of dirty/committed - except dirty still wins', async () => {
      const status = await repo.listStatus({ hash: baseHash });
      expect(status.committed).toBe('changed');
      expect(status.untouched).toBe('clean');
      expect(status.dirty).toBe('dirty');
    });
  });
});
