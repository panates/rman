import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import type { Package } from '../../src/core/classes/package.js';
import type { DependencyUpdater } from '../../src/core/interfaces/dependency-updater.js';
import { definePlatform } from '../../src/core/interfaces/plugin.js';
import { runCli, testPlatform, usePlugin, useTestEcosystem } from '../_fixture.js';

/**
 * The command's half of `deps` - which packages are asked, when anything is written, and that a
 * refusal from `verify` puts the writes back. The answer itself comes from a fake technology, since
 * the core has none of its own.
 */
class FakeUpdater implements DependencyUpdater {
  planned: string[] = [];
  applied = 0;
  restored = 0;
  verified = 0;
  refusal: string | undefined;
  /** What every entry reports - `'update'` unless a case says otherwise. */
  status: DependencyUpdater.Entry['status'] = 'update';

  async getPlan(_ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<DependencyUpdater.Entry[]> {
    this.planned = packages.map(p => p.name);
    return packages.map(pkg => ({
      package: pkg,
      name: 'left-pad',
      types: ['dependencies'],
      current: '^1.0.0',
      status: this.status,
      ...(this.status === 'update' ? { target: '^1.3.0', bump: 'minor' } : {}),
      latest: '1.3.0',
      available: this.status === 'skipped' ? '2.0.0' : '1.3.0',
      reason: this.status === 'skipped' ? 'major - deps.target is "minor"' : undefined,
    }));
  }

  async applyPlan(): Promise<DependencyUpdater.Applied> {
    this.applied++;
    return { files: ['/x/package.json'], restore: () => void this.restored++ };
  }

  async verify(): Promise<string | undefined> {
    this.verified++;
    return this.refusal;
  }
}

describe('commands/deps', () => {
  useTestEcosystem();

  const updater = new FakeUpdater();
  usePlugin(definePlatform({ ...testPlatform, name: 'deps-test', dependencyUpdater: updater }));
  beforeEach(() => {
    Object.assign(updater, {
      planned: [],
      applied: 0,
      restored: 0,
      verified: 0,
      refusal: undefined,
      status: 'update',
    });
  });

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function monorepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-deps-cmd-'));
    dirs.push(dir);
    const write = (rel: string, data: unknown) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
    };
    write('package.json', { name: 'root', version: '1.0.0', workspaces: ['packages/*'] });
    write('packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    write('packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    return dir;
  }

  async function capture(fn: () => Promise<void>): Promise<{ lines: string[]; failed: boolean }> {
    const original = { log: console.log, error: console.error };
    const lines: string[] = [];
    /** Colours stripped: what is asserted is the text a reader sees. */
    // eslint-disable-next-line no-control-regex
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
    console.log = console.error = (...args: unknown[]) => void lines.push(plain(args.map(String).join(' ')));
    let failed = false;
    try {
      await fn();
    } catch {
      failed = true;
    } finally {
      Object.assign(console, original);
    }
    return { lines, failed };
  }

  it('asks about the root as well as the members, and writes nothing without --upgrade', async () => {
    const dir = monorepo();
    const { lines, failed } = await capture(() => runCli({ argv: ['deps'], cwd: dir }));
    expect(failed).toBe(false);
    expect(updater.planned).toEqual(['root', 'pkg-a', 'pkg-b']);
    expect(updater.applied).toBe(0);
    expect(lines.join('\n')).toContain('rman deps -u');
  });

  /** One table per package, under a header - each dependency once, what it moves to and how far. */
  it('prints a table with a header, one row per dependency', async () => {
    const dir = monorepo();
    const { lines } = await capture(() => runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir }));
    expect(lines).toContainEqual(expect.stringMatching(/^\s+Dependency\s+Current\s+Upgrade\s+Latest\s+Change\s+Note$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\s+left-pad\s+\^1\.0\.0\s+\^1\.3\.0\s+1\.3\.0\s+minor$/));
  });

  it('narrows to --scope', async () => {
    const dir = monorepo();
    await capture(() => runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir }));
    expect(updater.planned).toEqual(['pkg-a']);
  });

  it('writes under --upgrade and asks the resolver afterwards', async () => {
    const dir = monorepo();
    const { failed } = await capture(() => runCli({ argv: ['deps', '-u'], cwd: dir }));
    expect(failed).toBe(false);
    expect(updater.applied).toBe(1);
    expect(updater.verified).toBe(1);
    expect(updater.restored).toBe(0);
  });

  it('puts the writes back and fails when the resolver refuses them', async () => {
    const dir = monorepo();
    updater.refusal = '  ERESOLVE unable to resolve dependency tree';
    const { lines, failed } = await capture(() => runCli({ argv: ['deps', '-u'], cwd: dir }));
    expect(failed).toBe(true);
    expect(updater.restored).toBe(1);
    expect(lines.join('\n')).toContain('ERESOLVE unable to resolve dependency tree');
  });

  it('does not ask the resolver under --no-verify', async () => {
    const dir = monorepo();
    updater.refusal = 'would refuse';
    const { failed } = await capture(() => runCli({ argv: ['deps', '-u', '--no-verify'], cwd: dir }));
    expect(failed).toBe(false);
    expect(updater.verified).toBe(0);
  });

  it('says every dependency is up to date when nothing has a newer version', async () => {
    const dir = monorepo();
    updater.status = 'up-to-date';
    const { lines } = await capture(() => runCli({ argv: ['deps'], cwd: dir }));
    expect(lines.join('\n')).toContain('All dependencies are up to date.');
    expect(lines.join('\n')).not.toContain('rman deps -u');
  });

  it('says so first, then lists what was left out, when nothing moves but a major exists', async () => {
    const dir = monorepo();
    updater.status = 'skipped';
    const { lines } = await capture(() => runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir }));
    const text = lines.join('\n');
    expect(text).toMatch(/^All dependencies are up to date - newer versions/m);
    expect(text).not.toContain('not updated');
    expect(text).toMatch(/left-pad\s+\^1\.0\.0\s+-\s+2\.0\.0\s+skipped\s+major - deps\.target is "minor"/);
    expect(text).not.toContain('rman deps -u');
  });

  it('prints one JSON document under --json', async () => {
    const dir = monorepo();
    const { lines } = await capture(() => runCli({ argv: ['deps', '--json'], cwd: dir }));
    const doc = JSON.parse(lines.join('\n'));
    expect(doc.map((e: any) => e.package)).toEqual(['root', 'pkg-a', 'pkg-b']);
    expect(doc[0]).toMatchObject({ name: 'left-pad', status: 'update', current: '^1.0.0', target: '^1.3.0' });
  });
});

describe('commands/deps, with no technology that can answer', () => {
  useTestEcosystem();

  it('says so rather than reporting everything up to date', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-deps-cmd-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'solo', version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
    try {
      await expect(runCli({ argv: ['deps'], cwd: dir })).rejects.toThrow();
    } finally {
      console.error = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(errors.join('\n')).toContain('can update its dependencies');
  });
});
