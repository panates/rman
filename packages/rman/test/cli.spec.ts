import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { version } from '../src/constants.js';
import type { ArgsOf, CommandOption } from '../src/index.js';
import { runCli, useTestEcosystem } from './_fixture.js';

/** Runs `fn` with console.log captured (plain, unmodified) instead of printed - proves what the
 *  CLI actually logged without spamming test output. */
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

/** Runs `fn` with `process.stderr.write` captured. The status lines go to stderr on purpose - so a
 *  caller redirecting stdout into a file keeps the answer alone in it - which is also why
 *  `captureLogs` above cannot see them. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = '';
  (process.stderr as NodeJS.WriteStream).write = ((chunk: any) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    (process.stderr as NodeJS.WriteStream).write = original;
  }
  return out;
}

describe('cli: global --log-level', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('the global --log-level flag overrides the root .rmanrc "logLevel" through real CLI parsing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0', scripts: { build: 'echo hi > /dev/null 2>&1' } }),
    );
    // root config says "silent" (no per-step lines at all) - the CLI flag below must win over it.
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ logLevel: 'silent' }));

    const lines = await captureLogs(() =>
      runCli({ cwd: dir, argv: ['run', 'build', '--no-progress', '--log-level', 'verbose'] }),
    );
    expect(lines.some(l => l.includes('executing'))).toBe(true);
  });

  it('without a CLI override, the root .rmanrc "logLevel" is what actually takes effect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0', scripts: { build: 'echo hi > /dev/null 2>&1' } }),
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ logLevel: 'silent' }));

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['run', 'build', '--no-progress'] }));
    expect(lines.some(l => l.includes('┆'))).toBe(false);
  });
});

describe('cli: global --config', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A monorepo whose `build` step would leave a file behind - so "nothing was run" is provable
   *  rather than merely printed. `pkg-b` is skipped, which the target list has to reflect. */
  function fixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-config-flag-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    fs.writeFileSync(
      path.join(dir, '.rmanrc'),
      JSON.stringify({
        packageManager: 'pnpm',
        '[*]': { run: { build: { exec: 'echo ran > ran.txt' } } },
        '[pkg-b]': { skip: true },
      }),
    );
    for (const name of ['a', 'b']) {
      fs.mkdirSync(path.join(dir, 'packages', name), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'packages', name, 'package.json'),
        JSON.stringify({ name: `pkg-${name}`, version: '1.0.0' }),
      );
    }
    return dir;
  }

  it('prints what the command would run with, and runs nothing at all', async () => {
    const dir = fixture();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config', '--parallel', '2'] }));
    const out = lines.join('\n');

    expect(out).toContain('command: build');
    /** The parsed argv - what this invocation asked for. */
    expect(out).toContain('parallel: 2');
    /** And the step never ran: no file, which is the claim the header makes. */
    expect(fs.existsSync(path.join(dir, 'packages/a/ran.txt'))).toBe(false);
    expect(out).toContain('nothing was run');
  });

  it('narrows the config to the keys the command declares it reads', async () => {
    const dir = fixture();
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config'] }))).join('\n');
    expect(out).toContain('the keys build reads: run.build');
    expect(out).toContain('run.build:');
    expect(out).toContain('echo ran > ran.txt');
  });

  it('works out the key from argv when the command needs it to (run <script>)', async () => {
    const dir = fixture();
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['run', 'lint', '--config'] }))).join('\n');
    /** Nothing configures `lint`, and saying so is the point - "why did my lint step do nothing". */
    expect(out).toContain('the keys run reads: run.lint');
    expect(out).toContain('pkg-a: {}');
  });

  it('lists the packages the command would act on, after --scope and skip', async () => {
    const dir = fixture();
    const all = (await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config'] }))).join('\n');
    /** `pkg-b` carries `skip: true`, so it is not a target - the same set the command computes. */
    expect(all).toContain('packages: [pkg-a]');

    const scoped = (
      await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config', '--scope', 'pkg-nope'] }))
    ).join('\n');
    expect(scoped).toContain('packages: []');
  });

  it('lists the root package as well, since repo-wide keys are read there', async () => {
    const dir = fixture();
    /** `ci` is a plugin command here, so use a core one that reads a root key: `github-release`
     *  reads `githubRelease`, and the root is where that lives. Without the root in the output, a
     *  command reading only root keys answered with `pkg-a: {}` - "nothing is configured". */
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['build', '--config'] }))).join('\n');
    expect(out).toContain('root:');
    expect(out).toContain('is the root - listed because repo-wide keys are read there');
  });

  it("reaches a repository's own .rman/*.mjs command too, and forwards its configKeys", async () => {
    const dir = fixture();
    fs.mkdirSync(path.join(dir, '.rman'));
    fs.writeFileSync(
      path.join(dir, '.rman', 'deploy.mjs'),
      `export default {
         describe: 'would deploy',
         configKeys: ['vars'],
         handler: ctx => { throw new Error('the handler must not run under --config'); },
       };`,
    );
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['deploy', '--config'] }))).join('\n');
    expect(out).toContain('command: deploy');
    expect(out).toContain('the keys deploy reads: vars');
  });

  /**
   * **`.rmanrc "commands"` is the same path, with the directory named instead of assumed** -
   * `.rman/*.mjs` is only this key's default value.
   */
  it('loads a command from a directory the config names, not just .rman', async () => {
    const dir = fixture();
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.writeFileSync(
      path.join(dir, 'tools', 'ship.mjs'),
      `export default { describe: 'would ship', handler: () => console.log('shipped') };`,
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ commands: 'tools/*.mjs' }));
    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['ship'] }))).join('\n');
    expect(out).toContain('shipped');
  });

  /**
   * **A relative glob means the directory of the file that declared it**, which is what lets a
   * shared config ship commands of its own. Anchored when the config is read (`anchorCommands`),
   * because `commands` appends and `ORIGINS` records one file per key rather than per element -
   * after the merge there is nothing left to attribute an entry by.
   *
   * The negative control is built in: the glob is `./cmds/*.mjs` and there is no `cmds` directory
   * at the repository root, so resolving it against the root - which is what `plugins` does with a
   * relative path - finds nothing and the command never registers.
   */
  it("anchors a shared config's own glob to that config, not to the repository root", async () => {
    const dir = fixture();
    const shared = path.join(dir, 'node_modules', 'shared-cfg');
    fs.mkdirSync(path.join(shared, 'cmds'), { recursive: true });
    fs.writeFileSync(
      path.join(shared, 'package.json'),
      JSON.stringify({ name: 'shared-cfg', version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    fs.writeFileSync(path.join(shared, 'index.js'), `export default { commands: './cmds/*.mjs' };\n`);
    fs.writeFileSync(
      path.join(shared, 'cmds', 'audit.mjs'),
      `export default app => ({ describe: 'would audit', handler: () => console.log('audited ' + app.repository.getPackages().length) });`,
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: 'shared-cfg' }));

    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['audit'] }))).join('\n');
    expect(out).toContain('audited');
  });

  /**
   * **A repository's own command overriding a contributed one registers once, not twice.**
   *
   * The override itself is the intended escape hatch and deliberately not an error - the same
   * precedence a package's own `.rmanrc` has over an `extends` base - and it was already clean:
   * measured, `rman deploy --help` showed the winner's options alone and the loser's flag was
   * rejected. What was wrong was the *listing*: both got registered, so `rman --help` printed
   * `deploy` twice, once with each description, with nothing to say which of the two would run.
   *
   * Both halves are asserted, because keeping only the second would pass while silently changing
   * which command wins: the survivor must be the repository's own, since `loaded` follows
   * `direct` and yargs took the last.
   */
  it("registers one command per name when a repository's own overrides a contributed one", async () => {
    const dir = fixture();
    const shared = path.join(dir, 'node_modules', 'shared-dup');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(
      path.join(shared, 'package.json'),
      JSON.stringify({ name: 'shared-dup', version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    fs.writeFileSync(
      path.join(shared, 'index.js'),
      `export default { commands: [() => ({ command: 'deploy', describe: 'SHARED deploy',
         handler: () => console.log('ran shared') })] };\n`,
    );
    fs.mkdirSync(path.join(dir, '.rman'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.rman', 'deploy.mjs'),
      `export default { command: 'deploy', describe: 'REPO deploy', handler: () => console.log('ran repo') };`,
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: 'shared-dup' }));

    /**
     * **The override note is what pins the deduplication**, and deliberately so: `rman --help` is
     * the visible symptom but unusable from a spec, because yargs answers it with `process.exit`
     * and that kills the mocha process. The note is printed from the same branch that drops the
     * duplicate - `commands.length < localModules.length` - so it cannot be true unless exactly
     * one survived. Without the fix both register, the branch never runs, and this is silent.
     *
     * At `verbose` because an override is a correct thing to do; the default output stays clean,
     * which the second half asserts.
     */
    const verbose = (await captureLogs(() => runCli({ cwd: dir, argv: ['deploy', '--log-level', 'verbose'] }))).join(
      '\n',
    );
    expect(verbose).toContain('"deploy" from .rmanrc "commands" is overridden by');
    expect(verbose).toContain('deploy.mjs');
    /** The loser came from a config key, not a file, and the note says so - it read
     *  `from "commands"` while `file` held the literal string `'"commands"'`. */
    expect(verbose).not.toContain('""');

    const out = (await captureLogs(() => runCli({ cwd: dir, argv: ['deploy'] }))).join('\n');
    expect(out).toContain('ran repo');
    expect(out).not.toContain('ran shared');
    /** Silent at the default level - the note is a diagnostic, not a warning. */
    expect(out).not.toContain('overridden by');
  });
});

