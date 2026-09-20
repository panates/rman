import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { PublishService } from '../../src/services/publish.service.js';
import { createRepository, useNodeEcosystem } from '../_fixture.js';

/** What one package looks like on the fake registry - see `registry()`. */
type RegistryEntry = string | string[] | { latest?: string; versions: string[] } | undefined;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-publish-test-'));
}

describe('services/publish', () => {
  useNodeEcosystem();

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

  /**
   * A fake registry, resolving strictly from this map so tests never make a real network call.
   *
   * Three shapes, and the third is the one that earns its keep. A bare string is a package with one
   * published version; a list is a linear history, where `latest` is the last of them. **Neither can
   * express a `latest` that is not the newest version** - and that is exactly the shape a prerelease
   * on its own dist-tag produces, so a spec about it has to spell both halves out, or it passes
   * whether `getPlan` consults `versions` or `latest` (measured: with the list form, reverting the
   * fix left the spec green).
   */
  function registry(published: Record<string, RegistryEntry>): PublishService.Deps {
    return {
      npmViewPackage: async name => {
        const entry = published[name];
        if (entry === undefined) return undefined;
        if (typeof entry === 'string') return { latest: entry, versions: [entry] };
        if (Array.isArray(entry)) return { latest: entry[entry.length - 1], versions: entry };
        return entry;
      },
    };
  }

  describe('getPlan()', () => {
    it('a private package is always skipped, regardless of registry state', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', private: true });
      const repo = await createRepository(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'private package' });
    });

    it('.rmanrc "publish.skip" skips a non-private, never-published package too', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { publish: { skip: true } },
      });
      const repo = await createRepository(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({
        status: 'skip',
        reason: 'excluded via .rmanrc "publish.skip"',
      });
    });

    it('never published (registry has nothing) is a publish candidate', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);

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
      const repo = await createRepository(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.0.0' }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'up-to-date', registryVersion: '1.0.0' });
    });

    it('local version differs from the registry (either direction) is a publish candidate', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.2.0' });
      const repo = await createRepository(dir);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.1.0' }));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', registryVersion: '1.1.0' });
    });

    /**
     * The question is "is **this version** already on the registry", and `latest` only approximates
     * it. They part company the moment a prerelease goes out under its own dist-tag - `latest` stays
     * where it was, however many betas follow.
     */
    describe('a version published somewhere other than "latest"', () => {
      it('is up-to-date, even though "latest" points elsewhere', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '2.0.0-beta.0' });
        const repo = await createRepository(dir);

        // The shape a beta loop produces: the beta is out, but "latest" is still the old stable -
        // which is the whole point of publishing it under --tag beta.
        const plan = await PublishService.getPlan(
          repo,
          { tag: 'beta' },
          registry({ 'pkg-a': { latest: '1.3.0', versions: ['1.3.0', '2.0.0-beta.0'] } }),
        );
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'up-to-date', registryVersion: '1.3.0' });
      });

      /** The negative control: without it the spec above passes whether or not `versions` is
       *  consulted, since "up-to-date" is also what a `latest` comparison would say if `latest`
       *  happened to be the beta. Here it is not published at all and must still be a candidate. */
      it('is still a candidate when that version is not published at all', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '2.0.0-beta.1' });
        const repo = await createRepository(dir);

        const plan = await PublishService.getPlan(
          repo,
          { tag: 'beta' },
          registry({ 'pkg-a': { latest: '1.3.0', versions: ['1.3.0', '2.0.0-beta.0'] } }),
        );
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', registryVersion: '1.3.0' });
      });
    });

    /**
     * `npm publish` with no `--tag` writes `latest`, so a prerelease published that way is what
     * every plain install resolves to from then on - and `npm dist-tag` can only move it back after
     * the fact. One forgotten flag, unrecoverable, so the plan refuses.
     */
    describe('a prerelease with no dist-tag', () => {
      async function repoAt(version: string) {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version });
        return createRepository(dir);
      }

      it('is an error naming the flag, rather than a publish candidate', async () => {
        const repo = await repoAt('2.0.0-beta.0');
        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.3.0' }));
        const entry = entryFor(plan, 'pkg-a');
        expect(entry.status).toBe('error');
        expect(entry.reason).toContain('--tag');
      });

      it('--tag latest is the same request spelled out, and is refused the same way', async () => {
        const repo = await repoAt('2.0.0-beta.0');
        const plan = await PublishService.getPlan(repo, { tag: 'latest' }, registry({ 'pkg-a': '1.3.0' }));
        expect(entryFor(plan, 'pkg-a').status).toBe('error');
      });

      it('with its own dist-tag it is an ordinary candidate', async () => {
        const repo = await repoAt('2.0.0-beta.0');
        const plan = await PublishService.getPlan(repo, { tag: 'beta' }, registry({ 'pkg-a': '1.3.0' }));
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish' });
      });

      it('a stable version needs no tag - the guard is about previews only', async () => {
        const repo = await repoAt('2.0.0');
        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.3.0' }));
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish' });
      });

      /**
       * A calendar version's time part *is* a semver prerelease identifier - that is how the time
       * is spelled - so reading it as a preview would refuse an ordinary release. `github-release`
       * rules it out the same way; these two agree deliberately.
       */
      it('a calendar version is not a preview, however semver reads its time part', async () => {
        const repo = await repoAt('2026.9.15-1430');
        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': '1.3.0' }));
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish' });
      });

      /** Ordering pin: a package that is never published at all has no dist-tag to get wrong, so
       *  "private" has to win over the guard rather than the other way round. */
      it('a private package is skipped, not errored', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '2.0.0-beta.0', private: true });
        const repo = await createRepository(dir);
        const plan = await PublishService.getPlan(repo, {}, registry({}));
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'private package' });
      });
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
        const repo = await createRepository(dir);

        let queried = false;
        const plan = await PublishService.getPlan(
          repo,
          {},
          {
            npmViewPackage: async () => {
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
        const repo = await createRepository(dir);

        const plan = await PublishService.getPlan(repo, { ignoreDirty: true }, registry({}));
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'uncommitted local changes' });
      });
    });

    describe('monorepo root', () => {
      it("the root package is never a candidate in a real monorepo (it's never published on its own)", async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
        /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
         *  since it runs before the plugins that would know what a package is. */
        fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
        writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
        const repo = await createRepository(dir);

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
        expect(plan.some(e => e.package === repo.rootPackage)).toBe(false);
      });

      it('in a single-package repo, root is a normal candidate like any other package', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        const repo = await createRepository(dir);

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
        expect(plan.some(e => e.package === repo.rootPackage && e.status === 'publish')).toBe(true);
      });
    });

    it('returns entries in topological order (dependencies before dependents)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);

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
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0', private: true });
      const repo = await createRepository(dir);
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
      const repo = await createRepository(dir);
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
      const repo = await createRepository(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      await PublishService.applyPlan(repo, plan, { contents: 'build' });

      const call = fs.readFileSync(logFile, 'utf-8').trim();
      expect(fs.realpathSync(call.split(' ')[0])).toBe(fs.realpathSync(path.join(dir, 'dist')));
    });

    it('.rmanrc "publish.npm.directory" points the publish at a build dir, without touching package.json', async () => {
      // One "[*]" line for a whole repository, instead of publishConfig.directory in every
      // package.json - which still wins when a package declares one of its own.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { publish: { npm: { directory: 'build' } } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.mkdirSync(path.join(dir, 'packages/a/build'), { recursive: true });
      const repo = await createRepository(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      await PublishService.applyPlan(repo, plan);

      const call = fs.readFileSync(logFile, 'utf-8').trim();
      expect(fs.realpathSync(call.split(' ')[0])).toBe(fs.realpathSync(path.join(dir, 'packages/a/build')));
    });

    /**
     * **The retired spelling is refused, not ignored** - and the reason is what ignoring it would
     * do rather than tidiness. `publish.directory` would simply stop being read, `resolvePublishDir`
     * would fall back to the package's own directory, and the run would push the *source tree* to
     * npm instead of the build output. YAML and JSON configs are unchecked at author time, so this
     * error is the only thing between the old key and a wrong publish.
     *
     * An `'error'` entry, raised in `getPlan`, so it surfaces before anything is published at all.
     */
    it('refuses the retired "publish.directory" instead of quietly publishing the source tree', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { publish: { directory: 'build' } } }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.mkdirSync(path.join(dir, 'packages/a/build'), { recursive: true });
      const repo = await createRepository(dir);
      const { logFile } = stubPublishBin(dir, 'npm');

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined }));
      const entry = plan.find(e => e.package.name === 'pkg-a')!;
      expect(entry.status).toBe('error');
      expect(entry.reason).toContain('publish.npm.directory');
      /** And nothing was published - the plan never reached `'publish'`, so the stubbed `npm` was
       *  never called and its log file does not even exist. */
      await PublishService.applyPlan(repo, plan);
      expect(fs.existsSync(logFile)).toBe(false);
    });

    it("generates the build dir's manifest at publish time, and removes it afterwards", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-dep', version: '2.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        publishConfig: { access: 'public', directory: 'build' },
        dependencies: { 'pkg-dep': 'workspace:^' },
        devDependencies: { mocha: '^10.0.0' },
        scripts: { build: 'tsc', test: 'mocha', postinstall: 'node-gyp rebuild' },
        rman: { publish: { skip: false } },
      });
      fs.mkdirSync(path.join(dir, 'packages/b/build'), { recursive: true });
      const repo = await createRepository(dir);
      // Capture the manifest as npm would see it - the stub runs while it is still on disk.
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const seen = path.join(tmp(), 'seen.json');
      fs.writeFileSync(
        path.join(binDir, 'npm'),
        `#!/usr/bin/env node\nrequire('fs').copyFileSync('package.json', ${JSON.stringify(seen)});\n`,
      );
      fs.chmodSync(path.join(binDir, 'npm'), 0o755);

      const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-dep': '2.0.0', 'pkg-b': undefined }));
      await PublishService.applyPlan(repo, plan);

      const manifest = JSON.parse(fs.readFileSync(seen, 'utf-8'));
      // The "workspace:" rewrite reaches the published manifest - rewriting only the package's own
      // file never did, since npm reads the build dir.
      expect(manifest.dependencies['pkg-dep']).toBe('^2.0.0');
      expect(manifest.devDependencies).toBeUndefined();
      // Only the scripts a consumer's install actually runs survive.
      expect(manifest.scripts).toEqual({ postinstall: 'node-gyp rebuild' });
      // It pointed *here*; kept, it would point one level deeper again.
      expect(manifest.publishConfig).toEqual({ access: 'public' });

      // Nothing left behind: the manifest is a publish-time artifact, not a build output.
      expect(fs.existsSync(path.join(dir, 'packages/b/build/package.json'))).toBe(false);
      // And the package's own file is untouched.
      const own = JSON.parse(fs.readFileSync(path.join(dir, 'packages/b/package.json'), 'utf-8'));
      expect(own.dependencies['pkg-dep']).toBe('workspace:^');
      expect(own.scripts.build).toBe('tsc');
    });

    it('a failed publish blocks its dependents (skipped as "error"), but not unrelated packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });
      const repo = await createRepository(dir);
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
      const repo = await createRepository(dir);
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
        /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
         *  since it runs before the plugins that would know what a package is. */
        fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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
        const repo = await createRepository(dir);
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
        const repo = await createRepository(dir);
        stubPublishBin(dir, 'npm');

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
        await PublishService.applyPlan(repo, plan);

        // Once applyPlan returns, the working-tree file must be back to its original "workspace:^".
        expect(readDeps(dir)['pkg-a']).toBe('workspace:^');
      });

      it('restores the original file even when the publish command itself fails', async () => {
        const dir = fixture('workspace:*');
        const repo = await createRepository(dir);
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
        const repo = await createRepository(dir);
        stubPublishBin(dir, 'npm');

        const plan = await PublishService.getPlan(repo, {}, registry({ 'pkg-a': undefined, 'pkg-b': undefined }));
        await PublishService.applyPlan(repo, plan);

        expect(readDeps(dir)['pkg-a']).toBe('^1.0.0');
      });
    });
  });
});
