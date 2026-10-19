import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import colors from 'ansi-colors';
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
  /** The note a held-back entry carries, when a case wants a long one. */
  reason = 'major - deps.target is "minor"';
  /** What every entry reports - `'update'` unless a case says otherwise. */
  status: DependencyUpdater.Entry['status'] = 'update';
  /** What the declared range takes - unset unless a case says. */
  resolved: string | undefined;
  /** Whether the installed copy is in the declared range - unset unless a case says. */
  installedInRange: boolean | undefined;

  async getPlan(_ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<DependencyUpdater.Entry[]> {
    this.planned = packages.map(p => p.name);
    return packages.map(pkg => ({
      package: pkg,
      name: 'left-pad',
      types: ['dependencies'],
      current: '^1.0.0',
      installed: '1.0.2',
      resolved: this.resolved,
      installedInRange: this.installedInRange,
      status: this.status,
      ...(this.status === 'update' ? { target: '^1.3.0', bump: 'minor' } : {}),
      latest: '1.3.0',
      available: this.status === 'skipped' ? '2.0.0' : '1.3.0',
      reason: this.status === 'skipped' ? this.reason : undefined,
    }));
  }

  async applyPlan(): Promise<DependencyUpdater.Applied> {
    this.applied++;
    return { files: ['/x/package.json'], restore: () => void this.restored++ };
  }

  async verify(): Promise<string | undefined> {
    this.verified++;
    return this.refusals.length ? this.refusals.shift() : this.refusal;
  }

  /** Refusals answered in turn before `refusal` - for a case where the second ask passes. */
  refusals: string[] = [];
  /** Which packages' entries `blame` pins the refusal on - none unless a case says. */
  blamed: string[] = [];

  blame(_refusal: string, plan: readonly DependencyUpdater.Entry[]): DependencyUpdater.Blame[] {
    return plan
      .filter(e => this.blamed.includes(e.package.name))
      .map(entry => ({ entry, reason: 'npm cannot install it: left-pad@1.3.0 is broken' }));
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
      refusals: [],
      blamed: [],
      resolved: undefined,
      installedInRange: undefined,
      status: 'update',
      reason: 'major - deps.target is "minor"',
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
    /** What is declared, what is installed, what is out - then what it would become, last. */
    expect(lines).toContainEqual(
      expect.stringMatching(/^\s+Dependency\s+Current\s+Installed\s+Latest\s+Change\s+Upgrade\s+Note$/),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^\s+left-pad\s+\^1\.0\.0\s+1\.0\.2\s+1\.3\.0\s+minor\s+\^1\.3\.0$/),
    );
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

  /** One bad release must not cost the other upgrades: the refusal names it, it is held, and the
   *  rest are written again and asked about again. */
  it('holds back what the resolver blames and keeps the rest', async () => {
    const dir = monorepo();
    updater.refusals = ['  Could not resolve dependency: left-pad@1.3.0'];
    updater.blamed = ['pkg-a'];
    const { lines, failed } = await capture(() => runCli({ argv: ['deps', '-u'], cwd: dir }));
    const text = lines.join('\n');
    expect(failed).toBe(false);
    expect(updater.verified).toBe(2);
    expect(updater.applied).toBe(2);
    expect(updater.restored).toBe(1);
    expect(text).toContain('Held back - the resolver refused them:');
    expect(text).toMatch(/pkg-a left-pad \^1\.0\.0\s+npm cannot install it: left-pad@1\.3\.0 is broken/);
    expect(text).toContain('updated');
  });

  it('writes nothing when every upgrade is blamed', async () => {
    const dir = monorepo();
    updater.refusals = ['  Could not resolve dependency: left-pad@1.3.0'];
    updater.blamed = ['root', 'pkg-a', 'pkg-b'];
    const { lines, failed } = await capture(() => runCli({ argv: ['deps', '-u'], cwd: dir }));
    expect(failed).toBe(false);
    expect(updater.verified).toBe(1);
    expect(updater.applied).toBe(1);
    expect(updater.restored).toBe(1);
    expect(lines).toContain('Nothing upgraded.');
    expect(lines.join('\n')).not.toMatch(/^updated/m);
  });

  /** `-u --json` prints after the resolver, so a held entry says `held` rather than `update`. */
  it('prints the plan as it was written under -u --json', async () => {
    const dir = monorepo();
    updater.refusals = ['  Could not resolve dependency: left-pad@1.3.0'];
    updater.blamed = ['pkg-a'];
    const { lines } = await capture(() => runCli({ argv: ['deps', '-u', '--json'], cwd: dir }));
    const doc = JSON.parse(lines.join('\n'));
    const byPkg = Object.fromEntries(doc.map((e: any) => [e.package, e.status]));
    expect(byPkg).toEqual({ root: 'update', 'pkg-a': 'held', 'pkg-b': 'update' });
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

  /** A manifest already at the newest version, and `node_modules` behind it: nothing moves, and the
   *  row is still shown, since hidden it read as up to date while the older version ran. */
  it('lists an up-to-date range whose installed version is not the one it takes', async () => {
    const dir = monorepo();
    updater.status = 'up-to-date';
    updater.resolved = '1.3.0';
    const { lines } = await capture(() => runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir }));
    const text = lines.join('\n');
    expect(text).toMatch(/^All dependencies are up to date - installed versions that differ/m);
    expect(text).toMatch(
      /left-pad\s+\^1\.0\.0\s+1\.0\.2\s+1\.3\.0\s+install\s+-\s+"\^1\.0\.0" takes 1\.3\.0 - install again/,
    );
  });

  /** Latest is green where the row reaches it and yellow where it stops short; Installed is red
   *  only where it falls outside the declared range. */
  it('colours Latest by whether the row reaches it, and Installed only outside its range', async () => {
    const dir = monorepo();
    const code = (n: number, text: string) => `\u001b[${n}m${text}`;
    const raw = async () => {
      const lines: string[] = [];
      const original = { log: console.log, enabled: colors.enabled };
      console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
      /** On whatever the environment says (`FORCE_COLOR=0`, a CI runner), so the case is the same
       *  everywhere. */
      colors.enabled = true;
      try {
        await runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir });
      } finally {
        console.log = original.log;
        colors.enabled = original.enabled;
      }
      return lines.find(l => l.includes('left-pad'))!;
    };
    /** An upgrade to the newest version, its installed copy inside the range. */
    updater.installedInRange = true;
    let row = await raw();
    expect(row).toContain(code(32, '1.3.0'));
    expect(row).not.toContain(code(31, '1.0.2'));

    /** Left behind, and the installed copy is not what the manifest says. */
    updater.status = 'skipped';
    updater.installedInRange = false;
    row = await raw();
    expect(row).toContain(code(33, '2.0.0'));
    expect(row).toContain(code(31, '1.0.2'));
  });

  it('says so first, then lists what was left out, when nothing moves but a major exists', async () => {
    const dir = monorepo();
    updater.status = 'skipped';
    const { lines } = await capture(() => runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir }));
    const text = lines.join('\n');
    expect(text).toMatch(/^All dependencies are up to date - newer versions/m);
    expect(text).not.toContain('not updated');
    expect(text).toMatch(/left-pad\s+\^1\.0\.0\s+1\.0\.2\s+2\.0\.0\s+skipped\s+-\s+major - deps\.target is "minor"/);
    expect(text).not.toContain('rman deps -u');
  });

  /** A note longer than the terminal continues under its own column, not at the left edge. */
  it('wraps a long note under the Note column on a terminal', async () => {
    const dir = monorepo();
    updater.status = 'skipped';
    updater.reason = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    let lines: string[];
    try {
      ({ lines } = await capture(() => runCli({ argv: ['deps', '--scope', 'pkg-a'], cwd: dir })));
    } finally {
      for (const [key, d] of [
        ['isTTY', tty],
        ['columns', columns],
      ] as const) {
        if (d) Object.defineProperty(process.stdout, key, d);
        else delete (process.stdout as any)[key];
      }
    }
    const header = lines.find(l => l.includes('Dependency'))!;
    const rows = lines.flatMap(l => l.split('\n'));
    const first = rows.findIndex(l => l.includes('word0'));
    const continuation = rows.slice(first + 1).filter(l => l.includes('word'));
    expect(continuation.length).toBeGreaterThan(0);
    for (const l of [rows[first]!, ...continuation]) expect(l.length).toBeLessThanOrEqual(80);
    for (const l of continuation) expect(l.search(/\S/)).toBe(header.indexOf('Note'));
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