/**
 * **`ArgsOf` types a `<required>` positional as present, and this is the half that makes that
 * honest.** The type is a claim about argv, and only yargs can keep it - so the claim and the
 * parsing are pinned together, in one place, rather than the type asserting something no test ever
 * exercises. `run <script>` and `import <path>` are the only two commands that declare one.
 *
 * Before this, both handlers stated it themselves (`args.script as string`, `args.path!`) because
 * `CommandMetadata.handler` took `yargs.Arguments`, whose index signature makes every required key
 * unassignable - so `ArgsOf` had to mark everything optional. The `as` is gone from both; if it
 * comes back, this suite is where to look first.
 */

/**
 * **A command that prints nothing is indistinguishable from one that never ran.** `rman lint` on a
 * clean repository is exactly that - eslint says nothing when it has nothing to say - and the
 * reader is left asking whether the command took. One line when it starts and one when it ends
 * answers it for every command at once, which is why it is an interception point in `cli.ts` rather
 * than a line each command remembers to write.
 */
describe('cli: status lines around a command', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-status-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { run: { build: { exec: 'echo hi' } } } }));
    fs.mkdirSync(path.join(dir, 'packages/a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/a/package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.0' }));
    return dir;
  }

  it('writes a result line naming the command and how long it took', async () => {
    const dir = fixture();
    const err = await captureStderr(() => runCli({ cwd: dir, argv: ['build'] }).catch(() => {}));

    expect(err).toContain('build');
    /** **One line here, not two.** While the command runs the status is a *live* line - a spinner
     *  and a ticking clock, redrawn in place - and a redraw needs a TTY. Under a test runner stderr
     *  is a pipe, so `StatusRegion` draws nothing and only the result survives, which is the half
     *  that carries information into a CI log. The live half is covered in `status-region.spec.ts`,
     *  where the region is built with `enabled` forced on. */
    expect(err.split('\n').filter(l => l.includes('build'))).toHaveLength(1);
    /** The result line carries a duration - `4.1s` / `950ms` / `2m 03s`. */
    expect(err).toMatch(/\d+(\.\d+)?(ms|s)/);
  });

  /**
   * **`--json` is checked rather than declared**, because any command may grow one and a consumer
   * doing `rman version --json | jq` must never receive prose. The control for this is the case
   * above: the same command, without the flag, writes both lines.
   */
  it('says nothing under --json, whichever command produced it', async () => {
    const dir = fixture();
    const err = await captureStderr(() => runCli({ cwd: dir, argv: ['version', '--json'] }).catch(() => {}));
    expect(err).not.toContain('version');
  });

  /** What `silent` is for. */
  it('says nothing under --log-level silent', async () => {
    const dir = fixture();
    const err = await captureStderr(() =>
      runCli({ cwd: dir, argv: ['build', '--log-level', 'silent'] }).catch(() => {}),
    );
    expect(err).toBe('');
  });

  /**
   * **A command whose stdout *is* its answer gets nothing printed around it.** `rman config` writes
   * a loadable YAML document; a line above it is what makes the document unparseable - the same
   * failure its own colour handling already avoids for a pipe.
   *
   * This is the case that caught the field not being carried: `printsDocument` was declared on the
   * command and dropped by `toYargsCommand`, so `cli.ts` never saw it and `config` printed a status
   * line above its own YAML. Reverting that one line in `command-builder.ts` turns this red.
   */
  it('says nothing around a command that prints a document', async () => {
    const dir = fixture();
    const err = await captureStderr(() => runCli({ cwd: dir, argv: ['config'] }).catch(() => {}));
    expect(err).toBe('');
  });

  /** **A failing command still gets its bracket closed.** A start line with nothing after it reads
   *  as a hang, which is the thing this feature exists to prevent. */
  it('writes the result line when the command fails, and still fails', async () => {
    const dir = fixture();
    let threw = false;
    const err = await captureStderr(async () => {
      await runCli({ cwd: dir, argv: ['run', 'nope'] }).catch(() => {
        threw = true;
      });
    });

    expect(threw).toBe(true);
    expect(err.split('\n').filter(l => l.includes('run'))).toHaveLength(1);
  });
});

