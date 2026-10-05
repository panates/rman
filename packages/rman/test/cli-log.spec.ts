import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useTestEcosystem } from './_fixture.js';

/**
 * The global `--json` and `--log-file`: a run's log as JSON Lines on stdout, and the same log in a
 * file - JSON under `--json`, text otherwise. See `LogSink`.
 */
describe('cli: global --json and --log-file', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A two-package workspace whose `build` prints one line to each stream; `pkg-b` fails when asked. */
  function fixture(options: { failB?: boolean } = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-cli-log-test-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] }),
    );
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ run: { build: { bail: false } } }));
    for (const name of ['pkg-a', 'pkg-b']) {
      const pkgDir = path.join(dir, 'packages', name);
      fs.mkdirSync(pkgDir, { recursive: true });
      const fail = name === 'pkg-b' && options.failB ? ' && exit 3' : '';
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          scripts: { build: `echo out-${name} && echo err-${name} 1>&2${fail}` },
        }),
      );
    }
    return dir;
  }

  /** Both streams, captured whole - `--json` is a promise about everything that reaches stdout, so a
   *  spec about it cannot look only at `console.log`. */
  async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; error?: unknown }> {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const errorOut = console.error;
    let stdout = '';
    let stderr = '';
    (process.stdout as NodeJS.WriteStream).write = ((chunk: any) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    (process.stderr as NodeJS.WriteStream).write = ((chunk: any) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    /** A setup or handler failure is printed through `console.error`, which holds its own reference to
     *  the stream on some Node versions - silenced too, so a failing case does not splice the report. */
    console.error = (...a: unknown[]) => {
      stderr += a.join(' ') + '\n';
    };
    let error: unknown;
    try {
      await fn();
    } catch (e) {
      error = e;
    } finally {
      (process.stdout as NodeJS.WriteStream).write = out;
      (process.stderr as NodeJS.WriteStream).write = err;
      console.error = errorOut;
    }
    return { stdout, stderr, error };
  }

  function parseLines(text: string): any[] {
    return text
      .trimEnd()
      .split('\n')
      .map(l => JSON.parse(l));
  }

  it('--json: stdout is nothing but JSON Lines - a start, each output line and an end per package, then a summary', async () => {
    const dir = fixture();
    const { stdout, error } = await capture(() => runCli({ argv: ['run', 'build', '--json'], cwd: dir }));
    expect(error).toBeUndefined();

    /** `JSON.parse` on every line is the assertion that nothing else got in - a panel frame, a status
     *  line or a prose recap would throw here. */
    const events = parseLines(stdout);
    for (const name of ['pkg-a', 'pkg-b']) {
      const own = events.filter(e => e.package === name);
      /** `step` is the slot the config names (`before`/`exec`/`after`); the script is the command's. */
      expect(own[0]).toMatchObject({
        event: 'start',
        step: 'exec',
        command: `echo out-${name} && echo err-${name} 1>&2`,
      });
      expect(own.at(-1)).toMatchObject({ event: 'end', step: 'exec', status: 'success' });
      expect(own).toContainEqual(expect.objectContaining({ event: 'output', stream: 'stdout', line: `out-${name}` }));
      expect(own).toContainEqual(expect.objectContaining({ event: 'output', stream: 'stderr', line: `err-${name}` }));
    }
    expect(events.at(-1)).toMatchObject({ event: 'summary', succeeded: 2, failed: 0 });
  });

  it('--json: a failed step ends with status "failed" and the summary counts it', async () => {
    const dir = fixture({ failB: true });
    const { stdout, error } = await capture(() => runCli({ argv: ['run', 'build', '--json'], cwd: dir }));
    expect(error).toBeDefined();

    const events = parseLines(stdout);
    expect(events).toContainEqual(expect.objectContaining({ event: 'end', package: 'pkg-b', status: 'failed' }));
    expect(events.at(-1)).toMatchObject({ event: 'summary', succeeded: 1, failed: 1 });
  });

  it('--log-file: the same run as text lines, resolved against where rman was invoked', async () => {
    const dir = fixture();
    await capture(() => runCli({ argv: ['run', 'build', '--no-progress', '--log-file=logs/build.log'], cwd: dir }));

    const lines = fs
      .readFileSync(path.join(dir, 'logs', 'build.log'), 'utf-8')
      .trimEnd()
      .split('\n')
      .map(l => l.replace(/^\S+ /, ''));
    expect(lines).toContain('[pkg-a] out-pkg-a');
    expect(lines).toContain('[pkg-b] err-pkg-b');
    expect(lines.some(l => /^\[pkg-a\] ▶ exec \| echo out-pkg-a/.test(l))).toBe(true);
    expect(lines.some(l => /^\[pkg-a\] ✔ exec success \(\d+ ms\)$/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^2 succeeded, 0 failed \(\d+ ms\)$/);
  });

  it('--json --log-file: the file holds exactly what stdout did', async () => {
    const dir = fixture();
    const { stdout } = await capture(() =>
      runCli({ argv: ['run', 'build', '--json', '--log-file', 'build.jsonl'], cwd: dir }),
    );
    expect(fs.readFileSync(path.join(dir, 'build.jsonl'), 'utf-8')).toBe(stdout);
  });

  /** A command that owns `--json` prints its *result* there - a contract the release workflow reads
   *  with `jq`. The log must not be written beside it, and nothing should warn.
   *
   *  This pins the contract, not `cli.ts`'s `!spec.ownsJson` guard: no command owning `--json`
   *  writes to the log today, so removing the guard leaves this green (measured). It is there for
   *  the first one that does. */
  it('leaves a command that owns --json alone: one document on stdout, no events, no warning', async () => {
    const dir = fixture();
    const { stdout, stderr } = await capture(() => runCli({ argv: ['list', '--json'], cwd: dir }));
    const document = JSON.parse(stdout);
    expect(Array.isArray(document)).toBe(true);
    expect(stdout).not.toContain('"event"');
    expect(stderr).not.toContain('--json:');
  });

  it('warns on stderr when a command does not write a log, and creates no file', async () => {
    const dir = fixture();
    const { stderr } = await capture(() => runCli({ argv: ['info', '--log-file=info.log'], cwd: dir }));
    expect(stderr).toContain('--log-file: "rman info" does not write a log yet');
    expect(fs.existsSync(path.join(dir, 'info.log'))).toBe(false);
  });

  /** `--config` runs nothing by design, so an empty log is the right outcome rather than a flag
   *  nothing honoured. */
  it('does not warn under --config', async () => {
    const dir = fixture();
    const { stderr } = await capture(() =>
      runCli({ argv: ['run', 'build', '--config', '--log-file=x.log'], cwd: dir }),
    );
    expect(stderr).not.toContain('--log-file:');
  });
});
