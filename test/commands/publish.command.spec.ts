import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-publish-cmd-test-'));
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

/** A run that ends up needing to abort (uncommitted changes without --ignore-dirty, or a failed
 *  publish) hits cli.ts's `.fail()` handler on an already-logged error, which calls the real
 *  `process.exit(1)` - fatal to the test runner itself, since it's the same process. */
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

/**
 * Drops a fake `npm` at `<dir>/node_modules/.bin/npm` that logs every call (cwd + argv) instead of
 * doing anything real, then runs `fn()` with that same directory *also* prepended onto
 * `process.env.PATH`, restoring it after. Two different lookups need covering: the registry check
 * (`getPlan`) shells out via raw `execFileAsync`, which only ever consults `process.env.PATH`
 * directly; the actual publish (`applyPlan`) goes through this project's own `exec()`, which
 * augments PATH with `node_modules/.bin` ahead of everything (see utils/exec.spec.ts) - including
 * a real npm sitting right next to the running node binary, which would otherwise always win. One
 * script file, referenced by both lookup mechanisms, covers everything with no real network calls.
 */
/** Whether the npm stub's log (cwd||argv per line) was ever called with `subcommand` as its argv. */
function calledWith(logContent: string, subcommand: string): boolean {
  return logContent
    .trim()
    .split('\n')
    .some(line => line.split('||')[1]?.startsWith(subcommand));
}

/** Forces `process.stdout.isTTY` to `false` for the duration of `fn`, restoring whatever it was
 *  before - the "refuses to prompt" path only takes effect off a TTY, but the test runner's own
 *  stdout can genuinely be a TTY (e.g. run directly in an interactive terminal rather than piped/
 *  redirected), which would otherwise fall through to a real `readline` prompt and hang waiting for
 *  keyboard input instead of failing the assertion. */
async function withStubbedNonTTY<T>(fn: () => Promise<T>): Promise<T> {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
}

async function withStubbedNpm<T>(dir: string, fn: (logFile: string) => Promise<T>): Promise<T> {
  const binDir = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-publish-cmd-log-'));
  const logFile = path.join(logDir, 'calls.log');
  fs.writeFileSync(
    path.join(binDir, 'npm'),
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, process.cwd() + '||' + process.argv.slice(2).join(' ') + '\\n');\n`,
  );
  fs.chmodSync(path.join(binDir, 'npm'), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  try {
    return await fn(logFile);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

describe('commands/publish', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  describe('--dry-run', () => {
    it('shows the plan and never publishes, even with --yes', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async logFile => {
        const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--dry-run', '--yes'] }));
        expect(lines.some(l => l.includes('publish') && l.includes('pkg-a'))).toBe(true);
        // the registry check itself (npm view) still runs and logs a call - only the actual
        // "npm publish" invocation must never happen.
        const calls = fs.readFileSync(logFile, 'utf-8');
        expect(calledWith(calls, 'view')).toBe(true);
        expect(calledWith(calls, 'publish')).toBe(false);
      });
    });
  });

  describe('"Nothing to publish."', () => {
    it('prints it when every package is private (never a candidate at all)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0', private: true });

      await withStubbedNpm(dir, async logFile => {
        const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish'] }));
        expect(lines.some(l => l.includes('Nothing to publish.'))).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false);
      });
    });
  });

  describe('--ignore-dirty', () => {
    it('without it, a dirty package aborts the whole run before publishing anything', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');

      await withStubbedNpm(dir, async logFile => {
        const lines: string[] = [];
        await withStubbedExit(async () => {
          lines.push(...(await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }))));
        });
        expect(lines.some(l => l.includes('error') && l.includes('pkg-a'))).toBe(true);
        expect(lines.some(l => l.includes('uncommitted local changes'))).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false); // dirty short-circuits before any registry check
      });
    });
  });

  describe('--yes', () => {
    it('skips the confirmation prompt and publishes immediately', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async logFile => {
        const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }));
        expect(lines.some(l => l.includes('published') && l.includes('pkg-a'))).toBe(true);
        expect(calledWith(fs.readFileSync(logFile, 'utf-8'), 'publish')).toBe(true);
      });
    });
  });

  describe('without --yes, in a non-TTY test run', () => {
    it('refuses to prompt and publishes nothing', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNonTTY(() =>
        withStubbedNpm(dir, async logFile => {
          const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish'] }));
          expect(lines.some(l => l.includes('Not a TTY'))).toBe(true);
          expect(calledWith(fs.readFileSync(logFile, 'utf-8'), 'publish')).toBe(false);
        }),
      );
    });
  });

  describe('--target', () => {
    it('--target docker errors clearly when nothing configures the "docker" target', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async () => {
        const lines: string[] = [];
        await withStubbedExit(async () => {
          lines.push(...(await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--target', 'docker'] }))));
        });
        expect(lines.some(l => l.includes('no package') && l.includes('publish.docker'))).toBe(true);
      });
    });

    it('--target npm never considers a package configured only for "docker"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'org/pkg-a' } } },
      });

      await withStubbedNpm(dir, async logFile => {
        const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--target', 'npm', '--yes'] }));
        expect(lines.some(l => l.includes('Nothing to publish.'))).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false);
      });
    });

    it('--target docker shows a "[docker]"-labeled plan entry, without touching npm at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        private: true,
        rman: { publish: { target: ['docker'], docker: { image: 'org/pkg-a' } } },
      });

      await withStubbedNpm(dir, async logFile => {
        const lines = await captureLogs(() =>
          runCli({ cwd: dir, argv: ['publish', '--target', 'docker', '--dry-run'] }),
        );
        expect(lines.some(l => l.includes('publish') && l.includes('[docker]') && l.includes('pkg-a'))).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false); // npm side never even ran
      });
    });
  });

  describe('a failed publish', () => {
    it('reports "failed" per package and exits with a logged error', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      // "npm view" (empty stdout -> "never published") still works via a plain node stub, but
      // "npm publish" specifically must fail.
      fs.writeFileSync(
        path.join(binDir, 'npm'),
        `#!/usr/bin/env node\nif (process.argv[2] === 'publish') process.exit(1);\n`,
      );
      fs.chmodSync(path.join(binDir, 'npm'), 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      try {
        const lines: string[] = [];
        await withStubbedExit(async () => {
          lines.push(...(await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }))));
        });
        expect(lines.some(l => l.includes('failed') && l.includes('pkg-a'))).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});
