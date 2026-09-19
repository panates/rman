import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { CiService } from '../../src/services/ci.service.js';
import { createRepository, useNodeEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-ci-test-'));
}

/** A `node -e '...'` command that writes `content` to `file`. Wraps the JS in single quotes for
 *  the shell and keeps every JS-level string double-quoted, so the two quoting styles never
 *  collide (a single mismatched quote type here breaks the shell's argument splitting). */
function writeFileCommand(file: string, content: string): string {
  return `node -e 'require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)})'`;
}

/** Runs `fn` with console.log swallowed instead of printed - `Ci.reinstall` logs a line per
 *  rmdir/run/install step, which would otherwise spam test output for no benefit here. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Runs `fn` with `process.stdout.isTTY` forced true and every `process.stdout.write()` call
 *  captured instead of hitting the real terminal - the only way to exercise `Ci.reinstall`'s live
 *  ProgressPanel path (it's auto-disabled outside a TTY, which the test runner isn't). */
async function withLivePanel<T>(fn: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
}

describe('services/ci', () => {
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

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  describe('Ci.resolvePackageManager()', () => {
    it('defaults to npm when neither a CLI value nor .rmanrc specify one', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      const repo = await createRepository(dir);
      expect(CiService.resolvePackageManager(repo)).toBe('npm');
    });

    it('prefers the explicit CLI value over .rmanrc', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ packageManager: 'yarn' }));
      const repo = await createRepository(dir);
      expect(CiService.resolvePackageManager(repo, 'pnpm')).toBe('pnpm');
    });

    it('falls back to .rmanrc "packageManager" when no CLI value is given', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ packageManager: 'bun' }));
      const repo = await createRepository(dir);
      expect(CiService.resolvePackageManager(repo)).toBe('bun');
    });

    it('throws for an unrecognized package manager', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ packageManager: 'rush' }));
      const repo = await createRepository(dir);
      expect(() => CiService.resolvePackageManager(repo)).toThrow(/Invalid "packageManager"/);
    });
  });

  describe('Ci.reinstall()', () => {
    /** A fake package-manager binary that logs its cwd to `logFile` instead of installing
     *  anything for real - passed as `packageManager` directly (an absolute path, not a
     *  PATH-resolved name), so it can't ever be shadowed by whatever real npm/yarn/pnpm/bun
     *  happens to be installed on this machine's PATH. */
    function stubPackageManager(): { packageManager: CiService.PackageManager; logFile: string } {
      const binDir = tmp();
      const logFile = path.join(tmp(), 'pm-calls.log');
      const script = path.join(binDir, 'fake-pm');
      fs.writeFileSync(
        script,
        `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, process.cwd() + '\\n');\n`,
      );
      fs.chmodSync(script, 0o755);
      return { packageManager: script as CiService.PackageManager, logFile };
    }

    it('wipes node_modules and lockfiles in every package and the root, then installs once at the root', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      for (const d of [dir, path.join(dir, 'packages/a'), path.join(dir, 'packages/b')]) {
        fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
      }
      const repo = await createRepository(dir);
      const { packageManager, logFile } = stubPackageManager();

      await captureLogs(() => CiService.reinstall(repo, { packageManager }));

      for (const d of [dir, path.join(dir, 'packages/a'), path.join(dir, 'packages/b')]) {
        expect(fs.existsSync(path.join(d, 'node_modules'))).toBe(false);
        expect(fs.existsSync(path.join(d, 'package-lock.json'))).toBe(false);
      }
      const installedIn = fs.readFileSync(logFile, 'utf-8').trim();
      expect(fs.realpathSync(installedIn)).toBe(fs.realpathSync(dir));
    });

    it('logs "clean" (not "rmdir") for a package with no node_modules/lockfile to begin with', async () => {
      // Most workspace layouts (npm/yarn hoisting) mean an individual package usually has
      // nothing of its own to wipe - silence here would look like the package was skipped
      // entirely, so it gets its own visible line instead.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      const lines = await captureLogs(() => CiService.reinstall(repo, { packageManager, progress: false }));
      expect(lines.some(l => l.includes('rmdir'))).toBe(false);
      expect(lines.some(l => l.includes('clean') && l.includes('pkg-a'))).toBe(true);
    });

    it('a package\'s own "ci" script runs instead of the default wipe', async () => {
      const dir = tmp();
      const marker = path.join(dir, 'pkg-a-ci-ran.txt');
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        scripts: { ci: writeFileCommand(marker, 'ran') },
      });
      fs.mkdirSync(path.join(dir, 'packages/a/node_modules'), { recursive: true });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      await captureLogs(() => CiService.reinstall(repo, { packageManager }));

      expect(fs.existsSync(marker)).toBe(true);
      // the custom script ran instead of the wipe - node_modules is untouched.
      expect(fs.existsSync(path.join(dir, 'packages/a/node_modules'))).toBe(true);
    });

    it('the root\'s own "ci" script replaces the wipe+install entirely', async () => {
      const dir = tmp();
      const marker = path.join(dir, 'root-ci-ran.txt');
      writeJson(dir, 'package.json', {
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
        scripts: { ci: writeFileCommand(marker, 'ran') },
      });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      const repo = await createRepository(dir);

      // deliberately no stubPackageManager() here, and no packageManager passed - if this ever
      // fell through to the default wipe+install, a real npm would run and this test would
      // hang or hit the network.
      await captureLogs(() => CiService.reinstall(repo));

      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
    });
  });

  describe('Ci.reinstall() with the live progress panel', () => {
    function stubPackageManager(): { packageManager: CiService.PackageManager } {
      const binDir = tmp();
      const script = path.join(binDir, 'fake-pm');
      fs.writeFileSync(script, `#!/usr/bin/env node\n`);
      fs.chmodSync(script, 0o755);
      return { packageManager: script as CiService.PackageManager };
    }

    /** Same as `stubPackageManager()`, but the "install" step busy-waits a bit before exiting -
     *  the panel's own redraw only ticks every 100ms (see `ProgressPanel.start()`), and on a fast
     *  enough machine (observed on GitHub Actions runners) the whole `reinstall()` call - wipe and
     *  a no-op install alike - can complete well within that first 100ms, so the loop never fires
     *  even once and the live panel writes nothing at all to assert on. A deliberately slow
     *  install step guarantees at least one tick lands while it's still "running". */
    function stubSlowPackageManager(): { packageManager: CiService.PackageManager } {
      const binDir = tmp();
      const script = path.join(binDir, 'fake-pm');
      fs.writeFileSync(script, `#!/usr/bin/env node\nconst t=Date.now();while(Date.now()-t<250){}\n`);
      fs.chmodSync(script, 0o755);
      return { packageManager: script as CiService.PackageManager };
    }

    it('defaults to the shared ProgressPanel on a TTY (title, package names) - same default as run/build', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.mkdirSync(path.join(dir, 'packages/a/node_modules'), { recursive: true });
      const repo = await createRepository(dir);
      const { packageManager } = stubSlowPackageManager();

      const { writes } = await withLivePanel(() => CiService.reinstall(repo, { packageManager }));

      // eslint-disable-next-line no-control-regex
      const plain = writes.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      expect(plain).toContain('CI');
      // pkg-a's wipe is near-instant, so it may finish before any render tick catches it running -
      // "root" reliably shows up instead, since its (deliberately slowed) install step is what's
      // still "running" by the time the first tick fires.
      expect(plain).toContain('root');
    });

    it('--no-progress (progress: false) stays on the classic log even when stdout is a TTY', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.mkdirSync(path.join(dir, 'packages/a/node_modules'), { recursive: true });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      const { result: lines } = await withLivePanel(() =>
        captureLogs(() => CiService.reinstall(repo, { packageManager, progress: false })),
      );
      expect(lines.some(l => l.includes('rmdir'))).toBe(true);
    });
  });

  describe('Ci.reinstall() completion reporting', () => {
    /** Unlike run/build, ci's completion is intentionally not a per-package success tally - its
     *  packages don't have independently meaningful outcomes (wiping is trivial, and the one step
     *  that can really fail - the install - is a single operation for the whole repository). */
    function stubPackageManager(): { packageManager: CiService.PackageManager } {
      const binDir = tmp();
      const script = path.join(binDir, 'fake-pm');
      fs.writeFileSync(script, `#!/usr/bin/env node\n`);
      fs.chmodSync(script, 0o755);
      return { packageManager: script as CiService.PackageManager };
    }

    it('prints a plain "ci completed" line instead of a per-package success tally', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      const lines = await captureLogs(() => CiService.reinstall(repo, { packageManager }));
      expect(lines.some(l => l.includes('ci completed'))).toBe(true);
      expect(lines.some(l => /\d+ succeeded/.test(l))).toBe(false);
      expect(lines.some(l => l.includes('✓'))).toBe(false);
    });

    it('calls out a failed package by name (with its captured output) and reports "ci failed", still with no success tally', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        scripts: { ci: `node -e "console.error('boom-from-pkg-a'); process.exit(1)"` },
      });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      // panel enabled (a real TTY) so the failing script's output is actually captured onto the
      // item instead of streaming straight to the terminal via stdio:'inherit'.
      const { result: lines } = await withLivePanel(() =>
        captureLogs(() => CiService.reinstall(repo, { packageManager }).catch(() => undefined)),
      );
      expect(lines.some(l => l.includes('X') && l.includes('pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('boom-from-pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('ci failed'))).toBe(true);
      expect(lines.some(l => /\d+ succeeded/.test(l))).toBe(false);
    });
  });

  describe('Ci.reinstall() --log-level (classic per-step log, panel off)', () => {
    function stubPackageManager(): { packageManager: CiService.PackageManager } {
      const binDir = tmp();
      const script = path.join(binDir, 'fake-pm');
      fs.writeFileSync(script, `#!/usr/bin/env node\n`);
      fs.chmodSync(script, 0o755);
      return { packageManager: script as CiService.PackageManager };
    }

    it('logLevel: "silent" suppresses everything, including a failure and "ci failed"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        scripts: { ci: `node -e "process.exit(1)"` },
      });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      const lines = await captureLogs(() =>
        CiService.reinstall(repo, { packageManager, logLevel: 'silent' }).catch(() => undefined),
      );
      expect(lines).toEqual([]);
    });

    it('logLevel: "error" hides routine narration ("run"/"clean"/"install") but still shows a failure', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        scripts: { ci: `node -e "process.exit(1)"` },
      });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      const lines = await captureLogs(() =>
        CiService.reinstall(repo, { packageManager, logLevel: 'error' }).catch(() => undefined),
      );
      expect(lines.some(l => l.includes('run') && l.includes('pkg-a'))).toBe(false);
      expect(lines.some(l => l.includes('X') && l.includes('pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('ci failed'))).toBe(true);
    });

    it('.rmanrc "logLevel" sets the default when no explicit option is passed', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ logLevel: 'silent' }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await createRepository(dir);
      const { packageManager } = stubPackageManager();

      const lines = await captureLogs(() => CiService.reinstall(repo, { packageManager }));
      expect(lines).toEqual([]);
    });
  });
});
