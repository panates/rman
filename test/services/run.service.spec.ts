import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Package, Repository, resolveRootLogLevel } from '../../src/index.js';
import { resolveBool, resolveLogLevel, resolveNumber, RunService } from '../../src/services/run.service.js';

interface PackageDef {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  rmanrc?: unknown;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-run-test-'));
}

/** Writes a minimal workspace: root package.json (+ optional scripts/.rmanrc) and N packages. */
function writeFixture(
  dir: string,
  packages: Record<string, PackageDef>,
  root?: { scripts?: Record<string, string>; rmanrc?: unknown },
) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'root',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
      scripts: root?.scripts,
    }),
  );
  if (root?.rmanrc) fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(root.rmanrc));
  for (const [name, def] of Object.entries(packages)) {
    const pkgDir = path.join(dir, 'packages', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: def.dependencies, scripts: def.scripts }),
    );
    if (def.rmanrc) fs.writeFileSync(path.join(pkgDir, '.rmanrc'), JSON.stringify(def.rmanrc));
  }
}

/** Redirects a fixture script's own stdout/stderr to /dev/null - these scripts run through the
 *  "classic" logging path's `stdio: 'inherit'`, which streams straight to the real terminal by
 *  design (bypassing console.log entirely) and would otherwise spam test output. Assertions check
 *  for the command text inside our own printed summary line, never the command's actual output. */
