import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-clean-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

function writeFile(dir: string, rel: string, content = '') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
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

/** A run refused by --allow-branch/--ignore-branch hits cli.ts's `.fail()` handler on an
 *  already-logged error, which calls the real `process.exit(1)` - fatal to the test runner itself,
 *  since it's the same process. */
async function withStubbedExit(fn: () => Promise<void>): Promise<void> {
  const originalExit = process.exit;
  // @ts-expect-error - observing the call instead of actually terminating the test process.
  process.exit = () => undefined;
  try {
    await fn();
  } finally {
    process.exit = originalExit;
  }
}

describe('commands/clean', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const exists = (dir: string, ...rel: string[]) => fs.existsSync(path.join(dir, ...rel));

  it('removes compiled TypeScript output and reports a per-package success tally', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeFile(dir, 'packages/a/src/foo.ts', 'export {}');
    writeFile(dir, 'packages/a/src/foo.js');

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['clean'] }));

    expect(exists(dir, 'packages/a/src/foo.ts')).toBe(true);
    expect(exists(dir, 'packages/a/src/foo.js')).toBe(false);
    expect(lines.some(l => /\d+ succeeded/.test(l))).toBe(true);
  });

  describe('--dry-run (kebab-case CLI flag)', () => {
    it('reports what would be removed without actually removing anything', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.ts', 'export {}');
      writeFile(dir, 'packages/a/src/foo.js');

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['clean', '--dry-run'] }));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(true);
      expect(lines.some(l => l.includes('would rm'))).toBe(true);
    });
  });

  describe('--root (cwd scoping through the real CLI)', () => {
    it('running from inside a single package only cleans that package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      writeFile(dir, 'packages/b/src/bar.js');

      await captureLogs(() => runCli({ cwd: path.join(dir, 'packages/a'), argv: ['clean'] }));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(false);
      expect(exists(dir, 'packages/b/src/bar.js')).toBe(true);
    });

    it('--root cleans the whole repository even from inside a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      writeFile(dir, 'packages/b/src/bar.js');

      await captureLogs(() => runCli({ cwd: path.join(dir, 'packages/a'), argv: ['clean', '--root'] }));

      expect(exists(dir, 'packages/a/src/foo.js')).toBe(false);
      expect(exists(dir, 'packages/b/src/bar.js')).toBe(false);
    });
  });

  describe('--no-progress', () => {
    it('stays on the classic per-target log even when stdout is not a TTY (already the default in tests)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['clean', '--no-progress'] }));
      expect(lines.some(l => l.includes('pkg-a'))).toBe(true);
    });
  });

  describe('--allow-branch / --ignore-branch', () => {
    function git(dir: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    }

    it('refuses to run from a branch that does not match --allow-branch', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      git(dir, 'checkout', '-q', '-b', 'feature/x');

      const lines: string[] = [];
      await withStubbedExit(async () => {
        lines.push(...(await captureLogs(() => runCli({ cwd: dir, argv: ['clean', '--allow-branch', 'main'] }))));
      });
      expect(lines.some(l => l.includes('feature/x'))).toBe(true);
      // nothing ran - refused before the clean itself.
      expect(fs.existsSync(path.join(dir, 'packages/a/src/foo.js'))).toBe(true);
    });

    it('proceeds normally on a branch that matches --allow-branch', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeFile(dir, 'packages/a/src/foo.js');
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      git(dir, 'checkout', '-q', '-b', 'main');

      await captureLogs(() => runCli({ cwd: dir, argv: ['clean', '--allow-branch', 'main'] }));
      expect(fs.existsSync(path.join(dir, 'packages/a/src/foo.js'))).toBe(false);
    });
  });
});
