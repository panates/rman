import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-run-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

/** Redirects a fixture script's own stdout/stderr to /dev/null - these run through the "classic"
 *  logging path's `stdio: 'inherit'`, which streams straight to the real terminal by design
 *  (bypassing console.log entirely) and would otherwise spam test output. */
function quiet(command: string): string {
  return `${command} > /dev/null 2>&1`;
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

/** A run that ends up "failed" overall (any package's script actually failed, --bail or not) hits
 *  `cli.ts`'s `.fail()` handler on an already-logged error, which calls the real `process.exit(1)`
 *  - fatal for the test runner itself, since it's the very same process. Stub it out for the
 *  duration of `fn()` whenever a test deliberately exercises such a failure. */
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

describe('commands/run', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture(scripts: Record<string, Record<string, string>>): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    for (const [name, pkgScripts] of Object.entries(scripts)) {
      writeJson(dir, `packages/${name}/package.json`, { name, version: '1.0.0', scripts: pkgScripts });
    }
    return dir;
  }

  it('requires the <script> positional - "run" alone is rejected', async () => {
    const dir = fixture({ 'pkg-a': { build: quiet('echo hi') } });
    // Bad argv prints the reason *and* fails - it used to print and resolve, so a shell saw 0.
    const lines = await captureLogs(async () => {
      await expect(runCli({ cwd: dir, argv: ['run'] })).rejects.toThrow(/Not enough non-option arguments/);
    });
    expect(lines.some(l => l.includes('Not enough non-option arguments'))).toBe(true);
  });

  it('runs the given script in every package', async () => {
    const dir = fixture({ 'pkg-a': { lint: quiet('echo linted') } });
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['run', 'lint', '--no-progress'] }));
    expect(lines.some(l => l.includes('lint') && l.includes('pkg-a'))).toBe(true);
  });

  describe('kebab-case CLI flags wire through to RunService.Options', () => {
    it('--no-bail lets an independent package run after an earlier failure', async () => {
      const dir = fixture({
        'pkg-a': { build: 'exit 1' },
        'pkg-b': { build: quiet('echo pkg-b-ran') },
      });
      let lines: string[] = [];
      await withStubbedExit(async () => {
        lines = await captureLogs(() =>
          runCli({ cwd: dir, argv: ['run', 'build', '--no-progress', '--no-bail', '--parallel', '1'] }),
        );
      });
      expect(lines.some(l => l.includes('pkg-b') && l.includes('success'))).toBe(true);
    });

    it('--no-topo lets a "dependent" package run even though its dependency failed', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', scripts: { build: 'exit 1' } });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
        scripts: { build: quiet('echo hi') },
      });

      let lines: string[] = [];
      await withStubbedExit(async () => {
        lines = await captureLogs(() =>
          runCli({ cwd: dir, argv: ['run', 'build', '--no-progress', '--no-topo', '--no-bail'] }),
        );
      });
      expect(lines.some(l => l.includes('pkg-b') && l.includes('success'))).toBe(true);
    });

    it('--changed-since <hash> only runs in packages changed since that commit', async () => {
      const dir = fixture({
        'pkg-a': { build: quiet('echo a-ran') },
        'pkg-b': { build: quiet('echo b-ran') },
      });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      fs.writeFileSync(path.join(dir, 'packages/pkg-a/extra.txt'), 'x');
      git('add', '-A');
      git('commit', '-q', '-m', 'change pkg-a');

      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['run', 'build', '--no-progress', '--changed-since', baseHash] }),
      );
      expect(lines.some(l => l.includes('pkg-a') && l.includes('success'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b'))).toBe(false);
    });

    it('--root runs across the whole repository even from inside a single package', async () => {
      const dir = fixture({
        'pkg-a': { build: quiet('echo a-ran') },
        'pkg-b': { build: quiet('echo b-ran') },
      });
      const lines = await captureLogs(() =>
        runCli({ cwd: path.join(dir, 'packages/pkg-a'), argv: ['run', 'build', '--no-progress', '--root'] }),
      );
      expect(lines.some(l => l.includes('pkg-a') && l.includes('success'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b') && l.includes('success'))).toBe(true);
    });
  });

  describe('--log-level (global option, shared with build/ci/clean)', () => {
    it('--log-level verbose shows the "executing" line before each step', async () => {
      const dir = fixture({ 'pkg-a': { build: quiet('echo hi') } });
      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['run', 'build', '--no-progress', '--log-level', 'verbose'] }),
      );
      expect(lines.some(l => l.includes('executing'))).toBe(true);
    });
  });
});
