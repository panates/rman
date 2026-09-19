import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Package, Repository, resolveRootLogLevel } from '../../src/index.js';
import { resolveBool, resolveLogLevel, resolveNumber, RunService } from '../../src/services/run.service.js';
import { createRepository, service, useTestEcosystem } from '../_fixture.js';

interface PackageDef {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  rmanrc?: unknown;
  /**
   * The package's config as **JavaScript source**, written to `.rmanrc.cjs` - the only form that
   * can hold a function, which is what a function step is. Given as source text rather than as an
   * object because the value has to survive being written to a file, and `JSON.stringify` is
   * exactly the thing that cannot carry it.
   *
   * `.rmanrc.cjs` also wins over the `.rmanrc` the fixture always writes, so a package can be given
   * one without the other having to be suppressed.
   */
  rmanrcJs?: string;
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
  /** Always written, even when empty: `Workspace.findRoot` marks the repository root by an
   *  `.rmanrc*` or a `.git`, and it has to - it runs *before* the plugins that would know what a
   *  package is. Without a marker, creating a repository from a nested directory roots there. */
  fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(root?.rmanrc ?? {}));
  for (const [name, def] of Object.entries(packages)) {
    const pkgDir = path.join(dir, 'packages', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: def.dependencies, scripts: def.scripts }),
    );
    if (def.rmanrc) fs.writeFileSync(path.join(pkgDir, '.rmanrc'), JSON.stringify(def.rmanrc));
    if (def.rmanrcJs) fs.writeFileSync(path.join(pkgDir, '.rmanrc.cjs'), `module.exports = ${def.rmanrcJs};\n`);
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
  useTestEcosystem();

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
  useTestEcosystem();

  const dirs: string[] = [];
  function fixture(
    packages: Record<string, PackageDef>,
    root?: { scripts?: Record<string, string>; rmanrc?: unknown },
  ) {
    const dir = mkTmp();
    dirs.push(dir);
    writeFixture(dir, packages, root);
    return createRepository(dir);
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  describe('topo', () => {
    it('default (true): skips a package whose dependency failed', async () => {
      await fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { dependencies: { 'pkg-a': '1.0.0' }, scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
    });

    it('topo=false: the "dependent" package runs anyway - there is no link', async () => {
      await fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { dependencies: { 'pkg-a': '1.0.0' }, scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, topo: false, bail: false }),
      );
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });
  });

  describe('an empty run', () => {
    it('fails when no package defines the script - including one defined only on the root', async () => {
      // How `rman run qc` sat in a CI pipeline reporting success while running nothing: `qc` lived
      // on the root, whose own scripts a monorepo never runs - only its pre/post bookends. `npm
      // run` fails on a script that doesn't exist; so does this.
      await fixture({ 'pkg-a': { scripts: { build: quiet('echo a') } } }, { scripts: { qc: 'echo qc' } });
      const { lines, error } = await captureLogs(() => service('run').runScript('qc', { progress: false }));
      expect(error).toBeDefined();
      expect(lines.some(l => l.includes('No package defines a "qc" script'))).toBe(true);
    });

    it('succeeds when the script exists but every package was filtered out', async () => {
      // "build only what changed" must not fail a pipeline on a run where nothing changed.
      await fixture({ 'pkg-a': { scripts: { build: quiet('echo a') } } });
      const { lines, error } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, scope: ['no-such-package'] }),
      );
      expect(error).toBeUndefined();
      expect(lines.some(l => l.includes('filtered out'))).toBe(true);
    });
  });

  describe('bail', () => {
    it('default (true): stops a not-yet-started independent package after a failure', async () => {
      await fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false, parallel: 1 }));
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
    });

    it('one failed package fails the command, even with siblings still in flight', async () => {
      // The bug this guards: a package's own bail aborts the root task, whose promise then settles
      // immediately while the packages already running carry on. Reading the run's outcome off
      // that promise made the command exit 0 on a failed run - and non-deterministically, since it
      // came down to which siblings happened to still be running (measured: 1 0 1 1 0 across five
      // identical runs). The per-package tallies are the authority instead.
      await fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        // Slow enough to still be running when pkg-a fails - a plain `sleep` would be flakier.
        'pkg-slow': {
          scripts: { build: quiet('node -e "const t=Date.now();while(Date.now()-t<300);"') },
        },
        'pkg-c': { scripts: { build: quiet('echo pkg-c-ran') } },
      });
      const { lines, error } = await captureLogs(() => service('run').runScript('build', { progress: false }));

      expect(error).toBeDefined();
      expect(error?.message).toContain('failed');
      // And the summary describes a finished run, not a snapshot of one still going: it used to
      // print the sibling as "skipped" and then let it succeed afterwards.
      expect(lines.some(l => /2 succeeded, 1 failed/.test(l))).toBe(true);
    });

    it('a clean run still resolves', async () => {
      await fixture({
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { error } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(error).toBeUndefined();
    });

    it('bail=false: an independent package still runs after an earlier failure', async () => {
      await fixture({
        'pkg-a': { scripts: { build: 'exit 1' } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, parallel: 1, bail: false }),
      );
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });

    it('a package-level .rmanrc bail override wins over the global CLI value', async () => {
      // Global bail is off, but pkg-a insists on bailing for its own failure.
      await fixture({
        'pkg-a': { scripts: { build: 'exit 1' }, rmanrc: { run: { build: { bail: true } } } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, parallel: 1, bail: false }),
      );
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(false);
    });
  });

  describe('skip', () => {
    it('a package with run.<script>.skip:true is excluded entirely', async () => {
      await fixture({
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: 'echo pkg-b-ran' }, rmanrc: { run: { build: { skip: true } } } },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b'))).toBe(false);
    });

    it('a root-level skip disables the root pre/post bookend without touching a package that overrides it', async () => {
      // root's skip:true cascades to every package by default (it's their config too) - pkg-a
      // opts back in with its own .rmanrc to isolate "root bookend skipped" from "packages skipped".
      await fixture(
        { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') }, rmanrc: { run: { build: { skip: false } } } } },
        {
          scripts: { prebuild: quiet('echo ROOT-PRE-RAN'), postbuild: quiet('echo ROOT-POST-RAN') },
          rmanrc: { run: { build: { skip: true } } },
        },
      );
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('ROOT-PRE-RAN'))).toBe(false);
      expect(lines.some(l => l.includes('ROOT-POST-RAN'))).toBe(false);
    });

    /**
     * **`run` is the subtree the cascade costs something in, so this pins both halves.** The same
     * key means "the repo-wide bookend" at the root and "this package's hook" under a package, and
     * an unmarked statement now reaches both - which is right for nearly every key and wrong for
     * this one. `"[/]"` is where a bookend belongs, and this is the one migration that is not
     * mechanical.
     */
    it('a "[/]" skip is the root\'s own; an unmarked one now reaches the packages', async () => {
      await fixture(
        { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } } },
        { rmanrc: { '[/]': { run: { build: { skip: true } } } } },
      );
      const a = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(a.lines.some(l => l.includes('pkg-a-ran'))).toBe(true);

      await fixture(
        { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } } },
        { rmanrc: { run: { build: { skip: true } } } },
      );
      const b = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(b.lines.some(l => l.includes('pkg-a-ran'))).toBe(false);
    });
  });

  describe('config-provided exec/before/after', () => {
    it('run.<script>.exec lets a package with no such script in package.json run it anyway', async () => {
      await fixture({
        'pkg-a': { rmanrc: { run: { build: { exec: quiet('echo config-script-ran') } } } },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('config-script-ran'))).toBe(true);
    });

    it("without override, the package's own package.json script still wins", async () => {
      await fixture({
        'pkg-a': {
          scripts: { build: quiet('echo own-script-ran') },
          rmanrc: { run: { build: { exec: quiet('echo config-script-ran') } } },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('own-script-ran'))).toBe(true);
      expect(lines.some(l => l.includes('config-script-ran'))).toBe(false);
    });

    it('override: true makes the config script replace an existing package.json script', async () => {
      await fixture({
        'pkg-a': {
          scripts: { build: quiet('echo own-script-ran') },
          rmanrc: { run: { build: { exec: quiet('echo config-script-ran'), override: true } } },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('own-script-ran'))).toBe(false);
      expect(lines.some(l => l.includes('config-script-ran'))).toBe(true);
    });

    it('run.<script>.before/.after fill in for missing pre/post hooks around the package.json script', async () => {
      await fixture({
        'pkg-a': {
          scripts: { build: quiet('echo main-ran') },
          rmanrc: {
            run: {
              build: { before: quiet('echo pre-ran'), after: quiet('echo post-ran') },
            },
          },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('pre-ran'))).toBe(true);
      expect(lines.some(l => l.includes('main-ran'))).toBe(true);
      expect(lines.some(l => l.includes('post-ran'))).toBe(true);
    });

    it("override: true replaces the package's own pre/post hooks too, not just the main script", async () => {
      await fixture({
        'pkg-a': {
          scripts: { build: quiet('echo main-ran'), prebuild: quiet('echo own-pre-ran') },
          rmanrc: { run: { build: { before: quiet('echo config-pre-ran'), override: true } } },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('own-pre-ran'))).toBe(false);
      expect(lines.some(l => l.includes('config-pre-ran'))).toBe(true);
    });

    it('a root-level "[*]" run.<script>.exec is the default for every package missing one', async () => {
      await fixture(
        { 'pkg-a': {}, 'pkg-b': { scripts: { build: quiet('echo pkg-b-own-ran') } } },
        { rmanrc: { '[*]': { run: { build: { exec: quiet('echo root-default-ran') } } } } },
      );
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('root-default-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b-own-ran'))).toBe(true);
    });

    it('exec/before/after accept an array of commands, run in sequence', async () => {
      await fixture({
        'pkg-a': {
          rmanrc: {
            run: {
              build: { before: [quiet('echo pre-1-ran'), quiet('echo pre-2-ran')], exec: quiet('echo main-ran') },
            },
          },
        },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, logLevel: 'verbose' }),
      );
      const preIdx1 = lines.findIndex(l => l.includes('pre-1-ran'));
      const preIdx2 = lines.findIndex(l => l.includes('pre-2-ran'));
      const mainIdx = lines.findIndex(l => l.includes('main-ran'));
      expect(preIdx1).toBeGreaterThanOrEqual(0);
      expect(preIdx2).toBeGreaterThan(preIdx1);
      expect(mainIdx).toBeGreaterThan(preIdx2);
    });

    it('an earlier failure in an array stops the later commands, same as "&&" in package.json', async () => {
      await fixture({
        'pkg-a': {
          rmanrc: { run: { build: { before: ['exit 1', quiet('echo should-not-run')] } } },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false, bail: false }));
      expect(lines.some(l => l.includes('should-not-run'))).toBe(false);
    });
  });

  describe('logLevel', () => {
    it('default "info": shows the success line but no "executing" line', async () => {
      await fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('success'))).toBe(true);
      expect(lines.some(l => l.includes('executing'))).toBe(false);
    });

    it('"verbose": also prints an "executing" line before the step runs', async () => {
      await fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, logLevel: 'verbose' }),
      );
      expect(lines.some(l => l.includes('executing'))).toBe(true);
      expect(lines.some(l => l.includes('success'))).toBe(true);
    });

    it('"error": suppresses success lines but still shows failures', async () => {
      await fixture({
        'pkg-a': { scripts: { build: quiet('echo ok') } },
        'pkg-b': { scripts: { build: 'exit 1' } },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, logLevel: 'error', bail: false, parallel: 1 }),
      );
      expect(lines.some(l => l.includes('success'))).toBe(false);
      // '┆' marks an actual per-step line - the final "N succeeded, M failed" summary always
      // prints regardless of logLevel and would otherwise false-match a bare "failed" check.
      expect(lines.some(l => l.includes('┆') && l.includes('failed'))).toBe(true);
    });

    it('"silent": suppresses every per-step line, success or failure', async () => {
      await fixture({
        'pkg-a': { scripts: { build: quiet('echo ok') } },
        'pkg-b': { scripts: { build: 'exit 1' } },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, logLevel: 'silent', bail: false, parallel: 1 }),
      );
      expect(lines.some(l => l.includes('success'))).toBe(false);
      expect(lines.some(l => l.includes('┆') && l.includes('failed'))).toBe(false);
    });

    it('a package-level .rmanrc logLevel override applies only to that package', async () => {
      await fixture({
        'pkg-a': { scripts: { build: quiet('echo a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo b-ran') }, rmanrc: { run: { build: { logLevel: 'verbose' } } } },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      const executingLines = lines.filter(l => l.includes('executing'));
      expect(executingLines.length).toBe(1);
      expect(executingLines[0]).toContain('pkg-b');
    });

    it('the root\'s plain top-level .rmanrc "logLevel" (not run.<script>.logLevel) is the default for every package', async () => {
      await fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } }, { rmanrc: { logLevel: 'verbose' } });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('executing'))).toBe(true);
    });

    it("a package's own run.<script>.logLevel still outranks the root's top-level default", async () => {
      await fixture(
        {
          'pkg-a': { scripts: { build: quiet('echo hi') }, rmanrc: { run: { build: { logLevel: 'silent' } } } },
        },
        { rmanrc: { logLevel: 'verbose' } },
      );
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('executing'))).toBe(false);
      expect(lines.some(l => l.includes('success'))).toBe(false);
    });

    it("an explicit CLI --log-level outranks the root's top-level default", async () => {
      await fixture({ 'pkg-a': { scripts: { build: quiet('echo hi') } } }, { rmanrc: { logLevel: 'silent' } });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, logLevel: 'verbose' }),
      );
      expect(lines.some(l => l.includes('executing'))).toBe(true);
    });
  });

  describe('concurrency', () => {
    /** Sleep-based timing check: generous thresholds since CI/dev machines vary, but
     *  serial vs (effectively) parallel execution of 3 x 150ms steps should never be close. */
    const SLEEP = 'node -e "setTimeout(()=>{},150)"';

    it('parallel=false runs packages serially (~3x one step)', async () => {
      await fixture({
        'pkg-a': { scripts: { build: SLEEP } },
        'pkg-b': { scripts: { build: SLEEP } },
        'pkg-c': { scripts: { build: SLEEP } },
      });
      const start = Date.now();
      await captureLogs(() => service('run').runScript('build', { progress: false, parallel: false }));
      expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    });

    it('the default concurrency runs independent packages in parallel (~1x one step)', async () => {
      await fixture({
        'pkg-a': { scripts: { build: SLEEP } },
        'pkg-b': { scripts: { build: SLEEP } },
        'pkg-c': { scripts: { build: SLEEP } },
      });
      const start = Date.now();
      await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(Date.now() - start).toBeLessThan(400);
    });

    it('a root .rmanrc run.<script>.concurrency applies when --parallel is not given', async () => {
      await fixture(
        {
          'pkg-a': { scripts: { build: SLEEP } },
          'pkg-b': { scripts: { build: SLEEP } },
          'pkg-c': { scripts: { build: SLEEP } },
        },
        { rmanrc: { run: { build: { concurrency: 1 } } } },
      );
      const start = Date.now();
      await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    });

    it('an explicit --parallel overrides the config concurrency', async () => {
      await fixture(
        {
          'pkg-a': { scripts: { build: SLEEP } },
          'pkg-b': { scripts: { build: SLEEP } },
          'pkg-c': { scripts: { build: SLEEP } },
        },
        { rmanrc: { run: { build: { concurrency: 1 } } } },
      );
      const start = Date.now();
      await captureLogs(() => service('run').runScript('build', { progress: false, parallel: 8 }));
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

      await createRepository(dir);
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false, changed: true }));
      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b'))).toBe(false);
    });
  });

  describe('cwd scoping (Repository.currentPackage)', () => {
    it('running from inside a single package only runs that package - not others, not the root bookend', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      // writeFixture() directly (not the fixture() helper, which always creates the Repository
      // from the root dir) - this test needs createRepository() from inside a package instead.
      writeFixture(
        dir,
        {
          'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
          'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
        },
        { scripts: { prebuild: quiet('echo ROOT-PRE-RAN') } },
      );

      await createRepository(path.join(dir, 'packages', 'pkg-a'));
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));

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

      await createRepository(path.join(dir, 'packages', 'pkg-a'));
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false, root: true }));

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

      await createRepository(dir);
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));

      expect(lines.some(l => l.includes('pkg-a-ran'))).toBe(true);
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });
  });

  /**
   * A step written as JavaScript instead of a shell command.
   *
   * Every case here goes through a real `.rmanrc.cjs`, not a hand-built `pkg.config`: a function
   * has to survive config *loading* to be worth anything, and the JS forms are the only ones that
   * can carry one - which is the feature's one real limitation and deserves to be exercised rather
   * than asserted.
   */
  describe('function steps', () => {
    it('runs the function, in the package it belongs to and its own directory', async () => {
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { exec: function step(ctx) {
            console.log('ran for', ctx.pkg.name, 'in', ctx.cwd === ctx.pkg.dirname ? 'its own dir' : 'SOMEWHERE ELSE');
          } } } }`,
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('ran for pkg-a in its own dir'))).toBe(true);
    });

    it('hands the directory over as ctx.cwd rather than changing process.cwd()', async () => {
      /**
       * The difference between a function step and a shell one that costs the most to discover late:
       * a shell step is a child process with a real working directory, a function runs inside
       * rman's own - which cannot be moved, because `run` executes packages concurrently and one
       * `process.chdir()` would move the ground under every step running beside it.
       *
       * Pinned rather than merely documented: a relative `fs.writeFileSync` inside a step lands in
       * whatever directory rman was invoked from, and nothing about the code reads as wrong.
       */
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { exec: function step(ctx) {
            console.log('cwd is', ctx.cwd === ctx.pkg.dirname ? 'the package' : 'WRONG');
            console.log('process.cwd is', process.cwd() === ctx.pkg.dirname ? 'MOVED' : 'untouched');
          } } } }`,
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('cwd is the package'))).toBe(true);
      expect(lines.some(l => l.includes('process.cwd is untouched'))).toBe(true);
    });

    it('waits for an async function before the next step', async () => {
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: {
            exec: async function slow() { await new Promise(r => setTimeout(r, 20)); console.log('FIRST'); },
            after: ${JSON.stringify(quiet('echo SECOND'))},
          } } }`,
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      const first = lines.findIndex(l => l.includes('FIRST'));
      const second = lines.findIndex(l => l.includes('SECOND'));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
    });

    it('mixes with shell commands in one list, in the order written', async () => {
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { exec: [
            ${JSON.stringify(quiet('echo ONE'))},
            function two() { console.log('TWO'); },
            ${JSON.stringify(quiet('echo THREE'))},
          ] } } }`,
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      const at = (text: string) => lines.findIndex(l => l.includes(text));
      expect(at('ONE')).toBeGreaterThanOrEqual(0);
      expect(at('TWO')).toBeGreaterThan(at('ONE'));
      expect(at('THREE')).toBeGreaterThan(at('TWO'));
    });

    it('a throw fails the step and the run, exactly as a non-zero exit does', async () => {
      await fixture({
        'pkg-a': { rmanrcJs: `{ run: { build: { exec: function boom() { throw new Error('step exploded'); } } } }` },
      });
      const { lines, error } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(error).toBeDefined();
      expect(lines.some(l => l.includes('failed') && l.includes('boom'))).toBe(true);
      expect(lines.some(l => l.includes('0 succeeded'))).toBe(true);
    });

    it("labels the step with the function's own name, so the log says which one ran", async () => {
      await fixture({
        'pkg-a': { rmanrcJs: `{ run: { build: { exec: function copyDocs() {} } } }` },
      });
      const { lines } = await captureLogs(() =>
        service('run').runScript('build', { progress: false, logLevel: 'info' }),
      );
      expect(lines.some(l => l.includes('copyDocs'))).toBe(true);
    });

    it('is reached by the bare-value shorthand too, not just the long form', async () => {
      // `run: { build: fn }` has to mean `run: { build: { exec: fn } }`, as `run: { build: 'cmd' }`
      // already means `{ exec: 'cmd' }` - a function is `typeof 'function'` rather than `'object'`,
      // so without naming it the shorthand silently produced an empty config.
      await fixture({
        'pkg-a': { rmanrcJs: `{ run: { build: function shorthand() { console.log('SHORTHAND-RAN'); } } }` },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('SHORTHAND-RAN'))).toBe(true);
    });

    it('runs as a root bookend as well, from the repository root', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      writeFixture(dir, { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } } });
      fs.writeFileSync(
        path.join(dir, '.rmanrc.cjs'),
        `module.exports = { run: { build: { before: function rootBookend(ctx) {
          console.log('ROOT-BOOKEND for', ctx.pkg.name, ctx.cwd === ctx.repository.dirname ? 'at root' : 'ELSEWHERE');
        } } } };\n`,
      );
      await createRepository(dir);
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('ROOT-BOOKEND for root at root'))).toBe(true);
    });
  });

  describe('if, as a function', () => {
    it('skips the package when it returns false', async () => {
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { if: () => false, exec: ${JSON.stringify(quiet('echo SHOULD-NOT-RUN'))} } } }`,
        },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('SHOULD-NOT-RUN'))).toBe(false);
      expect(lines.some(l => l.includes('pkg-b-ran'))).toBe(true);
    });

    it('runs it when it returns true, and hands it the package being decided about', async () => {
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { if: ctx => ctx.pkg.name === 'pkg-a', exec: ${JSON.stringify(quiet('echo A-RAN'))} } } }`,
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('A-RAN'))).toBe(true);
    });

    it('awaits an async condition rather than reading the promise as true', async () => {
      // A promise is truthy, so a condition that is merely *called* and not awaited passes
      // unconditionally - which is the failure mode worth pinning: it looks like it works.
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { if: async () => false, exec: ${JSON.stringify(quiet('echo SHOULD-NOT-RUN'))} } } }`,
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('SHOULD-NOT-RUN'))).toBe(false);
    });
  });
});

describe('run: Run.normalizeScriptValue()', () => {
  useTestEcosystem();

  it('accepts a single command, a single function, and a list mixing them', () => {
    const fn = () => {};
    expect(RunService.normalizeScriptValue('tsc -b', 'run.build.exec')).toEqual(['tsc -b']);
    expect(RunService.normalizeScriptValue(fn, 'run.build.exec')).toEqual([fn]);
    expect(RunService.normalizeScriptValue(['tsc -b', fn], 'run.build.exec')).toEqual(['tsc -b', fn]);
  });

  it('treats an absent or empty value as nothing to run', () => {
    // How a `"[*]"` block declaring a slot that some packages don't use has always behaved.
    expect(RunService.normalizeScriptValue(undefined, 'run.build.exec')).toEqual([]);
    expect(RunService.normalizeScriptValue('', 'run.build.exec')).toEqual([]);
    expect(RunService.normalizeScriptValue([], 'run.build.exec')).toEqual([]);
    expect(RunService.normalizeScriptValue(['', undefined, null], 'run.build.exec')).toEqual([]);
  });

  it('throws on a value it does not recognize, naming the config path', () => {
    // It used to `return []`, so an unrecognized value was dropped with no trace - a function here
    // (the obvious guess, and now the supported form) reported "1 succeeded" having run nothing.
    expect(() => RunService.normalizeScriptValue({ cmd: 'x' }, 'run.build.after')).toThrow(
      /"run\.build\.after" must be a shell command or a function/,
    );
    expect(() => RunService.normalizeScriptValue(42, 'version.before')).toThrow(/"version\.before"/);
  });

  it('names the offending index when the value is a list', () => {
    expect(() => RunService.normalizeScriptValue(['ok', 42], 'run.build.exec')).toThrow(/"run\.build\.exec\[1\]"/);
  });
});
