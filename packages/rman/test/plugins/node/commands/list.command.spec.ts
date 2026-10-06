import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../_fixture.js';

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

async function listJson(cwd: string): Promise<Record<string, any>> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await runCli({ cwd, argv: ['list', '--json'] });
  } finally {
    console.log = original;
  }
  return Object.fromEntries(JSON.parse(lines.join('\n')).map((i: any) => [i.name, i]));
}

/**
 * **`rman list` greys out what the npm target would skip, by the rule `publish` itself applies** -
 * `PublishService.skipReason`, which `getPlan` calls too. Each case here has a twin in
 * `publish.service.spec.ts` asserting the plan's answer, so the two are pinned to agree.
 */
describe('commands/list (npm target)', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-node-list-test-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/plain/package.json', { name: 'plain', version: '1.0.0' });
    writeJson(dir, 'packages/example/package.json', { name: 'example', version: '1.0.0', private: true });
    /** A source guard on a package set up to publish from a build directory - published. */
    writeJson(dir, 'packages/guarded/package.json', {
      name: 'guarded',
      version: '1.0.0',
      private: true,
      publishConfig: { access: 'public', directory: 'build' },
    });
    /** The same manifest published in place: it *is* what npm reads, so its `private` stands. */
    writeJson(dir, 'packages/in-place/package.json', {
      name: 'in-place',
      version: '1.0.0',
      private: true,
      publishConfig: { access: 'public' },
    });
    /** GitHub Packages, stated in the package's own manifest. */
    writeJson(dir, 'packages/github/package.json', {
      name: '@owner/github',
      version: '1.0.0',
      publishConfig: { registry: 'https://npm.pkg.github.com' },
    });
    /** npm's own registry, written out - the same place a bare `npm` already says. */
    writeJson(dir, 'packages/npmjs/package.json', {
      name: 'npmjs',
      version: '1.0.0',
      publishConfig: { registry: 'https://registry.npmjs.org/' },
    });
    return dir;
  }

  it('skips a private package with no publishConfig, and one published in place', async () => {
    const items = await listJson(fixture());
    expect(items.example).toMatchObject({ publishTargets: ['npm'], skippedTargets: { npm: 'private package' } });
    expect(items['in-place'].skippedTargets).toEqual({ npm: 'private package' });
  });

  it('leaves a candidate alone, including a private source guard with a publishConfig', async () => {
    const items = await listJson(fixture());
    expect(items.plain).toMatchObject({ publishTargets: ['npm'], skippedTargets: {} });
    expect(items.guarded.skippedTargets).toEqual({});
  });

  it("labels a package with its publishConfig.registry's host, unless that is npm's own", async () => {
    const items = await listJson(fixture());
    expect(items['@owner/github']).toMatchObject({
      publishTargets: ['npm'],
      targetLabels: { npm: 'npm.pkg.github.com' },
    });
    expect(items.npmjs.targetLabels).toEqual({});
    expect(items.plain.targetLabels).toEqual({});
  });
});
