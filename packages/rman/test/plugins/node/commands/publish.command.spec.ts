import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useNodeEcosystem } from '../_fixture.js';

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

/** `console.log` and `console.error` together - `publish`'s own failure line goes to stderr, so a
 *  `--json` stdout stays one document, and these cases are about what was said, not where. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = { log: console.log, error: console.error };
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  console.log = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return lines;
}

/** A run that ends up needing to abort (uncommitted changes without --ignore-dirty, or a failed
 *  publish) hits cli.ts's `.fail()` handler on an already-logged error, which calls the real
 *  `process.exit(1)` - fatal to the test runner itself, since it's the same process. */
/**
 * Runs a CLI call that is **expected to fail**, swallowing the rejection so the assertions below can
 * inspect what it printed - and failing the test if the command unexpectedly succeeds.
 *
 * This used to stub `process.exit`, because `runCli` called it from inside the library and would
 * otherwise have taken the whole test process down. The exit belongs to the bin entry alone now, so
 * a failed command is an ordinary rejected promise - and this helper can assert the failure instead
 * of merely surviving it, which the stub never did.
 */
async function expectCliFailure(fn: () => Promise<void>): Promise<void> {
  await fn().then(
    () => {
      throw new Error('expected the command to fail, but it resolved');
    },
    () => undefined,
  );
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

  describe('--dry-run', () => {
    /**
     * **Under `--json` stdout is the plan and nothing else, even when the plan fails.** The failure
     * line went to stdout below the document: measured on opra's release, a reader parsing it got
     * `Unexpected non-whitespace character after JSON`, and the shared workflow - whose `bash -e`
     * stopped at the failed `$(...)` - printed neither the plan nor the reason.
     */
    it('--json keeps stdout one JSON document when the plan has an error', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      /** Publishing from a build directory that was never built - an `error` row. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ publish: { npm: { directory: 'build' } } }));

      await withStubbedNpm(dir, async () => {
        const stdout: string[] = [];
        const original = { log: console.log, error: console.error };
        console.log = (...args: unknown[]) => void stdout.push(args.join(' '));
        console.error = () => {};
        try {
          await expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--dry-run', '--json'] }));
        } finally {
          console.log = original.log;
          console.error = original.error;
        }
        const plan = JSON.parse(stdout.join('\n'));
        expect(plan).toEqual([expect.objectContaining({ name: 'pkg-a', status: 'error' })]);
      });
    });

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

  /**
   * **The check has to ask the registry the publish will use.** `npm publish` honours
   * `publishConfig.registry` - it survives into the generated manifest - but `npm view` ignores it:
   * measured, a package whose `publishConfig.registry` pointed at a dead local address was still
   * answered from registry.npmjs.org. Asked of the wrong registry, a lookup fails, `npmViewPackage`
   * swallows that as `undefined`, and the plan reads "never published" on every run - so the first
   * publish succeeds and the second is rejected for republishing a version.
   *
   * Pinned on the *argv*, because that is the only place the difference exists. `--dry-run` still
   * runs the check and publishes nothing.
   */
  describe('which registry a package is checked against', () => {
    async function viewCall(manifest: object, argv: string[]): Promise<string> {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0', ...manifest });
      return withStubbedNpm(dir, async logFile => {
        await captureLogs(() => runCli({ cwd: dir, argv }));
        return (
          fs
            .readFileSync(logFile, 'utf-8')
            .split('\n')
            .map(l => l.split('||')[1] ?? '')
            .find(a => a.startsWith('view')) ?? ''
        );
      });
    }

    it("uses the package's own publishConfig.registry", async () => {
      const call = await viewCall({ publishConfig: { registry: 'https://registry.example.test/' } }, [
        'publish',
        '--dry-run',
        '--yes',
      ]);
      expect(call).toContain('--registry https://registry.example.test/');
    });

    /** npm's own precedence, measured: `publishConfig` alone publishes to it, and `--registry`
     *  beside it wins. The check follows the publish rather than inventing an order. */
    it('lets --registry win over it, as npm does', async () => {
      const call = await viewCall({ publishConfig: { registry: 'https://from-manifest.test/' } }, [
        'publish',
        '--dry-run',
        '--yes',
        '--registry',
        'https://from-cli.test/',
      ]);
      expect(call).toContain('--registry https://from-cli.test/');
      expect(call).not.toContain('from-manifest');
    });

    /** **The half that keeps the case that already worked.** With neither given, nothing is passed
     *  and npm resolves `.npmrc` itself - including a scoped `@owner:registry=`, which is how a
     *  GitHub Packages repository is normally set up and which `npm view` has always honoured.
     *  Passing a default here would override it. */
    it('passes none when neither is given, so npm resolves .npmrc itself', async () => {
      const call = await viewCall({}, ['publish', '--dry-run', '--yes']);
      expect(call).toContain('view pkg-a');
      expect(call).not.toContain('--registry');
    });
  });

  /**
   * **Staged publishing puts the version in npm's queue instead of on the registry**, pending an
   * `npm stage approve` that carries the 2FA challenge. The command is `npm stage publish` - npm's
   * own spelling, not a flag - so what has to be pinned is the *command line*, which is the only
   * place the difference exists. A plan saying "staged" while the command published directly is the
   * one disagreement with no undo, since a live version cannot be unpublished after 72 hours.
   */
  describe('--staged', () => {
    it('runs "npm stage publish" rather than "npm publish"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async logFile => {
        await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes', '--staged'] }));
        const calls = fs.readFileSync(logFile, 'utf-8');
        expect(calledWith(calls, 'stage publish')).toBe(true);
        expect(calledWith(calls, 'publish')).toBe(false);
      });
    });

    /** The control, and it is what makes the case above mean anything: without the flag the command
     *  is unchanged, so the spec is about staging rather than about the stub. */
    it('without it, the command is the plain one', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async logFile => {
        await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }));
        const calls = fs.readFileSync(logFile, 'utf-8');
        expect(calledWith(calls, 'publish')).toBe(true);
        expect(calledWith(calls, 'stage')).toBe(false);
      });
    });

    /** Per package, through the cascade, like `publish.npm.directory` beside it - a repository can
     *  hold the one package that matters and publish the rest directly. */
    it('is read from .rmanrc "publish.npm.staged" as well', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ publish: { npm: { staged: true } } }));

      await withStubbedNpm(dir, async logFile => {
        await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes'] }));
        expect(calledWith(fs.readFileSync(logFile, 'utf-8'), 'stage publish')).toBe(true);
      });
    });

    /** `--no-staged` is the escape hatch, and it has to beat the config rather than merge with it:
     *  the flag is this run's decision and the config is the repository's standing one. */
    it('--no-staged overrules a config that asks for staging', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ publish: { npm: { staged: true } } }));

      await withStubbedNpm(dir, async logFile => {
        await captureLogs(() => runCli({ cwd: dir, argv: ['publish', '--yes', '--no-staged'] }));
        const calls = fs.readFileSync(logFile, 'utf-8');
        expect(calledWith(calls, 'publish')).toBe(true);
        expect(calledWith(calls, 'stage')).toBe(false);
      });
    });

    /** Said in the plan, not only done: a reader confirming a run has to see that it will not leave
     *  anything live. `detail` is the field the core prints and puts in `--dry-run --json`, which is
     *  how the dist-tag already travels without the core knowing anything about npm. */
    it('says so in the plan the reader confirms', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async () => {
        const lines = await captureLogs(() =>
          runCli({ cwd: dir, argv: ['publish', '--dry-run', '--yes', '--staged'] }),
        );
        expect(lines.some(l => l.includes('staged for approval'))).toBe(true);
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
        const lines = await captureLogs(() => expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--yes'] })));
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
    /** The message names `publish.target`, not `publish.docker`, and the distinction is exact: a
     *  package that *declares* the target but leaves out `publish.docker.image` produces an error
     *  entry in the plan, so an **empty** plan can only mean nothing named the target at all. */
    it('--target docker errors clearly when no package ships to the "docker" target', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      await withStubbedNpm(dir, async () => {
        const lines = await captureLogs(() =>
          expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--target', 'docker'] })),
        );
        expect(lines.some(l => l.includes('no package ships there') && l.includes('publish.target'))).toBe(true);
      });
    });

    /** Not a `private` skip any more - the package is out of npm's plan altogether, so asking for
     *  npm by name is the same mistake as asking for docker above (panates/rman#40). */
    it('--target npm never considers a package configured only for "docker"', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      /** An `.rmanrc`, not `package.json`'s own `"rman"` key: a directory may declare **one**
       *  config, and this fixture's `runCli` writes an `.rmanrc` to declare the preset. */
      writeJson(dir, '.rmanrc', { publish: { target: ['docker'], docker: { image: 'org/pkg-a' } } });

      await withStubbedNpm(dir, async logFile => {
        const lines = await captureLogs(() =>
          expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--target', 'npm', '--yes'] })),
        );
        expect(lines.some(l => l.includes('--target npm') && l.includes('no package ships there'))).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false);
      });
    });

    it('--target docker shows a "[docker]"-labeled plan entry, without touching npm at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0', private: true });
      /** An `.rmanrc`, not `package.json`'s own `"rman"` key: a directory may declare **one**
       *  config, and this fixture's `runCli` writes an `.rmanrc` to declare the preset. */
      writeJson(dir, '.rmanrc', { publish: { target: ['docker'], docker: { image: 'org/pkg-a' } } });

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
        const lines = await captureLogs(() => expectCliFailure(() => runCli({ cwd: dir, argv: ['publish', '--yes'] })));
        expect(lines.some(l => l.includes('failed') && l.includes('pkg-a'))).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});
