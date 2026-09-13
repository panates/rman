import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { DockerPublishService } from '../../src/services/docker-publish.service.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-docker-publish-test-'));
}

describe('services/docker-publish', () => {
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
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(dir);

      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(plan.some(e => e.package.name === 'pkg-a')).toBe(false);
    });

    it('.rmanrc "release.skip" leaves a docker-targeted package out entirely too', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { release: { skip: true }, publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      const repo = await Repository.create(dir);

      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(plan.some(e => e.package.name === 'pkg-a')).toBe(false);
    });

    it('a package targeting "docker" without "publish.docker.image" errors clearly', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'] } },
      });
      const repo = await Repository.create(dir);

      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({
        status: 'error',
        reason: '"docker" is a publish target but "publish.docker.image" is not configured',
      });
    });

    it('publishes (image tag not on the registry yet)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      const repo = await Repository.create(dir);

      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', image: 'myorg/pkg-a' });
    });

    it('is "up-to-date" when the tag already exists on the registry', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'myorg/pkg-a' } } },
      });
      const repo = await Repository.create(dir);

      const plan = await DockerPublishService.getPlan(repo, {}, registry(true));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'up-to-date' });
    });

    it('prefixes a bare image with --docker-namespace / DOCKERHUB_NAMESPACE', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'pkg-a' } } },
      });
      const repo = await Repository.create(dir);

      delete process.env.DOCKERHUB_NAMESPACE;
      const viaOption = await DockerPublishService.getPlan(repo, { namespace: 'myorg' }, registry(false));
      expect(entryFor(viaOption, 'pkg-a')).toMatchObject({ status: 'publish', image: 'myorg/pkg-a' });

      process.env.DOCKERHUB_NAMESPACE = 'envorg';
      const viaEnv = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(entryFor(viaEnv, 'pkg-a')).toMatchObject({ status: 'publish', image: 'envorg/pkg-a' });
    });

    it('a bare image with no namespace anywhere errors', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'pkg-a' } } },
      });
      const repo = await Repository.create(dir);

      delete process.env.DOCKERHUB_NAMESPACE;
      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(entryFor(plan, 'pkg-a').status).toBe('error');
      expect(entryFor(plan, 'pkg-a').reason).toContain('namespace');
    });

    it('an already-namespaced image ("/" present) is used verbatim', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'someregistry.io/team/pkg-a' } } },
      });
      const repo = await Repository.create(dir);

      delete process.env.DOCKERHUB_NAMESPACE;
      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'publish', image: 'someregistry.io/team/pkg-a' });
    });

    it('a dirty package errors unless ignoreDirty downgrades it to skip', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
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
      const repo = await Repository.create(dir);

      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'error', reason: 'uncommitted local changes' });

      const plan2 = await DockerPublishService.getPlan(repo, { ignoreDirty: true }, registry(false));
      expect(entryFor(plan2, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'uncommitted local changes' });
    });
  });

  describe('applyPlan()', () => {
    /** Drops a fake `docker` executable in `<dir>/node_modules/.bin` that logs its own cwd and full
     *  argv instead of building/pushing anything for real - same technique as
     *  `publish.service.spec.ts`'s own `stubPublishBin`. */
    function stubDockerBin(dir: string): { logFile: string } {
      const binDir = path.join(dir, 'node_modules', '.bin');
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

    it('builds and pushes with platforms/build-contexts/build-args/dockerfile/tags from .rmanrc', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.2.3',
        private: true,
        rman: {
          publish: {
            target: ['docker'],
            docker: {
              image: 'myorg/pkg-a',
              platforms: ['linux/amd64', 'linux/arm64'],
              buildContexts: { root: '../..' },
              buildArgs: { GREETING: 'hello' },
            },
          },
        },
      });
      const repo = await Repository.create(dir);
      const { logFile } = stubDockerBin(dir);
      process.env.DOCKERHUB_USERNAME = 'u';
      process.env.DOCKERHUB_PASSWORD = 'p';

      const plan = await DockerPublishService.getPlan(repo, {}, registry(false));
      await DockerPublishService.applyPlan(repo, plan);

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
  });
});
