import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runBin } from '../../src/utils/run-bin.js';
import { StatusRegion } from '../../src/utils/status-region.js';
import { createApp, useLocalBin } from '../_fixture.js';

describe('utils/run-bin', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * `runBin` finds a binary by PATH, and what goes on PATH is `BinPath`'s - which in the core has no
   * provider at all. So the spec brings one, pointing at a directory called `local-bin`:
   * deliberately **not** `node_modules/.bin`, because that is npm's layout and this file is testing
   * rman's core. `rman-node`'s own directories are its spec's business.
   */
  useLocalBin();

  /** `runBin` takes the application whose technologies put `local-bin` on PATH - there is no
   *  registry to read one out of any more. */
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  /** A repository holding one fake binary where this ecosystem keeps them. */
  function fixture(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-run-bin-test-'));
    dirs.push(dir);
    const bin = path.join(dir, 'local-bin');
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'fake-tool');
    fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
    return dir;
  }

  it("resolves the binary from whatever directory BinPath's provider offers", async () => {
    const dir = fixture('#!/bin/sh\necho hello from fake-tool\n');
    const result = await runBin('fake-tool', [], { cwd: dir, stdio: 'pipe', app });
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe('hello from fake-tool');
  });

  it('passes argv as separate arguments, so a value containing spaces stays one argument', async () => {
    // The whole reason this exists next to `exec`: through a shell, "two words" becomes two
    // arguments unless every interpolated value is quoted by hand - and one that isn't is not a
    // typo, it is an injection.
    const dir = fixture('#!/bin/sh\necho "count=$#"\nfor a in "$@"; do echo "arg=[$a]"; done\n');
    const result = await runBin('fake-tool', ['--name', 'two words', 'a;echo b'], { cwd: dir, stdio: 'pipe', app });
    expect(result.output.trim().split('\n')).toEqual(['count=3', 'arg=[--name]', 'arg=[two words]', 'arg=[a;echo b]']);
  });

  it('rejects on a non-zero exit, naming the command and the code', async () => {
    const dir = fixture('#!/bin/sh\nexit 3\n');
    await expect(runBin('fake-tool', ['--check'], { cwd: dir, stdio: 'pipe', app })).rejects.toThrow(
      '"fake-tool --check" exited with code 3',
    );
  });

  it('carries the exit code and captured output on the error', async () => {
    // A caller that wants to treat some code specially (eslint's 1 vs 2) needs it, and the output
    // is gone with the process otherwise.
    const dir = fixture('#!/bin/sh\necho "what went wrong"\nexit 2\n');
    const error: any = await runBin('fake-tool', [], { cwd: dir, stdio: 'pipe', logLevel: 'silent', app }).catch(
      e => e,
    );
    expect(error.code).toBe(2);
    expect(error.output.trim()).toBe('what went wrong');
  });

  it('asks the useful question when the binary is not installed', async () => {
    const dir = fixture('#!/bin/sh\n');
    await expect(runBin('not-installed-at-all', [], { cwd: dir })).rejects.toThrow(
      /"not-installed-at-all" was not found - is it installed in this repository\?/,
    );
  });

  it('captures instead of streaming below "info", which is what a quiet run means', async () => {
    const dir = fixture('#!/bin/sh\necho noise\n');
    const result = await runBin('fake-tool', [], { cwd: dir, logLevel: 'error', app });
    expect(result.output.trim()).toBe('noise');
  });

  /**
   * **A live status region adds `FORCE_COLOR` to the environment; it must not become the
   * environment.** `BinPath.env`'s `env` option is the base to derive from, so handing it
   * `{ FORCE_COLOR: '1' }` alone dropped `process.env` entirely - the child got that one variable
   * and a PATH holding nothing but the contributed directories.
   *
   * The two assertions are the two halves of what that cost, and the nested `sh` is the failure as
   * it was actually reported: on `panates/sqb` at 2.3.0 `rman test` reached npm (the node walk ends
   * at the running interpreter's own directory, where npm sits) and npm died with
   * `spawn sh ENOENT`, because `/bin` was not on the PATH it was handed.
   */
  it('adds FORCE_COLOR onto the inherited environment when a region is live, rather than replacing it', async () => {
    const dir = fixture(
      '#!/bin/sh\necho "marker=$RMAN_SPEC_MARKER"\necho "color=$FORCE_COLOR"\nsh -c \'echo nested\'\n',
    );
    /** Enabled but never started - `live` is the drawing flag, and a running spinner would write
     *  frames over mocha's own report. */
    app.statusRegion = new StatusRegion('spec', '', true);

    process.env.RMAN_SPEC_MARKER = 'inherited';
    let result;
    try {
      /** The region's `passThrough` writes to stderr, so it is silenced for the duration rather
       *  than spliced into the reporter's output. */
      const original = process.stderr.write.bind(process.stderr);
      (process.stderr as NodeJS.WriteStream).write = (() => true) as typeof process.stderr.write;
      try {
        result = await runBin('fake-tool', [], { cwd: dir, app });
      } finally {
        (process.stderr as NodeJS.WriteStream).write = original;
      }
    } finally {
      delete process.env.RMAN_SPEC_MARKER;
    }

    expect(result.output).toContain('marker=inherited');
    expect(result.output).toContain('color=1');
    /** The PATH is still a usable one: a child of the child resolves `sh`, which is what npm does
     *  for every script it runs. */
    expect(result.output).toContain('nested');
  });

  /**
   * **`onLine` is what makes a function step behave like a shell one.** `RunService` gives `exec` an
   * `onLine` so a shell step's output lands in the progress panel's item log and shows as that
   * row's last line; `runBin` had no equivalent, so a function step calling it streamed its child
   * straight to the screen through the live region. Measured on a failing build: a shell step showed
   * one line on its row while a function step's compiler filled the terminal with every error it
   * had, pushing the panel down the screen.
   */
  describe('onLine', () => {
    it('hands each line to the caller instead of writing it anywhere', async () => {
      const lines: string[] = [];
      const written = captureStderr(async () => {
        await runBin('node', ['-e', "for(let i=0;i<3;i++)console.log('OUT '+i)"], { onLine: l => lines.push(l) });
      });

      expect(await written).not.toContain('OUT 0');
      expect(lines).toEqual(['OUT 0', 'OUT 1', 'OUT 2']);
    });

    /** The caller is showing the lines somewhere of its own; writing them here too would both
     *  double them and scroll whatever it is drawing. */
    it('does not reprint the captured output when the child fails', async () => {
      const lines: string[] = [];
      const written = captureStderr(async () => {
        await expect(
          runBin('node', ['-e', "console.log('BOOM');process.exit(3)"], { onLine: l => lines.push(l) }),
        ).rejects.toThrow();
      });

      /** Awaited first: `captureStderr` only resolves once the child has closed, and asserting on
       *  `lines` before that reads it half-filled. */
      expect(await written).not.toContain('BOOM');
      expect(lines).toEqual(['BOOM']);
    });

    it('still carries the output on the error, so a caller that wants it can have it', async () => {
      await expect(
        runBin('node', ['-e', "console.log('BOOM');process.exit(3)"], { onLine: () => {} }),
      ).rejects.toMatchObject({
        output: expect.stringContaining('BOOM'),
      });
    });

    /**
     * **A line arriving in two pieces is still one line.** A `data` event ends wherever the pipe's
     * buffer did, not at a newline, and each chunk used to be split on its own - so a line written in
     * two parts came out as two lines. Harmless while the only reader was a panel row showing the
     * last line; wrong once a run prints every line, where it put a newline in the middle of the
     * child's output. The child writes half a line, waits, then the rest - two `data` events.
     */
    it('joins a line written in two pieces, and passes on one with no newline at the end', async () => {
      const lines: string[] = [];
      await runBin(
        'node',
        ['-e', "process.stdout.write('first-');setTimeout(()=>{process.stdout.write('half\\nno newline')},50)"],
        { onLine: l => lines.push(l) },
      );
      expect(lines).toEqual(['first-half', 'no newline']);
    });

    /** The stream comes with each line, so a caller printing them can keep stdout and stderr apart -
     *  which is what `run` does with no panel. */
    it('says which stream each line came from', async () => {
      const lines: string[] = [];
      await runBin('node', ['-e', "console.log('to out');console.error('to err')"], {
        onLine: (l, stream) => lines.push(`${stream}:${l}`),
      });
      expect(lines.sort()).toEqual(['stderr:to err', 'stdout:to out']);
    });
  });
});

/** What reached stderr while `fn` ran - `runBin` writes a failing child's captured output there,
 *  and these cases are about it *not* doing so. */
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
