import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { CloudflarePublishService } from '../../src/builtins/publish-targets/cloudflare/cloudflare-publish.service.js';
import { createRepository, service, useLocalBin, useTestEcosystem } from '../_fixture.js';

describe('services/cloudflare-publish', () => {
  useTestEcosystem();
  /**
   * **Every case runs with a stand-in `wrangler`.** `useLocalBin` puts each fixture's own
   * `local-bin` ahead of PATH; a case that reached the real one with credentials in the environment
   * would deploy. The same rule `docker`'s spec follows.
   */
  useLocalBin();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const saved = { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  });
  afterEach(() => {
    restore('CLOUDFLARE_API_TOKEN', saved.token);
    restore('CLOUDFLARE_ACCOUNT_ID', saved.account);
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function writeJson(dir: string, rel: string, data: unknown): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  /** A repository with one package, `pkg-a` at 1.2.3, carrying `rman` as its config. */
  function repo(rman?: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cloudflare-test-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.2.3', ...(rman !== undefined && { rman }) });
    return dir;
  }

  const pages = (extra: Record<string, unknown> = {}) => ({
    publish: { target: ['cloudflare'], cloudflare: { kind: 'pages', project: 'site', ...extra } },
  });
  const workers = (extra: Record<string, unknown> = {}) => ({
    publish: { target: ['cloudflare'], cloudflare: { kind: 'workers', ...extra } },
  });

  const deployed = (answer: boolean): CloudflarePublishService.Deps => ({ isDeployed: async () => answer });

  async function planFor(dir: string, deps?: CloudflarePublishService.Deps) {
    await createRepository(dir);
    return service('cloudflarePublish').getPlan({}, deps);
  }

  /**
   * A `wrangler` that records its argv and working directory, and answers `versions list` with the
   * versions given - what the Worker check reads.
   */
  function stubWrangler(dir: string, versions: unknown[] = []): { calls: () => string[] } {
    const bin = path.join(dir, 'local-bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(dir, 'wrangler-calls.log');
    fs.writeFileSync(
      path.join(bin, 'wrangler'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, process.cwd() + ' :: ' + args.join(' ') + '\\n');
if (args[0] === 'versions') console.log(${JSON.stringify(JSON.stringify(versions))});
`,
      { mode: 0o755 },
    );
    return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : []) };
  }

  describe('getPlan()', () => {
    it('leaves out a package that does not name "cloudflare", and one with publish.skip', async () => {
      expect(await planFor(repo())).toEqual([]);
      expect(await planFor(repo({ publish: { ...pages().publish, skip: true } }))).toEqual([]);
    });

    it('errors on a configuration it cannot deploy, saying what is missing', async () => {
      const reason = async (rman: unknown) => (await planFor(repo(rman)))[0];
      expect(await reason({ publish: { target: ['cloudflare'] } })).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/"publish\.cloudflare" is not configured/),
      });
      expect(await reason(pages({ project: undefined }))).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/project.*required/),
      });
      expect(await reason(workers())).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/wrangler\.jsonc/),
      });
      expect(await reason(pages({ variables: { A: '1' } }))).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/"publish\.cloudflare\.variables" is for kind "workers"/),
      });
      expect(await reason({ publish: { target: ['cloudflare'], cloudflare: { kind: 'site' } } })).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/"pages" or "workers"/),
      });
    });

    it('errors without credentials, naming the two variables', async () => {
      delete process.env.CLOUDFLARE_API_TOKEN;
      const [entry] = await planFor(repo(pages()), deployed(false));
      expect(entry).toMatchObject({
        status: 'error',
        reason: expect.stringMatching(/CLOUDFLARE_API_TOKEN.*CLOUDFLARE_ACCOUNT_ID/),
      });
    });

    it('plans a version not deployed yet, and leaves one that is - showing where it goes', async () => {
      expect((await planFor(repo(pages()), deployed(false)))[0]).toMatchObject({
        status: 'publish',
        detail: 'pages site (main)',
      });
      expect((await planFor(repo(pages({ branch: 'prod' })), deployed(true)))[0]).toMatchObject({
        status: 'up-to-date',
        detail: 'pages site (prod)',
        reason: 'pkg-a@1.2.3 is already deployed',
      });
    });

    /** Through the stand-in wrangler, so the real check runs: the version's tag among the Worker's. */
    it("reads a Worker's deployed version off its versions' tags", async () => {
      const dir = repo(workers());
      fs.writeFileSync(path.join(dir, 'packages/a/wrangler.jsonc'), '{ "name": "site" }');
      stubWrangler(dir, [{ annotations: { 'workers/tag': 'v1.2.2' } }, { annotations: { 'workers/tag': 'v1.2.3' } }]);
      expect((await planFor(dir))[0]).toMatchObject({ status: 'up-to-date', detail: 'workers wrangler.jsonc' });

      const fresh = repo(workers());
      fs.writeFileSync(path.join(fresh, 'packages/a/wrangler.jsonc'), '{ "name": "site" }');
      stubWrangler(fresh, [{ annotations: { 'workers/tag': 'v1.2.2' } }]);
      expect((await planFor(fresh))[0]).toMatchObject({ status: 'publish' });
    });
  });

  describe('applyPlan()', () => {
    it('deploys Pages from the build directory, labelled with the version', async () => {
      const dir = repo(pages());
      fs.mkdirSync(path.join(dir, 'packages/a/dist'));
      const wrangler = stubWrangler(dir);
      const plan = await planFor(dir, deployed(false));

      const result = await service('cloudflarePublish').applyPlan(plan);

      expect(result[0]).toMatchObject({ status: 'publish' });
      const [call] = wrangler.calls();
      expect(call).toContain(`${fs.realpathSync(path.join(dir, 'packages/a'))} :: pages deploy`);
      expect(call).toContain('--project-name site --branch main --commit-message pkg-a@1.2.3');
    });

    it('refuses a Pages deploy with nothing built, without running wrangler', async () => {
      const dir = repo(pages());
      const wrangler = stubWrangler(dir);
      const plan = await planFor(dir, deployed(false));

      const [entry] = await service('cloudflarePublish').applyPlan(plan);

      expect(entry).toMatchObject({ status: 'error', reason: expect.stringMatching(/dist does not exist/) });
      expect(wrangler.calls()).toEqual([]);
    });

    it("deploys a Worker to a named environment with its variables, and checks that environment's versions", async () => {
      const dir = repo(workers({ env: 'staging', variables: { PLATFORM: 'cloudflare', API_URL: 'https://x' } }));
      fs.writeFileSync(path.join(dir, 'packages/a/wrangler.jsonc'), '{ "name": "site" }');
      const wrangler = stubWrangler(dir);
      const plan = await planFor(dir);
      expect(plan[0]).toMatchObject({ detail: 'workers wrangler.jsonc (staging)' });

      await service('cloudflarePublish').applyPlan(plan);

      const [list, deploy] = wrangler.calls();
      expect(list).toMatch(/versions list --json --config .* --env staging$/);
      expect(deploy).toContain('--env staging --var PLATFORM:cloudflare --var API_URL:https://x --tag v1.2.3');
    });

    it('deploys a Worker with its own configuration, tagged with the version', async () => {
      const dir = repo(workers());
      fs.writeFileSync(path.join(dir, 'packages/a/wrangler.jsonc'), '{ "name": "site" }');
      const wrangler = stubWrangler(dir);
      const plan = await planFor(dir, deployed(false));

      await service('cloudflarePublish').applyPlan(plan);

      expect(wrangler.calls()[0]).toMatch(
        /:: deploy --config .*wrangler\.jsonc --tag v1\.2\.3 --message pkg-a@1\.2\.3$/,
      );
    });
  });
});
