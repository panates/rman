import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { appWithStubBin, runCli, useNodeEcosystem } from '../_fixture.js';

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
  useNodeEcosystem();

  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * A fake `<name>` (npm/yarn/…) that logs its own cwd instead of installing anything, in a
   * directory contributed through a **`BinPath` provider** - and the *provider* is the point.
   *
   * Two ways that look right and are not:
   *
   * - **A `node_modules/.bin` shim**, the usual trick (see `utils/exec.spec.ts`), cannot work here:
   *   `ci`'s own wipe step deletes `node_modules` - stub and all - *before* the install step that
   *   would run it.
   * - **Prepending `process.env.PATH`**, which this did. `BinPath.env` appends the inherited PATH
   *   **last**, after every provider's directories, and `NodePlugin.getBinPaths` ends with the
   *   running `node`'s own directory. On a version-managed machine that directory holds real
   *   `npm`, `yarn` and `pnpm` - so the stub lost and `ci --package-manager yarn` ran the **real**
   *   yarn. Measured: nvm's `bin` has all three, and the spec failed reporting only
   *   "expected true, received false" while rman's own log said `Running "yarn install"` and
   *   `ci completed (0.3s)`.
   *
   * That second one is the trap CLAUDE.md records for `docker` - a stub invisible from a package,
   * the real binary running instead - and it had the same consequence here: the suite shelled out
   * to a real package manager.
   *
   * So the stub directory is handed to `appWithStubBin`, registered *before* `NodePlugin`, which is
   * what puts it first.
   */
  function stubPackageManager(name: string): { dir: string; logFile: string } {
    const dir = tmp();
    const logFile = path.join(tmp(), `${name}-calls.log`);
    const script = path.join(dir, name);
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, process.cwd() + '\\n');\n`,
    );
    fs.chmodSync(script, 0o755);
    return { dir, logFile };
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
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    return dir;
  }

  it('--package-manager selects which install command actually runs', async () => {
    const dir = fixtureNoRootScript();
    const binDir = tmp();
    const yarn = stubPackageManager('yarn');
    const npm = stubPackageManager('npm');
    /** Both stubs in one directory, so the provider offers a single path and neither can win by
     *  being listed first - which is the whole question the case asks. */
    for (const from of [yarn.dir, npm.dir]) {
      for (const entry of fs.readdirSync(from)) fs.copyFileSync(path.join(from, entry), path.join(binDir, entry));
    }
    fs.chmodSync(path.join(binDir, 'yarn'), 0o755);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);

    await captureLogs(() =>
      runCli({
        cwd: dir,
        argv: ['ci', '--package-manager', 'yarn', '--no-progress'],
        app: appWithStubBin(binDir),
      }),
    );
    expect(fs.existsSync(yarn.logFile)).toBe(true);
    expect(fs.existsSync(npm.logFile)).toBe(false);
  });

  it('rejects a --package-manager outside the known choices before ever touching the filesystem', async () => {
    const dir = fixtureNoRootScript();
    const lines = await captureLogs(async () => {
      await expect(runCli({ cwd: dir, argv: ['ci', '--package-manager', 'rush'] })).rejects.toThrow(/package-manager/);
    });
    expect(lines.some(l => l.includes('package-manager'))).toBe(true);
    // validation failed before the handler ran at all - nothing was touched.
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
  });
});
