import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-ci-cmd-test-'));
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

describe('commands/ci', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Drops a fake `<name>` (npm/yarn/...) executable on PATH for the duration of `fn()`, logging
   *  its own cwd to a file instead of installing anything for real, then restores PATH regardless
   *  of outcome. A `node_modules/.bin` shim (the usual trick - see utils/exec.spec.ts's "PATH
   *  augmentation" test) doesn't work here: `ci`'s own wipe step deletes `node_modules` (stub and
   *  all) *before* the install step that would run it, so the stub has to live somewhere the wipe
   *  never touches - a real PATH prepend, same as `withFakeNpmOnPath` in changelog.command.spec.ts. */
  async function withStubPackageManager<T>(name: string, fn: (logFile: string) => Promise<T>): Promise<T> {
    const binDir = tmp();
    const logFile = path.join(tmp(), `${name}-calls.log`);
    const script = path.join(binDir, name);
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, process.cwd() + '\\n');\n`,
    );
    fs.chmodSync(script, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
    try {
      return await fn(logFile);
    } finally {
      process.env.PATH = originalPath;
    }
  }

  /** A `node -e '...'` command that writes `content` to `file` - single-quoted for the shell,
   *  double-quoted (via JSON.stringify) inside, so the two quoting styles never collide. */
  function writeFileCommand(file: string, content: string): string {
    return `node -e 'require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)})'`;
  }

  /** A root package with its own `"ci"` script - substitutes for the default wipe+install (see
   *  `CiService.reinstall`'s own doc comment), so exercising `ci` through the real CLI never needs
   *  to invoke an actual (or stubbed) package manager for the root itself. */
  function fixture(): { dir: string; rootCiMarker: string } {
    const dir = tmp();
    const rootCiMarker = path.join(dir, 'root-ci-ran.txt');
    writeJson(dir, 'package.json', {
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      scripts: { ci: writeFileCommand(rootCiMarker, 'ran') },
    });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    for (const d of [dir, path.join(dir, 'packages/a')]) {
      fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
    }
    return { dir, rootCiMarker };
  }

  it('wipes a package with no own "ci" script, and runs the root\'s own "ci" script instead of wipe+install', async () => {
    const { dir, rootCiMarker } = fixture();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['ci', '--no-progress'] }));

    expect(fs.existsSync(path.join(dir, 'packages/a/node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'packages/a/package-lock.json'))).toBe(false);
    expect(fs.existsSync(rootCiMarker)).toBe(true);
    // the root's custom script ran instead of the default wipe - its own node_modules is untouched.
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
    expect(lines.some(l => l.includes('ci completed'))).toBe(true);
  });

  /** Plain fixture with no root "ci" script - the tests below need root to actually reach the
   *  install step, unlike the substituted-script fixture above. */
  function fixtureNoRootScript(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    return dir;
  }

  it('--package-manager selects which install command actually runs', async () => {
    const dir = fixtureNoRootScript();
    await withStubPackageManager('yarn', async yarnLogFile => {
      await withStubPackageManager('npm', async npmLogFile => {
        await captureLogs(() => runCli({ cwd: dir, argv: ['ci', '--package-manager', 'yarn', '--no-progress'] }));
        expect(fs.existsSync(yarnLogFile)).toBe(true);
        expect(fs.existsSync(npmLogFile)).toBe(false);
      });
    });
  });

  it('rejects a --package-manager outside the known choices before ever touching the filesystem', async () => {
    const dir = fixtureNoRootScript();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['ci', '--package-manager', 'rush'] }));
    expect(lines.some(l => l.includes('package-manager'))).toBe(true);
    // validation failed before the handler ran at all - nothing was touched.
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  });
});