describe('cli: a required positional', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('is refused by yargs before the handler runs, so the handler never sees it absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-test-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');

    /** yargs' `.fail()` prints to stdout and `runCli` rethrows to stderr - both silenced, so the
     *  assertion reads the rejection rather than the report. */
    const originalError = console.error;
    console.error = () => {};
    try {
      await captureLogs(async () => {
        await expect(runCli({ cwd: dir, argv: ['run'] })).rejects.toThrow(/Not enough non-option arguments/);
      });
    } finally {
      console.error = originalError;
    }
  });

  /**
   * **A type-level check, run by `tsc` over the test tree rather than by mocha.** Each
   * `@ts-expect-error` is its own negative control: revert the narrowing and the error it expects
   * stops happening, so the directive itself becomes the failure.
   */
  describe('ArgsOf', () => {
    const someOptions = {
      json: { target: 'cli', describe: 'x', type: 'boolean', default: false },
      wait: { target: 'cli', describe: 'y', type: 'boolean' },
    } satisfies Record<string, CommandOption>;

    it('makes `<required>` present, and leaves everything else optional', () => {
      type RunArgs = ArgsOf<typeof someOptions, 'run <script>'>;
      type ExecArgs = ArgsOf<typeof someOptions, 'exec [command..]'>;

      /** No `!` and no `??`: `<script>` is a `string`, not a `string | undefined`. */
      const script: string = ({} as RunArgs).script;
      expect(typeof script).toBe('undefined');

      /** `[command..]` is optional, and variadic, which the command string is the only place to say. */
      const command: string[] | undefined = ({} as ExecArgs).command;
      expect(command).toBe(undefined);

      /** A `default:` does **not** make an option present - narrowing on it would need a second
       *  condition (`target !== 'config'`), since `toYargsCommand` never registers a config-only
       *  option and yargs therefore never applies its default. See `ArgsOf`'s own comment. */
      const noDefaults: Pick<RunArgs, 'json' | 'wait'> = {};
      expect(noDefaults).toEqual({});
      /** And the premise of that: `json` really does declare one. */
      expect(someOptions.json.default).toBe(false);

      // @ts-expect-error `<script>` is required by the command string, so it cannot be left out
      const missing: Pick<RunArgs, 'script'> = {};
      expect(missing).toEqual({});
    });
  });
});