function quiet(command: string): string {
  return `${command} > /dev/null 2>&1`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Runs `fn` with `console.log` captured (plain-text lines, ANSI stripped) instead of printed,
 *  and swallows any rejection from it (rman's own bail-triggered errors) into `error`. */
async function captureLogs(fn: () => Promise<void>): Promise<{ lines: string[]; error?: Error }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  let error: Error | undefined;
  try {
    await fn();
  } catch (e) {
    error = e as Error;
  } finally {
    console.log = original;
  }
  return { lines, error };
}

describe('run: config resolution helpers', () => {
  const pkg = (config: unknown): Package => ({ config }) as Package;

  describe('Run.config()', () => {
    it('returns the script-scoped object from pkg.config.run', () => {
      expect(RunService.getConfig(pkg({ run: { build: { bail: false } } }), 'build')).toEqual({ bail: false });
    });

    it('returns {} when the package has no config, no run block, or no entry for the script', () => {
      expect(RunService.getConfig(pkg(undefined), 'build')).toEqual({});
      expect(RunService.getConfig(pkg({}), 'build')).toEqual({});
      expect(RunService.getConfig(pkg({ run: {} }), 'build')).toEqual({});
      expect(RunService.getConfig(pkg({ run: { lint: { bail: false } } }), 'build')).toEqual({});
    });
  });

  describe('Run.resolveBool()', () => {
    it('prefers the explicit CLI value over config and fallback', () => {
      expect(resolveBool(false, pkg({ run: { build: { bail: true } } }), 'build', 'bail', true)).toBe(false);
    });

    it('falls back to the package config when the CLI value is undefined', () => {
      expect(resolveBool(undefined, pkg({ run: { build: { bail: false } } }), 'build', 'bail', true)).toBe(false);
    });

    it('falls back to the given default when neither CLI nor config specify it', () => {
      expect(resolveBool(undefined, pkg({}), 'build', 'bail', true)).toBe(true);
    });

    it('ignores a non-boolean config value', () => {
      expect(resolveBool(undefined, pkg({ run: { build: { bail: 'yes' } } }), 'build', 'bail', true)).toBe(true);
    });
  });

  describe('Run.resolveNumber()', () => {
    it('prefers CLI, then config, then fallback', () => {
      expect(resolveNumber(4, pkg({ run: { build: { concurrency: 2 } } }), 'build', 'concurrency', 8)).toBe(4);
      expect(resolveNumber(undefined, pkg({ run: { build: { concurrency: 2 } } }), 'build', 'concurrency', 8)).toBe(2);
      expect(resolveNumber(undefined, pkg({}), 'build', 'concurrency', 8)).toBe(8);
    });
  });

  describe('Run.resolveLogLevel()', () => {
    it('prefers CLI, then config, then fallback, and rejects unknown levels', () => {
      expect(resolveLogLevel('error', pkg({ run: { build: { logLevel: 'verbose' } } }), 'build', 'info')).toBe('error');
      expect(resolveLogLevel(undefined, pkg({ run: { build: { logLevel: 'verbose' } } }), 'build', 'info')).toBe(
        'verbose',
      );
      expect(resolveLogLevel(undefined, pkg({}), 'build', 'info')).toBe('info');
      expect(resolveLogLevel(undefined, pkg({ run: { build: { logLevel: 'nonsense' } } }), 'build', 'info')).toBe(
        'info',
      );
    });
  });

  describe('resolveRootLogLevel()', () => {
    const repo = (config: unknown): Repository => ({ config }) as Repository;

    it('reads the root\'s plain top-level "logLevel" - not "run.<script>.logLevel"', () => {
      expect(resolveRootLogLevel(repo({ logLevel: 'verbose' }))).toBe('verbose');
    });

    it('defaults to "info" when unset', () => {
      expect(resolveRootLogLevel(repo(undefined))).toBe('info');
      expect(resolveRootLogLevel(repo({}))).toBe('info');
    });

    it('ignores an unrecognized value and falls back to "info"', () => {
      expect(resolveRootLogLevel(repo({ logLevel: 'nonsense' }))).toBe('info');
    });
  });
});

describe('run: Run.runScript() integration', () => {
  const dirs: string[] = [];
  function fixture(
    packages: Record<string, PackageDef>,
    root?: { scripts?: Record<string, string>; rmanrc?: unknown },
  ) {
    const dir = mkTmp();
    dirs.push(dir);
    writeFixture(dir, packages, root);
    return Repository.create(dir);
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  describe('topo', () => {
    it('default (true): skips a package whose dependency failed', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { dependencies: { 'pkg-a': '1.0.0' }, scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
    });

    it('topo=false: the "dependent" package runs anyway - there is no link', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { dependencies: { 'pkg-a': '1.0.0' }, scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, topo: false, bail: false }),
      );
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });
  });

  describe('bail', () => {
    it('default (true): stops a not-yet-started independent package after a failure', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false, parallel: 1 }));
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
    });

    it('bail=false: an independent package still runs after an earlier failure', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, parallel: 1, bail: false }),
      );
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });

    it('a package-level .rmanrc bail override wins over the global CLI value', async () => {
      // Global bail is off, but pkg-a insists on bailing for its own failure.
      const repo = fixture({
        'pkg-a': { scripts: { build: 'exit 1' }, rmanrc: { run: { build: { bail: true } } } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, parallel: 1, bail: false }),
      );
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
    });
  });

  describe('skip', () => {
    it('a package with run.<script>.skip:true is excluded entirely', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: 'echo pkg-b-ran' }, rmanrc: { run: { build: { skip: true } } } },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b'))).toBe(false);
    });

    it('a root-level skip disables the root pre/post bookend without touching a package that overrides it', async () => {
      // root's skip:true cascades to every package by default (it's their config too) - pkg-a
      // opts back in with its own .rmanrc to isolate "root bookend skipped" from "packages skipped".
      const repo = fixture(
        { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') }, rmanrc: { run: { build: { skip: false } } } } },
        {
          scripts: { prebuild: quiet('echo ROOT-PRE-RAN'), postbuild: quiet('echo ROOT-POST-RAN') },
          rmanrc: { run: { build: { skip: true } } },
        },
      );
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('ROOT-PRE-RAN'))).toBe(false);
      expect(lines.some(l => l.includes('ROOT-POST-RAN'))).toBe(false);
    });

    it('a root-level skip cascades to packages too, since it is their config baseline', async () => {
      const repo = fixture(
        { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } } },
        { rmanrc: { run: { build: { skip: true } } } },
      );
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(false);
    });
  });

  describe('config-provided script/pre/post', () => {
    it('run.<script>.script lets a package with no such script in package.json run it anyway', async () => {
      const repo = fixture({
        'pkg-a': { rmanrc: { run: { build: { script: quiet('echo config-script-ran') } } } },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('config-script-ran'))).toBe(true);
    });

    it("without override, the package's own package.json script still wins", async () => {
      const repo = fixture({
        'pkg-a': {
          scripts: { build: quiet('echo own-script-ran') },
          rmanrc: { run: { build: { script: quiet('echo config-script-ran') } } },
        },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('own-script-ran'))).toBe(true);
      expect(lines.some(l => l.includes('config-script-ran'))).toBe(false);
    });

    it('override: true makes the config script replace an existing package.json script', async () => {
      const repo = fixture({
        'pkg-a': {
          scripts: { build: quiet('echo own-script-ran') },
          rmanrc: { run: { build: { script: quiet('echo config-script-ran'), override: true } } },
        },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('own-script-ran'))).toBe(false);
      expect(lines.some(l => l.includes('config-script-ran'))).toBe(true);
    });

    it('run.<script>.preScript/.postScript fill in for missing pre/post hooks around the package.json script', async () => {
      const repo = fixture({
        'pkg-a': {
          scripts: { build: quiet('echo main-ran') },
          rmanrc: {
            run: {
              build: { preScript: quiet('echo pre-ran'), postScript: quiet('echo post-ran') },
            },
          },
        },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('pre-ran'))).toBe(true);
      expect(lines.some(l => l.includes('main-ran'))).toBe(true);
      expect(lines.some(l => l.includes('post-ran'))).toBe(true);
    });

    it("override: true replaces the package's own pre/post hooks too, not just the main script", async () => {
      const repo = fixture({
        'pkg-a': {
          scripts: { build: quiet('echo main-ran'), prebuild: quiet('echo own-pre-ran') },
          rmanrc: { run: { build: { preScript: quiet('echo config-pre-ran'), override: true } } },
        },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('own-pre-ran'))).toBe(false);
      expect(lines.some(l => l.includes('config-pre-ran'))).toBe(true);
    });

    it('a root-level run.<script>.script cascades as the default for every package missing one', async () => {
      const repo = fixture(
        { 'pkg-a': {}, 'pkg-b': { scripts: { build: quiet('echo pkg-b-own-ran') } } },
        { rmanrc: { run: { build: { script: quiet('echo root-default-ran') } } } },
      );
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('root-default-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b-own-ran'))).toBe(true);
    });

    it('script/pre/post accept an array of commands, run in sequence', async () => {
      const repo = fixture({
        'pkg-a': {
          rmanrc: {
            run: {
              build: { preScript: [quiet('echo pre-1-ran'), quiet('echo pre-2-ran')], script: quiet('echo main-ran') },
            },
          },
        },
      });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, logLevel: 'verbose' }),
      );
      const preIdx1 = lines.findIndex(l => l.includes('pre-1-ran'));
      const preIdx2 = lines.findIndex(l => l.includes('pre-2-ran'));
      const mainIdx = lines.findIndex(l => l.includes('main-ran'));
      expect(preIdx1).toBeGreaterThanOrEqual(0);
      expect(preIdx2).toBeGreaterThan(preIdx1);
      expect(mainIdx).toBeGreaterThan(preIdx2);
    });

    it('an earlier failure in an array stops the later commands, same as "&&" in package.json', async () => {
      const repo = fixture({
        'pkg-a': {
          rmanrc: { run: { build: { preScript: ['exit 1', quiet('echo should-not-run')] } } },
        },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false, bail: false }));
      expect(lines.some(l => l.includes('should-not-run'))).toBe(false);
    });
  });

  describe('logLevel', () => {
    it('default "info": shows the success line but no "executing" line', async () => {
      const repo = fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('success'))).toBe(true);
      expect(lines.some(l => l.includes('executing'))).toBe(false);
    });

    it('"verbose": also prints an "executing" line before the step runs', async () => {
      const repo = fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, logLevel: 'verbose' }),
      );
      expect(lines.some(l => l.includes('executing'))).toBe(true);
      expect(lines.some(l => l.includes('success'))).toBe(true);
    });

    it('"error": suppresses success lines but still shows failures', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: quiet('echo ok') } },
        'pkg-b': { scripts: { build: 'exit 1' } },
      });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, logLevel: 'error', bail: false, parallel: 1 }),
      );
      expect(lines.some(l => l.includes('success'))).toBe(false);
      // '┆' marks an actual per-step line - the final "N succeeded, M failed" summary always
      // prints regardless of logLevel and would otherwise false-match a bare "failed" check.
      expect(lines.some(l => l.includes('┆') && l.includes('failed'))).toBe(true);
    });

    it('"silent": suppresses every per-step line, success or failure', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: quiet('echo ok') } },
        'pkg-b': { scripts: { build: 'exit 1' } },
      });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, logLevel: 'silent', bail: false, parallel: 1 }),
      );
      expect(lines.some(l => l.includes('success'))).toBe(false);
      expect(lines.some(l => l.includes('┆') && l.includes('failed'))).toBe(false);
    });

    it('a package-level .rmanrc logLevel override applies only to that package', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: quiet('echo a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo b-ran') }, rmanrc: { run: { build: { logLevel: 'verbose' } } } },
      });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      const executingLines = lines.filter(l => l.includes('executing'));
      expect(executingLines.length).toBe(1);
      expect(executingLines[0]).toContain('pkg-b');
    });

    it('the root\'s plain top-level .rmanrc "logLevel" (not run.<script>.logLevel) is the default for every package', async () => {
      const repo = fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } }, { rmanrc: { logLevel: 'verbose' } });
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('executing'))).toBe(true);
    });

    it("a package's own run.<script>.logLevel still outranks the root's top-level default", async () => {
      const repo = fixture(
        {
          'pkg-a': { scripts: { build: quiet('echo hi') }, rmanrc: { run: { build: { logLevel: 'silent' } } } },
        },
        { rmanrc: { logLevel: 'verbose' } },
      );
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(lines.some(l => l.includes('executing'))).toBe(false);
      expect(lines.some(l => l.includes('success'))).toBe(false);
    });

    it("an explicit CLI --log-level outranks the root's top-level default", async () => {
      const repo = fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } }, { rmanrc: { logLevel: 'silent' } });
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, logLevel: 'verbose' }),
      );
      expect(lines.some(l => l.includes('executing'))).toBe(true);
    });
  });

  describe('concurrency', () => {
    /** Sleep-based timing check: generous thresholds since CI/dev machines vary, but
     *  serial vs (effectively) parallel execution of 3 x 150ms steps should never be close. */
    const SLEEP = 'node -e "setTimeout(()=>{},150)"';

    it('parallel=false runs packages serially (~3x one step)', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: SLEEP } },
        'pkg-b': { scripts: { build: SLEEP } },
        'pkg-c': { scripts: { build: SLEEP } },
      });
      const start = Date.now();
      await captureLogs(() => RunService.runScript(repo, 'build', { progress: false, parallel: false }));
      expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    });

    it('the default concurrency runs independent packages in parallel (~1x one step)', async () => {
      const repo = fixture({
        'pkg-a': { scripts: { build: SLEEP } },
        'pkg-b': { scripts: { build: SLEEP } },
        'pkg-c': { scripts: { build: SLEEP } },
      });
      const start = Date.now();
      await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(Date.now() - start).toBeLessThan(400);
    });

    it('a root .rmanrc run.<script>.concurrency applies when --parallel is not given', async () => {
      const repo = fixture(
        {
          'pkg-a': { scripts: { build: SLEEP } },
          'pkg-b': { scripts: { build: SLEEP } },
          'pkg-c': { scripts: { build: SLEEP } },
        },
        { rmanrc: { run: { build: { concurrency: 1 } } } },
      );
      const start = Date.now();
      await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));
      expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    });

    it('an explicit --parallel overrides the config concurrency', async () => {
      const repo = fixture(
        {
          'pkg-a': { scripts: { build: SLEEP } },
          'pkg-b': { scripts: { build: SLEEP } },
          'pkg-c': { scripts: { build: SLEEP } },
        },
        { rmanrc: { run: { build: { concurrency: 1 } } } },
      );
      const start = Date.now();
      await captureLogs(() => RunService.runScript(repo, 'build', { progress: false, parallel: 8 }));
      expect(Date.now() - start).toBeLessThan(400);
    });
  });

  describe('changed filtering', () => {
    it('changed:true only runs packages that have local git changes', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      writeFixture(dir, {
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(dir, 'packages/pkg-a/extra.txt'), 'dirty');

      const repo = Repository.create(dir);
      const { lines } = await captureLogs(() =>
        RunService.runScript(repo, 'build', { progress: false, changed: true }),
      );
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b'))).toBe(false);
    });
  });

  describe('cwd scoping (Repository.currentPackage)', () => {
    it('running from inside a single package only runs that package - not others, not the root bookend', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      // writeFixture() directly (not the fixture() helper, which always creates the Repository
      // from the root dir) - this test needs Repository.create() from inside a package instead.
      writeFixture(
        dir,
        {
          'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
          'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
        },
        { scripts: { prebuild: quiet('echo ROOT-PRE-RAN') } },
      );

      const repo = Repository.create(path.join(dir, 'packages', 'pkg-a'));
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));

      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
      expect(lines.some(l => l.includes('ROOT-PRE-RAN'))).toBe(false);
    });

    it('--root (root: true) runs across the whole repository even from inside a single package', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      writeFixture(dir, {
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });

      const repo = Repository.create(path.join(dir, 'packages', 'pkg-a'));
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false, root: true }));

      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });

    it('running from the repository root itself is unaffected - every package still runs', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      writeFixture(dir, {
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });

      const repo = Repository.create(dir);
      const { lines } = await captureLogs(() => RunService.runScript(repo, 'build', { progress: false }));

      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });
  });
});
