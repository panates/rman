import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { DockerPublishService } from '../../src/builtins/publish-targets/docker/docker-publish.service.js';
import { createRepository, service, useLocalBin, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-docker-publish-test-'));
}

describe('services/docker-publish', () => {
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

  const originalNamespace = process.env.DOCKERHUB_NAMESPACE;
  const originalUsername = process.env.DOCKERHUB_USERNAME;
  const originalPassword = process.env.DOCKERHUB_PASSWORD;
  afterEach(() => {
    process.env.DOCKERHUB_NAMESPACE = originalNamespace;
    process.env.DOCKERHUB_USERNAME = originalUsername;
    process.env.DOCKERHUB_PASSWORD = originalPassword;
  });

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  function entryFor(plan: DockerPublishService.Entry[], name: string): DockerPublishService.Entry {
    const e = plan.find(p => p.package.name === name);
    if (!e) throw new Error(`no plan entry for "${name}"`);
    return e;
  }

  function registry(exists: boolean): DockerPublishService.Deps {
    return { imageExists: async () => exists };
  }

  describe('getPlan()', () => {
    it('a package not targeting "docker" at all is left out of the plan entirely', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      await createRepository(dir);

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(plan.some(e => e.package.name === 'pkg-a')).toBe(false);
    });

    it('.rmanrc "publish.skip" leaves a docker-targeted package out entirely too', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { skip: true, target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      await createRepository(dir);

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(plan.some(e => e.package.name === 'pkg-a')).toBe(false);
    });

    it('a package targeting "docker" without "publish.docker.image" errors clearly', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'] } },
      });
      await createRepository(dir);

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({
        status: 'error',
        reason: '"docker" is a publish target but "publish.docker.image" is not configured',
      });
    });

    it('publishes (image tag not on the registry yet)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      await createRepository(dir);

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', image: 'myorg/pkg-a' });
    });

    it('is "up-to-date" when the tag already exists on the registry', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      await createRepository(dir);

      const plan = await service('dockerPublish').getPlan({}, registry(true));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'up-to-date' });
    });

    it('prefixes a bare image with --docker-namespace / DOCKERHUB_NAMESPACE', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'pkg-a' } } },
      });
      await createRepository(dir);

      delete process.env.DOCKERHUB_NAMESPACE;
      const viaOption = await service('dockerPublish').getPlan({ namespace: 'myorg' }, registry(false));
      expect(entryFor(viaOption, 'pkg-a')).toMatchObject({ status: 'publish', image: 'myorg/pkg-a' });

      process.env.DOCKERHUB_NAMESPACE = 'envorg';
      const viaEnv = await service('dockerPublish').getPlan({}, registry(false));
      expect(entryFor(viaEnv, 'pkg-a')).toMatchObject({ status: 'publish', image: 'envorg/pkg-a' });
    });

    it('a bare image with no namespace anywhere errors', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'pkg-a' } } },
      });
      await createRepository(dir);

      delete process.env.DOCKERHUB_NAMESPACE;
      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(entryFor(plan, 'pkg-a').status).toBe('error');
      expect(entryFor(plan, 'pkg-a').reason).toContain('namespace');
    });

    it('an already-namespaced image ("/" present) is used verbatim', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'someregistry.io/team/pkg-a' } } },
      });
      await createRepository(dir);

      delete process.env.DOCKERHUB_NAMESPACE;
      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', image: 'someregistry.io/team/pkg-a' });
    });

    it('a dirty package errors unless ignoreDirty downgrades it to skip', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
        cwd: dir,
      });
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'dirty');
      await createRepository(dir);

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({
        status: 'error',
        reason: 'uncommitted local changes: packages/a/x.txt',
      });

      const plan2 = await service('dockerPublish').getPlan({ ignoreDirty: true }, registry(false));
      expect(entryFor(plan2, 'pkg-a')).toMatchObject({
        status: 'skip',
        reason: 'uncommitted local changes: packages/a/x.txt',
      });
    });
  });

  describe('applyPlan()', () => {
    /**
     * Drops a fake `docker` executable that logs its own cwd and full argv instead of
     * building/pushing anything for real - same technique as `publish.service.spec.ts`'s own
     * `stubPublishBin`.
     *
     * **The `BinPath` provider below is what makes the stub win**, and it is not optional: `exec`
     * puts only what a provider offers ahead of the inherited PATH, and rman's core has none. With
     * no provider the stub was invisible and the **real** `docker` ran - measured, and it got as far
     * as `registry-1.docker.io` before the daemon refused it. A test must not be one credential away
     * from pushing an image.
     */
    useLocalBin();

    function stubDockerBin(dir: string): { logFile: string } {
      const binDir = path.join(dir, 'local-bin');
      fs.mkdirSync(binDir, { recursive: true });
      const logFile = path.join(tmp(), 'docker-calls.log');
      const script = path.join(binDir, 'docker');
      fs.writeFileSync(
        script,
        `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, process.cwd() + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`,
      );
      fs.chmodSync(script, 0o755);
      return { logFile };
    }

    it('builds and pushes with architectures/build-contexts/build-args/dockerfile/tags from .rmanrc', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.3',
        private: true,
        rman: {
          publish: {
            target: ['docker'],
            docker: {
              image: 'myorg/pkg-a',
              architectures: ['linux/amd64', 'linux/arm64'],
              buildContexts: { root: '../..' },
              buildArgs: { GREETING: 'hello' },
            },
          },
        },
      });
      await createRepository(dir);
      const { logFile } = stubDockerBin(dir);
      process.env.DOCKERHUB_USERNAME = 'u';
      process.env.DOCKERHUB_PASSWORD = 'p';

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      await service('dockerPublish').applyPlan(plan);

      // The shim receives shell-parsed argv (the shell strips the command string's own quoting
      // before exec-ing it), so assertions here match unquoted values, not the quoted command
      // string `buildAndPush` itself constructs.
      const calls = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      const buildCall = calls.find(c => c.includes('buildx build'))!;
      expect(fs.realpathSync(buildCall.split(' ')[0])).toBe(fs.realpathSync(path.join(dir, 'packages/a')));
      expect(buildCall).toContain('--platform linux/amd64,linux/arm64');
      const contextMatch = /--build-context root=(\S+)/.exec(buildCall);
      expect(contextMatch && fs.realpathSync(contextMatch[1])).toBe(fs.realpathSync(dir));
      expect(buildCall).toContain('--build-arg GREETING=hello');
      expect(buildCall).toContain('-t myorg/pkg-a:1.2.3');
      expect(buildCall).toContain('-t myorg/pkg-a:latest');
      expect(buildCall).toContain('--push');
    });

    /** A package at `version`, configured with `docker`, built through the recording shim - the
     *  `buildx build` line it ran, or the entry when the build never started. */
    async function buildWith(version: string, docker: Record<string, unknown>) {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version,
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a', ...docker } } },
      });
      fs.writeFileSync(path.join(dir, 'packages/a/cert.pem'), 'pem');
      await createRepository(dir);
      const { logFile } = stubDockerBin(dir);
      process.env.DOCKERHUB_USERNAME = 'u';
      process.env.DOCKERHUB_PASSWORD = 'p';
      const plan = await service('dockerPublish').getPlan({}, registry(false));
      const [result] = await service('dockerPublish').applyPlan(plan);
      const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').trim().split('\n') : [];
      return { dir, plan, result: result!, build: calls.find(c => c.includes('buildx build')) };
    }

    it('passes secrets, labels, the target stage, the cache and extra tags to the build', async () => {
      process.env.RMAN_TEST_NPM_TOKEN = 'secret';
      try {
        const { dir, build } = await buildWith('1.2.3', {
          secrets: { npm_token: '$RMAN_TEST_NPM_TOKEN', cert: 'cert.pem' },
          labels: { team: 'platform' },
          target: 'runtime',
          cache: { from: 'type=gha', to: ['type=gha,mode=max'] },
          tags: ['1', '1.2'],
        });
        expect(build).toContain('--secret id=npm_token,env=RMAN_TEST_NPM_TOKEN');
        expect(build).toContain(`--secret id=cert,src=${path.join(dir, 'packages/a/cert.pem')}`);
        expect(build).toContain('--label team=platform');
        expect(build).toContain('--target runtime');
        expect(build).toContain('--cache-from type=gha');
        expect(build).toContain('--cache-to type=gha,mode=max');
        for (const tag of ['1.2.3', 'latest', '1', '1.2']) expect(build).toContain(`-t myorg/pkg-a:${tag} `);
      } finally {
        delete process.env.RMAN_TEST_NPM_TOKEN;
      }
    });

    /** A secret's value never appears on the command line - only the variable's name. */
    it('fails the package when a secret names a variable that is not set, before building', async () => {
      const { result, build } = await buildWith('1.2.3', { secrets: { npm_token: '$RMAN_TEST_UNSET' } });
      expect(result).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/RMAN_TEST_UNSET, which is not set/),
      });
      expect(build).toBeUndefined();
    });

    /**
     * **A prerelease is not `latest`.** Every image was pushed as `latest`, a beta included, so a
     * plain `docker pull` took whatever went up last - npm's dist-tag rule, missing on this registry.
     */
    it('pushes a prerelease under its identifier, not latest - and shows it in the plan', async () => {
      const beta = await buildWith('2.0.0-beta.1', {});
      expect(beta.plan[0]!.detail).toBe('myorg/pkg-a:2.0.0-beta.1, beta');
      expect(beta.build).toContain('-t myorg/pkg-a:beta ');
      expect(beta.build).not.toContain(':latest');

      const numeric = await buildWith('2.0.0-1', {});
      expect(numeric.plan[0]!.detail).toBe('myorg/pkg-a:2.0.0-1');

      const release = await buildWith('2.0.0', {});
      expect(release.plan[0]!.detail).toBe('myorg/pkg-a:2.0.0, latest');
    });

    /**
     * **A failed build says why.** It ran with `stdio: 'inherit'`, and the reason left was the exit
     * code alone - measured on `panates/syncbridge`, where the cause was an `npm install` inside the
     * image asking for a version not yet published, forty lines above a recap reading
     * `Command failed (1)`. The output is a BuildKit one: step prefixes, and the failing step printed
     * twice.
     */
    it('carries the error lines of a failed build in its reason, once each', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.3',
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      await createRepository(dir);
      const binDir = path.join(dir, 'local-bin');
      fs.mkdirSync(binDir, { recursive: true });
      const failing = [
        '#42 31.01 npm error code ETARGET',
        '#42 31.01 npm error notarget No matching version found for @scope/common@^0.13.9.',
        '#42 31.02 npm error A complete log of this run can be found in: /root/.npm/_logs/x.log',
        '31.01 npm error notarget No matching version found for @scope/common@^0.13.9.',
        'ERROR: failed to build: failed to solve: exit code: 1',
      ];
      fs.writeFileSync(
        path.join(binDir, 'docker'),
        `#!/usr/bin/env node\nif (process.argv.includes('build')) { console.error(${JSON.stringify(failing.join('\n'))}); process.exit(1); }\n`,
      );
      fs.chmodSync(path.join(binDir, 'docker'), 0o755);
      process.env.DOCKERHUB_USERNAME = 'u';
      process.env.DOCKERHUB_PASSWORD = 'p';

      const plan = await service('dockerPublish').getPlan({}, registry(false));
      const write = process.stderr.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      let applied;
      try {
        applied = await service('dockerPublish').applyPlan(plan);
      } finally {
        process.stderr.write = write;
      }

      const entry = applied.find(e => e.package.name === 'pkg-a')!;
      expect(entry.status).toBe('error');
      expect(entry.reason!.split('\n')).toEqual([
        'docker build exited with code 1:',
        '    npm error code ETARGET',
        '    npm error notarget No matching version found for @scope/common@^0.13.9.',
        '    ERROR: failed to build: failed to solve: exit code: 1',
      ]);
    });
  });
});
