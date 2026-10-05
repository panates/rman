import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { LogSink } from '../../src/core/classes/log-sink.js';

describe('utils/log-sink', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-log-sink-test-'));
    dirs.push(dir);
    return dir;
  }

  /** What reached stdout while `fn` ran. */
  function captureStdout(fn: () => void): string {
    const original = process.stdout.write.bind(process.stdout);
    let out = '';
    (process.stdout as NodeJS.WriteStream).write = ((chunk: any) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      (process.stdout as NodeJS.WriteStream).write = original;
    }
    return out;
  }

  it('writes the text form to the file: the package in brackets, then what happened', () => {
    const dir = tmp();
    const sink = new LogSink({ file: 'run.log', cwd: dir });
    sink.report({ event: 'start', package: 'pkg-a', step: 'build', command: 'tsc -b' });
    sink.report({ event: 'output', package: 'pkg-a', stream: 'stdout', line: 'compiled' });
    sink.report({ event: 'end', package: 'pkg-a', step: 'build', status: 'failed', ms: 12, error: 'one\ntwo' });
    sink.report({ event: 'summary', succeeded: 1, failed: 1, skipped: 2, ms: 40 });
    sink.close();

    const lines = fs
      .readFileSync(path.join(dir, 'run.log'), 'utf-8')
      .trimEnd()
      .split('\n')
      .map(l => l.replace(/^\S+ /, ''));
    expect(lines).toEqual([
      '[pkg-a] ▶ build | tsc -b',
      '[pkg-a] compiled',
      '[pkg-a] ✖ build failed (12 ms)',
      '[pkg-a] one',
      '[pkg-a] two',
      '1 succeeded, 1 failed, 2 skipped (40 ms)',
    ]);
  });

  it('under json writes each event to stdout and to the file as the same JSON line', () => {
    const dir = tmp();
    const sink = new LogSink({ json: true, file: 'run.jsonl', cwd: dir });
    const out = captureStdout(() => {
      sink.report({ event: 'output', package: 'pkg-a', stream: 'stderr', line: 'warned' });
      sink.close();
    });

    expect(fs.readFileSync(path.join(dir, 'run.jsonl'), 'utf-8')).toBe(out);
    const event = JSON.parse(out);
    expect(event).toMatchObject({ event: 'output', package: 'pkg-a', stream: 'stderr', line: 'warned' });
    expect(Number.isNaN(Date.parse(event.time))).toBe(false);
  });

  /** A child piped with `FORCE_COLOR` carries colour, and nothing reading a log file or a JSON string
   *  is a terminal. */
  it('strips escape sequences from every string it writes', () => {
    const dir = tmp();
    const sink = new LogSink({ json: true, file: 'run.jsonl', cwd: dir });
    captureStdout(() => {
      sink.report({ event: 'output', package: '\x1b[1mpkg-a\x1b[22m', stream: 'stdout', line: '\x1b[32mok\x1b[39m' });
      sink.close();
    });
    const event = JSON.parse(fs.readFileSync(path.join(dir, 'run.jsonl'), 'utf-8'));
    expect(event.package).toBe('pkg-a');
    expect(event.line).toBe('ok');
  });

  /** Opened on the first event, so a command that logs nothing leaves no empty file - and `used`
   *  stays false, which is what the CLI's warning reads. */
  it('creates no file and stays unused until something is written', () => {
    const dir = tmp();
    const sink = new LogSink({ file: 'logs/run.log', cwd: dir });
    sink.close();
    expect(sink.used).toBe(false);
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(false);
  });

  it('creates the directory, resolves against cwd, and replaces what a previous run left', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'run.log'), 'from an earlier run\n');
    const sink = new LogSink({ file: 'logs/run.log', cwd: dir });
    expect(sink.filePath).toBe(path.join(dir, 'logs', 'run.log'));
    sink.report({ event: 'message', level: 'info', message: 'fresh' });
    sink.close();
    expect(fs.readFileSync(path.join(dir, 'logs', 'run.log'), 'utf-8')).not.toContain('earlier');
  });

  it('is inert when neither json nor a file was asked for', () => {
    const sink = new LogSink({});
    const out = captureStdout(() => sink.report({ event: 'message', level: 'info', message: 'x' }));
    expect(sink.active).toBe(false);
    expect(sink.used).toBe(false);
    expect(out).toBe('');
  });
});