/**
 * **Neither question is about a repository**, so neither may need one to work - and a broken
 * repository is the moment you most want to ask them.
 */
describe('cli: --version and --help without a working repository', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repository whose config names a plugin that cannot be resolved - so `Repository.create`
   *  throws, which is what every command hits before yargs ever sees a flag. */
  function brokenRepository(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-broken-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.rmanrc.yml'), "plugins: ['does-not-exist-anywhere']\n");
    return dir;
  }

  it('prints the version, and nothing else, from a repository that cannot be loaded', async () => {
    // The one you reach for when something is wrong - to find out which rman is even installed -
    // and the one a broken `.rmanrc` used to take away, because resolution happens during
    // `Repository.create`, long before yargs sees the flag.
    const cwd = brokenRepository();
    for (const flag of ['-v', '--version']) {
      const lines = await captureLogs(() => runCli({ argv: [flag], cwd }));
      expect([flag, lines]).toEqual([flag, [version]]);
    }
  });

  it('never even looks at the repository for --version', async () => {
    /** No `package.json` anywhere, which fails earlier than a bad plugin does. */
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-empty-'));
    dirs.push(empty);
    expect(await captureLogs(() => runCli({ argv: ['--version'], cwd: empty }))).toEqual([version]);
  });

  it('still answers --help, degraded, instead of failing', async () => {
    const cwd = brokenRepository();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    let lines: string[];
    try {
      lines = await captureLogs(() => runCli({ argv: ['--help'], cwd }));
    } finally {
      console.error = originalError;
    }

    /** The global options are still there, so `--help` is worth having asked for. */
    expect(lines.join('\n')).toMatch(/--version/);
    expect(lines.join('\n')).toMatch(/--help/);
    /** And the reason the rest is missing is stated - on **stderr**, so `rman --help | less` is
     *  still just help. */
    expect(errors.join('\n')).toMatch(/Repository could not be read/);
    expect(errors.join('\n')).toMatch(/does-not-exist-anywhere/);
  });

  it('leaves an ordinary command failing, with its exit code', async () => {
    // The degradation is for those two flags only: a command that needs the repository must still
    // say so and fail, or a broken repository would look like a working one.
    const cwd = brokenRepository();
    const originalError = console.error;
    console.error = () => {};
    try {
      await expect(runCli({ argv: ['list'], cwd })).rejects.toThrow(/does-not-exist-anywhere/);
    } finally {
      console.error = originalError;
    }
  });
});
