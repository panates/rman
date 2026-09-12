import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-version-cmd-test-'));
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

/** A run that ends up needing to abort (uncommitted changes without --ignore-dirty) hits cli.ts's
 *  `.fail()` handler on an already-logged error, which calls the real `process.exit(1)` - fatal to
 *  the test runner itself, since it's the same process. Stub it out for the duration of `fn()`. */
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

describe('commands/version', () => {
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

  function initGit(dir: string) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
  }

  function commitAll(dir: string, message: string) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
  }

  function fixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    initGit(dir);
    commitAll(dir, 'init');
    git(dir, 'tag', 'v1.0.0');
    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    commitAll(dir, 'fix: a bug');
    return dir;
  }

  describe('an explicit bump keyword', () => {
    it('applies immediately, printing the plan then an "updated" line per bumped package', async () => {
      const dir = fixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a') && l.includes('1.0.1'))).toBe(true);
      expect(lines.some(l => l.includes('updated') && l.includes('pkg-a'))).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
    });
  });

  describe('no bump given', () => {
    it('auto-detects and shows the plan only - nothing is written', async () => {
      const dir = fixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version'] }));

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('Run again'))).toBe(true);
      expect(lines.some(l => l.includes('updated'))).toBe(false);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });

    it('prints "Nothing to version." when nothing changed at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version'] }));
      expect(lines.some(l => l.includes('Nothing to version.'))).toBe(true);
    });
  });

  describe('--ignore-dirty', () => {
    it('without it, a dirty package aborts the whole run', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const lines: string[] = [];
      await withStubbedExit(async () => {
        lines.push(...(await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }))));
      });
      expect(lines.some(l => l.includes('error') && l.includes('pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('uncommitted local changes'))).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0'); // aborted before any write
    });

    it('with it, the dirty package is excluded instead of aborting the run', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/b/x.txt'), 'x');
      commitAll(dir, 'fix: a bug in pkg-b');
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--ignore-dirty'] }));

      const a = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'packages/b/package.json'), 'utf-8'));
      expect(a.version).toBe('1.0.0'); // skipped, untouched
      expect(b.version).toBe('1.0.1'); // still applied
    });
  });

  describe('--push', () => {
    it('never pushes unless given, and reaches the remote when given', async () => {
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      git(dir, 'remote', 'add', 'origin', originDir);
      git(dir, 'branch', '-M', 'main');
      git(dir, 'push', '-u', 'origin', 'main', '-q');
      git(dir, 'push', '-q', 'origin', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      let remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags).not.toContain('v1.0.1');

      fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
      commitAll(dir, 'fix: another bug');
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--push'] }));
      remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags).toContain('v1.0.2');
    });
  });

  describe('--interactive / -i (real confirmation prompt, via a real subprocess)', () => {
    function runInSubprocess(dir: string, argv: string[], stdin: string): string {
      const script = `
        import('${path.join(process.cwd(), 'src/cli.js').replace(/\\\\/g, '/')}').then(m =>
          m.runCli({ cwd: ${JSON.stringify(dir)}, argv: ${JSON.stringify(argv)} }),
        );
      `;
      return execFileSync('node', ['--import', '@swc-node/register/esm-register', '-e', script], {
        input: stdin,
        cwd: process.cwd(),
      }).toString();
    }

    it('"y" applies the plan', async () => {
      const dir = fixture();
      const output = runInSubprocess(dir, ['version', '--interactive'], 'y\n');
      expect(output).toContain('updated');
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
    });

    it('"n" (or anything else) declines - nothing is written', async () => {
      const dir = fixture();
      const output = runInSubprocess(dir, ['version', '--interactive'], 'n\n');
      expect(output).not.toContain('updated');
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });

    it('also asks for confirmation when an explicit bump was given', async () => {
      const dir = fixture();
      const output = runInSubprocess(dir, ['version', 'patch', '--interactive'], 'y\n');
      expect(output).toContain('Apply these changes?');
      expect(output).toContain('updated');
    });
  });
});
