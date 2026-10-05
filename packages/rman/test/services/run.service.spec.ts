import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Package, Repository, resolveRootLogLevel } from '../../src/index.js';
import { resolveBool, resolveLogLevel, resolveNumber, RunService } from '../../src/services/run.service.js';
import { VersionService } from '../../src/services/version.service.js';
import { StatusRegion } from '../../src/utils/status-region.js';
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
  root?: { scripts?: Record<string, string>; rmanrc?: unknown; rmanrcJs?: string },
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
   *  package is. Without a marker, creating a repository from a nested directory roots there.
   *
   *  **One file, never both.** A directory may declare a single config, so a case wanting a
   *  function at the root asks for `rmanrcJs` and gets a `.rmanrc.cjs` *instead of* the marker -
   *  which still marks the root, since `findRoot` looks for any `.rmanrc*`. Writing the JSON one
   *  too is what several cases used to do, and the reader refuses it by design. */
  if (root?.rmanrcJs) fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), `module.exports = ${root.rmanrcJs};\n`);
  else fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(root?.rmanrc ?? {}));
  for (const [name, def] of Object.entries(packages)) {
    const pkgDir = path.join(dir, 'packages', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: def.dependencies, scripts: def.scripts }),
    );
    /** The same rule per package: one config file or the other, never both. */
    if (def.rmanrcJs) fs.writeFileSync(path.join(pkgDir, '.rmanrc.cjs'), `module.exports = ${def.rmanrcJs};\n`);
    else if (def.rmanrc) fs.writeFileSync(path.join(pkgDir, '.rmanrc'), JSON.stringify(def.rmanrc));
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

/**
 * `captureLogs`, watching **stderr as well** - for a step's own failure message, which goes there.
 *
 * A separate helper rather than widening `captureLogs`, and the reason is measured: forty-odd
 * cases in this file assert `lines.some(...)` is `false`, so folding another stream into the same
 * array risks turning one of those into a pass or a failure for a reason nobody asked about.
 *
 * **This is also the mistake that made the specs below pass their first negative control for the
 * wrong reason.** They asserted on `captureLogs().lines`, `console.error` is not in it, so they
 * were red with the fix *and* without it - and reverting the fix and seeing red looked like proof.
 * A control that cannot come out green proves nothing.
 */
