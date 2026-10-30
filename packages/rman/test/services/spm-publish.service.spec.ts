import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { createRepository, service, useLocalBin, useTestEcosystem } from '../_fixture.js';

describe('services/spm-publish', () => {
  useTestEcosystem();
  /**
   * **Every case runs with a stand-in `spm`.** `useLocalBin` puts each fixture's own `local-bin`
   * ahead of PATH, so nothing here can reach registry.syncbridge.io - the rule `docker`'s and
   * `cloudflare`'s specs follow.
   */
  useLocalBin();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** GitHub Actions' OIDC pair and stdin's TTY, which decide whether a publish may run unattended -
   *  cleared per case, so a spec run from a terminal or from CI sees the same thing. */
  const saved = {
    url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    tty: process.stdin.isTTY,
  };
  beforeEach(() => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    process.stdin.isTTY = false as any;
  });
  afterEach(() => {
    restore('ACTIONS_ID_TOKEN_REQUEST_URL', saved.url);
    restore('ACTIONS_ID_TOKEN_REQUEST_TOKEN', saved.token);
    process.stdin.isTTY = saved.tty;
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function inGitHubActions(): void {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://example.invalid/token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'test';
  }

  function writeJson(dir: string, rel: string, data: unknown): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  /** A committed repository with one package, `@sb/mod` at 1.2.3, carrying `rman` as its config. */
  function repo(rman: unknown = { publish: { target: ['spm'] } }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-spm-test-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'local-bin\nspm-calls.log\n');
    writeJson(dir, 'packages/mod/package.json', { name: '@sb/mod', version: '1.2.3', rman });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return dir;
  }

  /**
   * An `spm` that records its argv and working directory. `view` answers `versions` (or exits 1
   * with `viewFails` on stderr); `publish` prints spm's own skip line when `skip` is set.
   */
  function stubSpm(
    dir: string,
    answer: { versions?: unknown; viewFails?: string; viewRaw?: string; skip?: boolean } = {},
  ): { calls: () => string[] } {
    const bin = path.join(dir, 'local-bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(dir, 'spm-calls.log');
    fs.writeFileSync(
      path.join(bin, 'spm'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, process.cwd() + ' :: ' + args.join(' ') + '\\n');
if (args[0] === 'view') {
  ${answer.viewFails ? `console.error(${JSON.stringify(answer.viewFails)}); process.exit(1);` : ''}
  console.log(${JSON.stringify(answer.viewRaw ?? JSON.stringify({ name: '@sb/mod', versions: answer.versions ?? [] }))});
}
if (args[0] === 'publish' && args.includes('--no-wait') && process.env.RMAN_TEST_SPM_APPROVAL) {
  console.error('Publishing needs an approval in Console');
  process.exit(3);
}
if (args[0] === 'publish') {
  ${answer.skip ? `console.log('- @sb/mod@1.2.3 is already published to https://registry.example: skipped');` : `console.log('+ @sb/mod@1.2.3');`}
}
`,
    );
    fs.chmodSync(path.join(bin, 'spm'), 0o755);
    return {
      calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : []),
    };
  }

  async function plan(dir: string) {
    await createRepository(dir);
    return service('spmPublish').getPlan({});
  }

  describe('getPlan()', () => {
    it('leaves out a package that does not name "spm" - the target is opt-in', async () => {
      const dir = repo({});
      stubSpm(dir);
      expect(await plan(dir)).toEqual([]);
    });

    it('is up-to-date when spm view lists the version, and asks with the package name and registry', async () => {
      const dir = repo({ publish: { target: ['spm'], spm: { registry: 'https://registry.example' } } });
      const spm = stubSpm(dir, { versions: ['1.2.3', '1.2.2'] });
      const [entry] = await plan(dir);
      expect(entry).toMatchObject({ status: 'up-to-date', version: '1.2.3' });
      expect(spm.calls()).toEqual([
        expect.stringMatching(/packages\/mod :: view @sb\/mod --json --registry https:\/\/registry\.example$/),
      ]);
    });

    it('is publish when the version is not listed', async () => {
      const dir = repo();
      stubSpm(dir, { versions: ['1.2.2'] });
      expect((await plan(dir))[0]).toMatchObject({ status: 'publish', reason: 'not published yet' });
    });

    /** The one difference from the npm check, on purpose: a lookup that failed is not an answer. */
    it('is an error, never "not published", when spm view fails', async () => {
      const dir = repo();
      stubSpm(dir, { viewFails: 'error: registry answered 503' });
      const [entry] = await plan(dir);
      expect(entry.status).toBe('error');
      expect(entry.reason).toContain('registry answered 503');
    });

    /** spm's own reason, whatever its wording - measured: `<registry> could not be reached: bad port`. */
    it("carries spm's own reason when it names no error", async () => {
      const dir = repo();
      stubSpm(dir, { viewFails: 'https://127.0.0.1:9 could not be reached: bad port' });
      expect((await plan(dir))[0].reason).toContain('could not be reached: bad port');
    });

    it('is an error when spm view answers no JSON - an spm without the command', async () => {
      const dir = repo();
      stubSpm(dir, { viewRaw: 'Usage: spm [options] [command]' });
      expect((await plan(dir))[0]).toMatchObject({ status: 'error' });
      expect((await plan(dir))[0].reason).toContain('@syncbridge/syncbuild');
    });

    it('says how to install spm when the repository has none', async () => {
      const dir = repo();
      const [entry] = await plan(dir);
      expect(entry.status).toBe('error');
      expect(entry.reason).toContain('@syncbridge/syncbuild');
    });

    it('is an error with a dirty package, and asks the registry nothing', async () => {
      const dir = repo();
      const spm = stubSpm(dir);
      fs.writeFileSync(path.join(dir, 'packages/mod/x.txt'), 'x');
      const [entry] = await plan(dir);
      expect(entry.status).toBe('error');
      expect(entry.reason).toContain('packages/mod/x.txt');
      expect(spm.calls()).toEqual([]);
    });
  });

  describe('applyPlan()', () => {
    /** As the npm target does: a module whose dependency or required peer failed is not tried - its
     *  range points at a version that is not there - while one needing it only optionally is. */
    it('does not try a module whose dependency failed to publish, but does one needing it optionally', async () => {
      inGitHubActions();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-spm-test-'));
      dirs.push(dir);
      const spmTarget = { publish: { target: ['spm'] } };
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'local-bin\n');
      writeJson(dir, 'packages/a/package.json', { name: 'mod-a', version: '1.0.0', rman: spmTarget });
      writeJson(dir, 'packages/b/package.json', {
        name: 'mod-b',
        version: '1.0.0',
        dependencies: { 'mod-a': '^1.0.0' },
        rman: spmTarget,
      });
      writeJson(dir, 'packages/c/package.json', {
        name: 'mod-c',
        version: '1.0.0',
        peerDependencies: { 'mod-a': '^1.0.0' },
        peerDependenciesMeta: { 'mod-a': { optional: true } },
        rman: spmTarget,
      });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const bin = path.join(dir, 'local-bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, 'spm'),
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'view') console.log(JSON.stringify({ versions: [] }));
if (args[0] === 'publish' && process.cwd().endsWith('/a')) { console.error('error: registry refused'); process.exit(1); }
`,
      );
      fs.chmodSync(path.join(bin, 'spm'), 0o755);

      const planned = await plan(dir);
      const applied = await service('spmPublish').applyPlan(planned);
      const statusOf = (name: string) => applied.find(e => e.package.name === name);

      expect(statusOf('mod-a')?.status).toBe('error');
      expect(statusOf('mod-b')).toMatchObject({ status: 'error', reason: 'dependency "mod-a" failed to publish' });
      expect(statusOf('mod-c')?.status).toBe('publish');
    });

    it('publishes in GitHub Actions with --skip-existing and the access it was given', async () => {
      inGitHubActions();
      const dir = repo({ publish: { target: ['spm'], spm: { access: 'public' } } });
      const spm = stubSpm(dir);
      const planned = await plan(dir);
      const [entry] = await service('spmPublish').applyPlan(planned);
      expect(entry.status).toBe('publish');
      expect(spm.calls().at(-1)).toMatch(/packages\/mod :: publish --skip-existing --access public$/);
    });

    /** spm's skip says the version was there already - published by an earlier run, or private and
     *  invisible to the lookup. Not counted as published. */
    it('reports a version spm skipped as up-to-date', async () => {
      inGitHubActions();
      const dir = repo();
      stubSpm(dir, { skip: true });
      const planned = await plan(dir);
      const [entry] = await service('spmPublish').applyPlan(planned);
      expect(entry.status).toBe('up-to-date');
    });

    /** Unattended, spm is told not to wait - and an approval it would have waited for is a
     *  failure that says where to publish from, not a ten-minute hang. */
    it('passes --no-wait with no terminal outside CI, and says why when an approval was needed', async () => {
      process.env.RMAN_TEST_SPM_APPROVAL = '1';
      try {
        const dir = repo();
        const spm = stubSpm(dir);
        const planned = await plan(dir);
        const [entry] = await service('spmPublish').applyPlan(planned);
        expect(spm.calls().at(-1)).toContain(':: publish --skip-existing --no-wait');
        expect(entry.status).toBe('error');
        expect(entry.reason).toContain('approval in Console');
      } finally {
        delete process.env.RMAN_TEST_SPM_APPROVAL;
      }
    });

    /** A registry asking no approval publishes unattended too - the refusal is spm's to make. */
    it('publishes unattended when the registry asks no approval', async () => {
      const dir = repo();
      stubSpm(dir);
      const planned = await plan(dir);
      const [entry] = await service('spmPublish').applyPlan(planned);
      expect(entry.status).toBe('publish');
    });

    it('does not pass --no-wait at a terminal', async () => {
      process.stdin.isTTY = true as any;
      const dir = repo();
      const spm = stubSpm(dir);
      const planned = await plan(dir);
      const [entry] = await service('spmPublish').applyPlan(planned);
      expect(entry.status).toBe('publish');
      expect(spm.calls().at(-1)).not.toContain('--no-wait');
    });
  });
});
