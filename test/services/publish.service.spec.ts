import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { PublishService } from '../../src/services/publish.service.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-publish-test-'));
}

describe('services/publish', () => {
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

  function entryFor(plan: PublishService.Entry[], name: string): PublishService.Entry {
    const e = plan.find(p => p.package.name === name);
    if (!e) throw new Error(`no plan entry for "${name}"`);
    return e;
  }

  /** A fake registry: `npmViewVersion` deps override resolving strictly from this map, so tests
   *  never make a real network call. */
  function registry(versions: Record<string, string | undefined>): PublishService.Deps {
    return { npmViewVersion: async name => versions[name] };
  }

  describe('getPlan()', () => {
    it('a private package is always skipped, regardless of registry state', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', private: true });
      const repo = await Repository.create(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'private package' });
    });

    it('never published (registry has nothing) is a publish candidate', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({
        status: 'publish',
        version: '1.0.0',
        reason: 'never published',
      });
    });

    it('local version already on the registry is up-to-date, not a candidate', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.0.0' }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'up-to-date', registryVersion: '1.0.0' });
    });

    it('local version differs from the registry (either direction) is a publish candidate', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.2.0' });
      const repo = await Repository.create(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.1.0' }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', registryVersion: '1.1.0' });
    });

    describe('dirty packages', () => {
      it('without ignoreDirty, a dirty package aborts (status "error") and is never queried', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['add', '-A'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
          cwd: dir,
        });
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
        const repo = await Repository.create(dir);

        let queried = false;
        const plan = await PublishService.getPlan(
          repo,
          {},
          {
            npmViewVersion: async () => {
              queried = true;
              return undefined;
            },
          },
        );
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'error', reason: 'uncommitted local changes' });
        expect(queried).toBe(false);
      });

      it('with ignoreDirty, the dirty package is excluded (status "skip") instead', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        execFileSync('git', ['init', '-q'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
        const repo = await Repository.create(dir);

        const plan = await PublishService.getPlan(repo, { ignoreDirty: true }, registry({}));
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'uncommitted local changes' });
      });
    });

    describe('monorepo root', () => {
      it("the root package is never a candidate in a real monorepo (it's never published on its own)", async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
        writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
        const repo = await Repository.create(dir);

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
        expect(plan.some(e => e.package === repo.rootPackage)).toBe(false);
      });

      it('in a single-package repo, root is a normal candidate like any other package', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        const repo = await Repository.create(dir);

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
        expect(plan.some(e => e.package === repo.rootPackage && e.status === 'publish')).toBe(true);
      });
    });

    it('returns entries in topological order (dependencies before dependents)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
      const names = plan.map(e => e.package.name);
      expect(names.indexOf('pkg-a')).toBeLessThan(names.indexOf('pkg-b'));
    });
  });

  describe('applyPlan()', () => {
    /** Drops a fake `<name>` executable in `<dir>/node_modules/.bin` that logs its own cwd (and the
     *  full argv it was called with) instead of publishing anything for real - `exec()`'s own
     *  PATH-augmentation (see utils/exec.spec.ts) finds it ahead of a real npm, and unlike `ci`
     *  nothing here deletes `node_modules` first, so the shim survives to be actually invoked. */
    function stubPublishBin(dir: string, name: string): { logFile: string } {
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const logFile = path.join(tmp(), `${name}-calls.log`);
      const script = path.join(binDir, name);
      fs.writeFileSync(
        script,
        `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, process.cwd() + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`,
      );
      fs.chmodSync(script, 0o755);
      return { logFile };
    }

    it('publishes every "publish" entry via the configured package manager, skipping "skip"/"up-to-date"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0', private: true });
      const repo = await Repository.create(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      await PublishService.applyPlan(repo, plan);

      const calls = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      expect(calls.length).toBe(1);
      expect(fs.realpathSync(calls[0].split(' ')[0])).toBe(fs.realpathSync(path.join(dir, 'packages/a')));
    });

    it('passes --access/--tag/--otp/--registry/--userconfig through to the publish command', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      await PublishService.applyPlan(repo, plan, {
        access: 'public',
        tag: 'next',
        otp: '123456',
        registry: 'https://example.com',
        userconfig: '/tmp/.npmrc',
      });

      const call = fs.readFileSync(logFile, 'utf-8').trim();
      expect(call).toContain('publish --access public --tag next --otp 123456 --registry https://example.com');
      expect(call).toContain('--userconfig /tmp/.npmrc');
    });

    it("respects the package's own package.json publishConfig.directory over --contents", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0', publishConfig: { directory: 'dist' } });
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      const repo = await Repository.create(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      await PublishService.applyPlan(repo, plan, { contents: 'build' });

      const call = fs.readFileSync(logFile, 'utf-8').trim();
      expect(fs.realpathSync(call.split(' ')[0])).toBe(fs.realpathSync(path.join(dir, 'dist')));
    });

    it('a failed publish blocks its dependents (skipped as "error"), but not unrelated packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });
      const repo = await Repository.create(dir);
      // "npm" for pkg-a fails outright; pkg-c gets a real stub so it can still succeed independently.
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'npm'), `#!/usr/bin/env node\nprocess.exit(1);\n`);
      fs.chmodSync(path.join(binDir, 'npm'), 0o755);

      const plan = await PublishService.getPlan(
        repo,
        {},
        registry({ 'pkg-a': undefined, 'pkg-b': undefined, 'pkg-c': undefined }),
      );
      const applied = await PublishService.applyPlan(repo, plan);

      expect(entryFor(applied, 'pkg-a').status).toBe('error');
      expect(entryFor(applied, 'pkg-b')).toMatchObject({
        status: 'error',
        reason: 'dependency "pkg-a" failed to publish',
      });
      expect(entryFor(applied, 'pkg-c').status).toBe('error'); // its own "npm publish" also fails (same fake bin)
    });

    it('a skip/up-to-date entry passes through applyPlan untouched, never invoking the package manager', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.0.0' }));
      const applied = await PublishService.applyPlan(repo, plan);

      expect(entryFor(applied, 'pkg-a').status).toBe('up-to-date');
      expect(fs.existsSync(logFile)).toBe(false);
    });

    describe('"workspace:" protocol dependency ranges', () => {
      function fixture(pkgBDependencyRange: string): string {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
        writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.2.3' });
        writeJson(dir, 'packages/b/package.json', {
          name: 'pkg-b',
          version: '1.0.0',
          dependencies: { 'pkg-a': pkgBDependencyRange },
        });
        return dir;
      }

      function readDeps(dir: string): Record<string, string> {
        return JSON.parse(fs.readFileSync(path.join(dir, 'packages/b/package.json'), 'utf-8')).dependencies;
      }

      /** Unlike `stubPublishBin` (which only logs its own cwd/argv), this shim reads and logs the
       *  `package.json` it actually sees *at the moment it runs* - the only way to observe the
       *  rewritten range, since `applyPlan` restores the original file right after the publish
       *  command returns (in its `finally`), before control ever gets back to the test. */
      function stubPublishBinCapturingDeps(dir: string): { logFile: string } {
        const binDir = path.join(dir, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        const logFile = path.join(tmp(), 'npm-deps-seen.log');
        fs.writeFileSync(
          path.join(binDir, 'npm'),
          `#!/usr/bin/env node\n` +
            `const fs = require('fs');\n` +
            `const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));\n` +
            `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(pkg.dependencies || {}) + '\\n');\n`,
        );
        fs.chmodSync(path.join(binDir, 'npm'), 0o755);
        return { logFile };
      }

      it('rewrites a bare "workspace:*" range to the dependency\'s exact current version for the publish call', async () => {
        const dir = fixture('workspace:*');
        const repo = await Repository.create(dir);
        const { logFile } = stubPublishBinCapturingDeps(dir);

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
        await PublishService.applyPlan(repo, plan);

        const seen = fs
          .readFileSync(logFile, 'utf-8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line));
        const seenForB = seen.find(deps => 'pkg-a' in deps);
        expect(seenForB['pkg-a']).toBe('1.2.3');
      });

      it('rewrites "workspace:^"/"workspace:~" to a real "^"/"~" range, and restores the original file afterward', async () => {
        const dir = fixture('workspace:^');
        const repo = await Repository.create(dir);
        stubPublishBin(dir, 'npm');

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
        await PublishService.applyPlan(repo, plan);

        // Once applyPlan returns, the working-tree file must be back to its original "workspace:^".
        expect(readDeps(dir)['pkg-a']).toBe('workspace:^');
      });

      it('restores the original file even when the publish command itself fails', async () => {
        const dir = fixture('workspace:*');
        const repo = await Repository.create(dir);
        const binDir = path.join(dir, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'npm'), `#!/usr/bin/env node\nprocess.exit(1);\n`);
        fs.chmodSync(path.join(binDir, 'npm'), 0o755);

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
        const applied = await PublishService.applyPlan(repo, plan);

        expect(entryFor(applied, 'pkg-b').status).toBe('error');
        expect(readDeps(dir)['pkg-a']).toBe('workspace:*');
      });

      it('leaves a package with no "workspace:" ranges untouched (no extra disk I/O)', async () => {
        const dir = fixture('^1.0.0');
        const repo = await Repository.create(dir);
        stubPublishBin(dir, 'npm');

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
        await PublishService.applyPlan(repo, plan);

        expect(readDeps(dir)['pkg-a']).toBe('^1.0.0');
      });
    });
  });
});