async function captureAllLogs(fn: () => Promise<void>): Promise<{ lines: string[]; error?: Error }> {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  try {
    const result = await captureLogs(fn);
    return { lines: [...lines, ...result.lines], error: result.error };
  } finally {
    console.error = originalError;
  }
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
    root?: { scripts?: Record<string, string>; rmanrc?: unknown; rmanrcJs?: string },
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

    /**
     * **Per-step `topo`: where a package starts waiting for its dependencies.**
     *
     * The run order is recorded by appending to one file, so the file *is* the order. `pkg-b`
     * depends on `pkg-a`; the `lint` step sleeps, so if `pkg-b` were waiting for the whole of
     * `pkg-a` its first line could not beat `pkg-a`'s last one.
     *
     * Only `pkg-b` is split: `pkg-a` has nothing in the run to wait for, so it stays one task
     * whatever its config says - which is the optimization, and the reason the assertions below are
     * all about `pkg-b`.
     */
    describe('a barrier in the middle of a package', () => {
      /** Appends `<pkg> <step>` to one shared file. A shell step, so the order the lines land in is
       *  the order the steps ran - no clock to read and nothing to make flaky. */
      const stamp = (log: string, step: string) => `echo "\${{ pkg.name }} ${step}" >> ${log}`;

      /**
       * A step that does not finish until **every** package has reached it, then stamps the log.
       *
       * **A rendezvous rather than a sleep, because a sleep measures the runner and not the code.**
       * "Did these two overlap" was asserted by ordering a `sleep 0.2` against a later step, and on
       * a loaded CI runner `pkg-a` got through *both* of its steps before `pkg-b`'s shell had
       * started: the suite failed on Node 22 and 24, passed on 23, and passed on every local run.
       * Here, two packages that run together both finish and two that are serialized cannot - the
       * waiter times out and exits non-zero, which fails the package and shows up in the log as a
       * missing line rather than as a flake.
       *
       * `total` is how many packages are expected; the bound is ~5s, long enough that no scheduler
       * delay reaches it and short enough to report rather than hang.
       */
      const rendezvous = (log: string, dir: string, step: string, total: number) =>
        `touch ${dir}/\${{ pkg.name }}.at-${step}; n=0; ` +
        `while [ "$(ls ${dir}/*.at-${step} 2>/dev/null | wc -l)" -lt ${total} ] && [ $n -lt 500 ]; ` +
        `do sleep 0.01; n=$((n+1)); done; ` +
        `[ "$(ls ${dir}/*.at-${step} 2>/dev/null | wc -l)" -ge ${total} ] && ${stamp(log, step)}`;

      function orderFixture(log: string, dir: string, mark: boolean) {
        /** The first step is the rendezvous only in the marked case: that is the one claiming the
         *  packages run it together. Unmarked, they are serialized on purpose and waiting for each
         *  other would deadlock - so the control stamps and returns. */
        const first = mark ? rendezvous(log, dir, 'lint', 2) : stamp(log, 'lint');
        return {
          '[*]': {
            run: {
              build: {
                before: [
                  mark ? { topo: false, command: first } : first,
                  mark ? { topo: true, command: stamp(log, 'gen') } : stamp(log, 'gen'),
                ],
                exec: stamp(log, 'tsc'),
              },
            },
          },
        };
      }

      async function runOrdered(mark: boolean): Promise<string[]> {
        const dir = mkTmp();
        dirs.push(dir);
        const log = path.join(dir, 'order.log');
        writeFixture(
          dir,
          { 'pkg-a': {}, 'pkg-b': { dependencies: { 'pkg-a': '1.0.0' } } },
          { rmanrc: orderFixture(log, dir, mark) },
        );
        await createRepository(dir);
        await captureLogs(() => service('run').runScript('build', { progress: false }));
        return fs.readFileSync(log, 'utf-8').trim().split('\n');
      }

      it('runs the steps before it without waiting, and the ones from it on after the dependency', async () => {
        const order = await runOrdered(true);
        /** Both `lint` lines are there at all, which is the claim: the step is a rendezvous, so a
         *  package that waited for the other's whole script would have timed out and stamped
         *  nothing. Nothing here is read from a clock. */
        expect(order.filter(l => l.endsWith(' lint')).sort()).toEqual(['pkg-a lint', 'pkg-b lint']);
        // ...and from the marked step on, it did wait.
        expect(order.indexOf('pkg-a tsc')).toBeLessThan(order.indexOf('pkg-b gen'));
        expect(order.indexOf('pkg-b gen')).toBeLessThan(order.indexOf('pkg-b tsc'));
      });

      /** The control, and the compatibility claim: with no step marked, the wait is where it has
       *  always been - before the package's first step. */
      it('control: with no step marked, the whole package waits as before', async () => {
        const order = await runOrdered(false);
        expect(order.indexOf('pkg-a tsc')).toBeLessThan(order.indexOf('pkg-b lint'));
      });

      /**
       * **A script whose steps all say `topo: false` does not wait at all**, although the script's
       * own `topo` is on by default. The steps are read as the whole statement once any of them
       * mentions the key - the alternative is `run.<script>.topo` overruling every line the author
       * wrote, which is the shape of a setting that cannot be turned off from where it is used.
       *
       * This is the half a single `findIndex` cannot express: "no step said true" and "no step said
       * anything" are different answers.
       */
      it('does not wait at all when every step says topo: false', async () => {
        const dir = mkTmp();
        dirs.push(dir);
        const log = path.join(dir, 'order.log');
        writeFixture(
          dir,
          { 'pkg-a': {}, 'pkg-b': { dependencies: { 'pkg-a': '1.0.0' } } },
          {
            rmanrc: {
              '[*]': {
                run: {
                  build: {
                    before: { topo: false, command: rendezvous(log, dir, 'lint', 2) },
                    exec: { topo: false, command: stamp(log, 'tsc') },
                  },
                },
              },
            },
          },
        );
        await createRepository(dir);
        await captureLogs(() => service('run').runScript('build', { progress: false }));
        const order = fs.readFileSync(log, 'utf-8').trim().split('\n');
        /** Both reached the rendezvous, so neither waited for the other - a serialized pair would
         *  have deadlocked until the step's own bound and stamped nothing. */
        expect(order.filter(l => l.endsWith(' lint')).sort()).toEqual(['pkg-a lint', 'pkg-b lint']);
      });
    });

    it('a failure before the barrier still stops the package and its dependents', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      writeFixture(
        dir,
        { 'pkg-a': {}, 'pkg-b': { dependencies: { 'pkg-a': '1.0.0' } } },
        {
          rmanrc: {
            '[*]': {
              run: {
                build: {
                  before: ['exit 1', { topo: true, command: quiet('echo past-the-barrier') }],
                  exec: quiet('echo exec-ran'),
                },
              },
            },
          },
        },
      );
      await createRepository(dir);
      const { lines } = await captureLogs(() =>
        service('run')
          .runScript('build', { progress: false, bail: false })
          .catch(() => undefined),
      );
      expect(lines.some(l => l.includes('past-the-barrier'))).toBe(false);
      expect(lines.some(l => l.includes('exec-ran'))).toBe(false);
    });
  });

  /**
   * **With no panel, a child runs without a terminal and rman prints its lines.**
   *
   * A child that finds a TTY draws its own live output - and a build is mostly other CLIs. Reported
   * as `rman build --no-progress` printing progress and losing its logs: under a real terminal a
   * nested `rman check` drew its own panel inside the run, and two spinners moved the cursor up over
   * each other's rows (149 spinner frames, 154 cursor-ups in one short build; 0 and 0 after).
   *
   * Mocha's stdout is not a terminal, so whether the child *sees* one cannot be asked here directly.
   * What can: an inherited child writes to the file descriptor and never passes through
   * `process.stdout.write`, while a piped one is printed by rman and does. So a line showing up in
   * the stub is the line having been piped.
   */
  describe('with the panel off', () => {
    function captureWrites<T>(fn: () => Promise<T>): Promise<{ out: string; err: string }> {
      const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
      const got = { out: '', err: '' };
      process.stdout.write = ((c: any) => ((got.out += String(c)), true)) as typeof process.stdout.write;
      process.stderr.write = ((c: any) => ((got.err += String(c)), true)) as typeof process.stderr.write;
      const restore = () => {
        process.stdout.write = write.out;
        process.stderr.write = write.err;
      };
      return fn().then(
        () => (restore(), got),
        e => (restore(), Promise.reject(e)),
      );
    }

    /** The markers are computed by the shell (`OUT-$((1+1))` prints `OUT-2`) because the panel-off
     *  log line prints the step's *command* on stdout - so a literal marker would turn up there
     *  whichever stream the child actually wrote it to. */
    it("prints a shell step's lines itself, each to the stream it came from", async () => {
      await fixture({ 'pkg-a': { scripts: { build: 'echo OUT-$((1+1)) && echo ERR-$((2+2)) 1>&2' } } });

      const { out, err } = await captureWrites(() => service('run').runScript('build', { progress: false }));

      expect(out).toContain('OUT-2');
      expect(err).toContain('ERR-4');
      expect(err).not.toContain('OUT-2');
      expect(out).not.toContain('ERR-4');
    });

    /** A function step's child goes through `runBin` rather than `exec`, so it is the other half. */
    it("prints a function step's child the same way", async () => {
      await fixture({
        'pkg-a': {
          rmanrcJs: `{ run: { build: { exec: async ({ runBin }) => {
            await runBin('node', ['-e', "console.log('FN-OUT');console.error('FN-ERR')"]);
          } } } }`,
        },
      });

      const { out, err } = await captureWrites(() => service('run').runScript('build', { progress: false }));

      expect(out).toContain('FN-OUT');
      expect(err).toContain('FN-ERR');
    });

    /**
     * **A live status line is silenced for the run**, for the case `--no-progress` does not reach:
     * a panel turned off by config, or by stdout being redirected while stderr is still a terminal.
     * The children's lines are printed straight to the terminal, and a spinner redrawing in place
     * would move the cursor up over them. Resumed afterwards, so the command's result line still
     * closes the bracket.
     */
    it('silences a live status line while it prints, and gives it back afterwards', async () => {
      const repo = await fixture({ 'pkg-a': { scripts: { build: 'echo hi' } } });
      const region = new StatusRegion('build', '', true);
      const calls: string[] = [];
      const suspend = region.suspend.bind(region);
      const resume = region.resume.bind(region);
      region.suspend = (t?: any) => (calls.push('suspend'), suspend(t));
      region.resume = () => (calls.push('resume'), resume());
      repo.app.statusRegion = region;
      try {
        await captureWrites(() => service('run').runScript('build', { progress: false }));
      } finally {
        repo.app.statusRegion = undefined;
      }
      expect(calls).toEqual(['suspend', 'resume']);
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

    /**
     * **`before`/`after` compose; only `exec` replaces.** A package's `prebuild` used to drop the
     * config's `before` outright, and the report that found it is the shape to keep in mind: a root
     * declaring a repo-wide `before` lost it for any package that later added a codegen
     * `prebuild` - silently, with a stale build directory as the only symptom.
     *
     * They are not the same kind of key. `exec` is one answer to one question, so a package
     * declaring `"build"` and a config declaring `exec` are the same build stated twice. A hook is
     * a point, and two hooks at one point both belong.
     */
    it("composes the config's before/after around the package's own pre/post hooks", async () => {
      await fixture({
        'pkg-a': {
          scripts: {
            prebuild: quiet('echo OWN-PRE'),
            build: quiet('echo OWN-MAIN'),
            postbuild: quiet('echo OWN-POST'),
          },
          rmanrc: { run: { build: { before: quiet('echo CONFIG-PRE'), after: quiet('echo CONFIG-POST') } } },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      /** **The order is the claim, not merely that all five ran.** The config's statement is the
       *  wider one - "before this script, for every package" - so it brackets the package's own,
       *  which is the shape a bookend already has here. */
      const order = ['CONFIG-PRE', 'OWN-PRE', 'OWN-MAIN', 'OWN-POST', 'CONFIG-POST'];
      const at = order.map(tag => lines.findIndex(l => l.includes(tag)));
      expect(at.filter(i => i === -1)).toEqual([]);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    /** The control for the one above, and the half that must not change: `exec` is a single answer,
     *  so the package's own still replaces the config's rather than running both. */
    it("still lets the package's own script replace the config's exec while the hooks compose", async () => {
      await fixture({
        'pkg-a': {
          scripts: { prebuild: quiet('echo OWN-PRE'), build: quiet('echo OWN-MAIN') },
          rmanrc: {
            run: {
              build: { before: quiet('echo CONFIG-PRE'), exec: quiet('echo CONFIG-MAIN') },
            },
          },
        },
      });
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('CONFIG-PRE'))).toBe(true);
      expect(lines.some(l => l.includes('OWN-PRE'))).toBe(true);
      expect(lines.some(l => l.includes('OWN-MAIN'))).toBe(true);
      expect(lines.some(l => l.includes('CONFIG-MAIN'))).toBe(false);
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

    it('--from-root (fromRoot: true) runs across the whole repository even from inside a single package', async () => {
      const dir = mkTmp();
      dirs.push(dir);
      writeFixture(dir, {
        'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } },
        'pkg-b': { scripts: { build: quiet('echo pkg-b-ran') } },
      });

      await createRepository(path.join(dir, 'packages', 'pkg-a'));
      const { lines } = await captureLogs(() => service('run').runScript('build', { progress: false, fromRoot: true }));

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

    /**
     * **And it says *why*, which for a long time it did not.**
     *
     * A shell step's reason arrives on its own - the output streams out and `exec` names the
     * command and its exit code. A function step has neither, so the message was simply dropped:
     * the run printed `error build pkg-a ┆ exec failed ┆ boom` and exited 1, and `step exploded`
     * appeared nowhere. Measured on a real shared config whose build step threw a worded
     * explanation of a missing `tsconfig.json` - the one line that said what to do was the one
     * line lost, and the spec above passed throughout, because it only ever looked for the word
     * `failed` and the function's name.
     *
     * This covers the panel-off path, which is what CI and every non-TTY run take. The panel-on
     * path goes through the same `runFunctionStep` and writes the message to the step's own log
     * via `onLine`, where a shell step's output already goes.
     */
    it("reports the thrown message, not just that a step named 'boom' failed", async () => {
      await fixture({
        'pkg-a': { rmanrcJs: `{ run: { build: { exec: function boom() { throw new Error('step exploded'); } } } }` },
      });
      const { lines } = await captureAllLogs(() => service('run').runScript('build', { progress: false }));
      expect(lines.some(l => l.includes('step exploded'))).toBe(true);
    });

    /** A step may throw anything, and `String(undefined)` in a run log is worse than admitting
     *  nothing was said - so a non-`Error` is described rather than stringified blindly. */
    it('describes a non-Error throw instead of logging an empty line', async () => {
      await fixture({
        'pkg-a': { rmanrcJs: `{ run: { build: { exec: function boom() { throw undefined; } } } }` },
      });
      const { lines, error } = await captureAllLogs(() => service('run').runScript('build', { progress: false }));
      expect(error).toBeDefined();
      expect(lines.some(l => l.includes('the step threw undefined'))).toBe(true);
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
      writeFixture(
        dir,
        { 'pkg-a': { scripts: { build: quiet('echo pkg-a-ran') } } },
        {
          rmanrcJs: `{ run: { build: { before: function rootBookend(ctx) {
            console.log('ROOT-BOOKEND for', ctx.pkg.name, ctx.cwd === ctx.repository.dirname ? 'at root' : 'ELSEWHERE');
          } } } }`,
        },
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
    expect(() => RunService.normalizeScriptValue(42, 'run.build.after')).toThrow(
      /"run\.build\.after" must be a shell command, a function, or \{ command \| run, topo \}/,
    );
    expect(() => RunService.normalizeScriptValue(42, 'version.before')).toThrow(/"version\.before"/);
  });

  it('names the offending index when the value is a list', () => {
    expect(() => RunService.normalizeScriptValue(['ok', 42], 'run.build.exec')).toThrow(/"run\.build\.exec\[1\]"/);
  });

  describe('the object form', () => {
    it('takes a command or a function under one key, with or without topo', () => {
      const fn = () => {};
      expect(RunService.normalizeScriptValue({ command: 'tsc -b' }, 'run.build.exec')).toEqual([
        { command: 'tsc -b', topo: undefined },
      ]);
      expect(RunService.normalizeScriptValue([{ topo: true, command: fn }], 'run.build.after')).toEqual([
        { command: fn, topo: true },
      ]);
      expect(RunService.normalizeScriptValue([{ topo: false, command: 'eslint .' }], 'run.build.before')).toEqual([
        { command: 'eslint .', topo: false },
      ]);
    });

    /**
     * **The reason unknown keys are refused rather than ignored.** `{ topo: true, script: 'tsc -b' }`
     * reads perfectly well and names the key rman uses for the *lifecycle*; ignored, that step would
     * run nothing while the run reported success.
     */
    it('refuses an unknown key, and says where the command goes', () => {
      expect(() => RunService.normalizeScriptValue([{ topo: true, script: 'tsc -b' }], 'run.build.after')).toThrow(
        /unknown key "script"[\s\S]*goes in "command"/,
      );
    });

    it('refuses a step with no command, and a topo that is not a boolean', () => {
      expect(() => RunService.normalizeScriptValue({ topo: true }, 'run.build.exec')).toThrow(
        /must set "command" to a shell command or a function/,
      );
      expect(() => RunService.normalizeScriptValue({ command: 'x', topo: 'yes' }, 'run.build.exec')).toThrow(
        /must set "topo" to true or false/,
      );
    });

    /** A version hook runs for one package around its own version write - no package graph, so the
     *  key means nothing there and says so rather than being dropped. */
    it('refuses topo in a version hook', () => {
      expect(() => VersionService.normalizeScriptValue([{ topo: true, command: 'x' }], 'version.before')).toThrow(
        /cannot set "topo"[\s\S]*belongs to run\.<script> steps/,
      );
      expect(VersionService.normalizeScriptValue([{ command: 'x' }], 'version.before')).toEqual([
        { command: 'x', topo: undefined },
      ]);
    });
  });
});

/**
 * **A function step names itself until it spawns something.** `buildWithTsc()` is all the slot
 * knows, and it is what the panel row showed for the whole of a build; what a reader wants is the
 * `tsc -b <tsconfig>` it is sitting in. A function step is the shape every shared config uses, so
 * this is the common case rather than an edge one.
 */
describe('RunService.createStepContext() reports what a step spawns', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  async function stepContextFor(onCommand?: (c: string | undefined) => void) {
    const dir = mkTmp();
    dirs.push(dir);
    writeFixture(dir, { 'pkg-a': {} });
    const repository = await createRepository(dir);
    const pkg = repository.getPackage('pkg-a')!;
    return RunService.createStepContext(pkg, pkg.dirname, onCommand);
  }

  it('names the argv while a child runs, and takes the name back when it returns', async () => {
    const seen: (string | undefined)[] = [];
    const ctx = await stepContextFor(c => seen.push(c));

    await ctx.runBin('node', ['-e', 'process.exit(0)']);

    expect(seen).toEqual(['node -e process.exit(0)', undefined]);
  });

  /** **Not handed back on a failure**, deliberately: the step is over, its row becomes a failed one,
   *  and the function's own name is a worse thing to read there than the command that exited
   *  non-zero. */
  it('leaves the failing command in place when the child fails', async () => {
    const seen: (string | undefined)[] = [];
    const ctx = await stepContextFor(c => seen.push(c));

    await expect(ctx.runBin('node', ['-e', 'process.exit(1)'])).rejects.toThrow();

    expect(seen).toEqual(['node -e process.exit(1)']);
  });

  it('is optional - a caller that does not want it passes nothing', async () => {
    const ctx = await stepContextFor();
    await expect(ctx.runBin('node', ['-e', 'process.exit(0)'])).resolves.toBeDefined();
  });
});

/**
 * **Patching `console` per step corrupts it under concurrency**, which is what this replaces. Each
 * step used to save "the original" and restore it, so with two running at once the second restored
 * the *first one's patch* and the real console never came back:
 *
 *     A patches  -> A's "original" is the real console
 *     B patches  -> B's "original" is A's patch
 *     A restores -> real console
 *     B restores -> A's patch, for the rest of the process
 *
 * Measured on a twenty-package build with sixteen running at once: afterwards `printSummary`'s own
 * `console.log` calls went into a finished package's log array, so the run printed **no recap and
 * no failure logs at all**.
 */
/**
 * **The scheduler, offered to a command that is not running a script.**
 *
 * `rman check` was `for (const pkg of ...) await runBin(...)`: no `--parallel`, no panel, and
 * `--bail`, the package filters and a summary line re-implemented beside rman's own. Measured on
 * `panates/opra` after this existed - nineteen packages, **8.6s serial against 1.7s** at CPU
 * concurrency, for work with no dependencies between any of it.
 */
describe('RunService.forEachPackage()', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  async function repoOf(packages: Record<string, PackageDef>): Promise<Repository> {
    const dir = mkTmp();
    dirs.push(dir);
    writeFixture(dir, packages);
    return createRepository(dir);
  }

  /** Three packages that each sleep, so wall-clock time answers "did these overlap" without a
   *  clock the test has to read. */
  const three = { 'pkg-a': {}, 'pkg-b': {}, 'pkg-c': {} };

  it('runs the packages concurrently by default, and serially when told to', async () => {
    const repo = await repoOf(three);
    const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 150));

    const concurrent = Date.now();
    await captureLogs(() => service('run').forEachPackage(repo.getPackages(), sleep, { progress: false }));
    const concurrentMs = Date.now() - concurrent;

    const serial = Date.now();
    await captureLogs(() =>
      service('run').forEachPackage(repo.getPackages(), sleep, { progress: false, parallel: false }),
    );
    const serialMs = Date.now() - serial;

    expect(concurrentMs).toBeLessThan(300);
    expect(serialMs).toBeGreaterThan(400);
  });

  /**
   * **What the callback is handed is a function step's own context**, which is the point: an
   * imported `runBin` knows neither the package's directory nor this run's log level, so a command
   * using one had to thread `cwd`, `app` and `logLevel` through by hand at every call.
   */
  it('hands each package a runBin already bound to its own directory', async () => {
    const repo = await repoOf(three);
    const seen: string[] = [];
    await captureLogs(() =>
      service('run').forEachPackage(
        repo.getPackages(),
        async ctx => {
          seen.push(`${ctx.pkg.name}:${ctx.cwd === ctx.pkg.dirname}`);
          expect(typeof ctx.runBin).toBe('function');
          expect(ctx.logger).toBeDefined();
        },
        { progress: false, parallel: false },
      ),
    );
    expect(seen).toEqual(['pkg-a:true', 'pkg-b:true', 'pkg-c:true']);
  });

  it('throws when a package fails, and stops the rest when bail is on', async () => {
    const repo = await repoOf(three);
    const ran: string[] = [];
    /** `captureLogs` returns the rejection rather than re-throwing it, so the assertion reads the
     *  error off the result - see its own doc. */
    const { error } = await captureLogs(() =>
      service('run').forEachPackage(
        repo.getPackages(),
        async ({ pkg }) => {
          ran.push(pkg.name);
          if (pkg.name === 'pkg-a') throw new Error('nope');
        },
        { progress: false, parallel: false },
      ),
    );
    expect(error?.message).toMatch(/failed/);
    expect(ran).toEqual(['pkg-a']);
  });

  it('runs every package when bail is off, and still throws', async () => {
    const repo = await repoOf(three);
    const ran: string[] = [];
    const { error } = await captureLogs(() =>
      service('run').forEachPackage(
        repo.getPackages(),
        async ({ pkg }) => {
          ran.push(pkg.name);
          if (pkg.name === 'pkg-a') throw new Error('nope');
        },
        { progress: false, parallel: false, bail: false },
      ),
    );
    expect(error?.message).toMatch(/failed/);
    expect(ran.sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
  });

  /**
   * **Ordering is off unless asked for, the opposite of `run`'s default.** A command sweeping
   * packages with a tool that reads each one's own sources is the common case here, and a wait
   * nobody asked for costs exactly what this call was reached for.
   */
  it('does not wait for dependencies unless topo is asked for', async () => {
    const repo = await repoOf({ 'pkg-a': {}, 'pkg-b': { dependencies: { 'pkg-a': '1.0.0' } } });
    const order: string[] = [];
    const step = async ({ pkg }: { pkg: Package }) => {
      if (pkg.name === 'pkg-a') await new Promise<void>(r => setTimeout(r, 150));
      order.push(pkg.name);
    };

    await captureLogs(() => service('run').forEachPackage(repo.getPackages(), step, { progress: false }));
    expect(order).toEqual(['pkg-b', 'pkg-a']);

    order.length = 0;
    await captureLogs(() => service('run').forEachPackage(repo.getPackages(), step, { progress: false, topo: true }));
    expect(order).toEqual(['pkg-a', 'pkg-b']);
  });

  it('does nothing, and does not throw, for an empty list', async () => {
    await repoOf(three);
    await captureLogs(() => service('run').forEachPackage([], async () => {}, { progress: false }));
  });
});

/**
 * The low-level half: `Promise.all` under the repository's concurrency rule, for work that is not
 * per package. It buys the limit and nothing else - no row to name, nothing to order by - which is
 * why `forEachPackage` is the one a command should reach for first.
 */
describe('RunService.parallel()', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  async function svc() {
    const dir = mkTmp();
    dirs.push(dir);
    writeFixture(dir, { 'pkg-a': {} });
    await createRepository(dir);
    return service('run');
  }

  it('returns the results in the order the tasks were given, whatever order they finish in', async () => {
    const run = await svc();
    const results = await run.parallel([
      async () => {
        await new Promise<void>(r => setTimeout(r, 60));
        return 'slow';
      },
      async () => 'fast',
    ]);
    expect(results).toEqual(['slow', 'fast']);
  });

  it('never has more than `parallel` tasks in flight', async () => {
    const run = await svc();
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise<void>(r => setTimeout(r, 30));
      inFlight--;
    };
    await run.parallel(
      Array.from({ length: 8 }, () => task),
      { parallel: 2 },
    );
    expect(peak).toBe(2);
  });

  /**
   * **A plain `Promise.all` rejects while its siblings keep running**, and with child processes
   * behind them that leaves output arriving after the command has reported and exited. This settles
   * what is already in flight first - pinned by a task that writes *after* its await.
   */
  it('settles the tasks already in flight before it throws', async () => {
    const run = await svc();
    const finished: string[] = [];
    await expect(
      run.parallel(
        [
          async () => {
            throw new Error('first');
          },
          async () => {
            await new Promise<void>(r => setTimeout(r, 40));
            finished.push('sibling');
          },
        ],
        { parallel: 2 },
      ),
    ).rejects.toThrow('first');
    expect(finished).toEqual(['sibling']);
  });
});

describe('RunService.withCapturedConsole()', () => {
  /** A stub this spec owns, so "was the console handed back" is a question about identity rather
   *  than about behaviour. */
  function withStubbedConsole<T>(fn: (stub: typeof console.log) => Promise<T>): Promise<T> {
    const pristine = console.log;
    const stub = (() => {}) as typeof console.log;
    console.log = stub;
    return fn(stub).finally(() => {
      console.log = pristine;
    });
  }

  it('hands the real console back after the last of several concurrent steps', async () => {
    await withStubbedConsole(async stub => {
      const a: string[] = [];
      const b: string[] = [];
      await Promise.all([
        RunService.withCapturedConsole(
          l => a.push(l),
          async () => {
            console.log('a-1');
            await wait(60);
            console.log('a-2');
          },
        ),
        RunService.withCapturedConsole(
          l => b.push(l),
          async () => {
            await wait(20);
            console.log('b-1');
            await wait(60);
            console.log('b-2');
          },
        ),
      ]);

      /** **The assertion the old code fails.** It left whichever patch happened to be installed
       *  when the last step started. */
      expect(console.log).toBe(stub);
      /** And each step's lines went to its own sink, not into whichever one patched last. */
      expect(a).toEqual(['a-1', 'a-2']);
      expect(b).toEqual(['b-1', 'b-2']);
    });
  });

  it('hands it back even when a step throws', async () => {
    await withStubbedConsole(async stub => {
      await expect(
        RunService.withCapturedConsole(
          () => {},
          async () => {
            throw new Error('boom');
          },
        ),
      ).rejects.toThrow('boom');
      expect(console.log).toBe(stub);
    });
  });

  it('a log from outside any step reaches the real console', async () => {
    await withStubbedConsole(async () => {
      const captured: string[] = [];
      const seen: unknown[][] = [];
      console.log = ((...args: unknown[]) => void seen.push(args)) as typeof console.log;
      await RunService.withCapturedConsole(
        l => captured.push(l),
        async () => {
          console.log('inside');
        },
      );
      console.log('outside');

      expect(captured).toEqual(['inside']);
      expect(seen).toEqual([['outside']]);
    });
  });
});

/** Resolves after `ms` - the concurrency cases need the two steps to overlap. */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
