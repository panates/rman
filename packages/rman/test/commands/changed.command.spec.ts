import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';
import { useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-changed-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('commands/changed', () => {
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

  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  }

  it('lists packages that would be bumped, without writing anything', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');
    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fix: a bug');

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changed'] }));
    expect(lines.some(l => l.includes('changed') && l.includes('pkg-a') && l.includes('1.0.1'))).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
    expect(pkg.version).toBe('1.0.0'); // never written
  });

  it('prints "Nothing has changed." when nothing would be bumped', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changed'] }));
    expect(lines.some(l => l.includes('Nothing has changed.'))).toBe(true);
  });

  it('--json prints a plain JSON array of the changed packages', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat: a feature');

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changed', '--json'] }));
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed).toEqual([
      { name: 'pkg-a', group: 'default', from: '1.0.0', to: '1.1.0', reason: 'changed since v1.0.0' },
    ]);
  });
});
