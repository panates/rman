import { ChildProcess, spawn, type SpawnOptions } from 'child_process';
import { onExit } from 'signal-exit';
import { npmRunPathEnv } from './npm-run-path.js';

export interface ExecOptions {
  /** 'inherit' streams the child directly to our stdio (used for non-TTY/CI passthrough).
   *  'pipe' (default) captures output so the caller can drive a live view via onLine. */
  stdio?: 'inherit' | 'pipe';
  cwd?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  shell?: boolean;
  onLine?: (line: string, stdio: 'stderr' | 'stdout') => void;
  throwOnError?: boolean;
}

export interface ExecResult {
  code?: number;
  error?: Error;
  stdout?: string;
}

export async function exec(command: string, options?: ExecOptions): Promise<ExecResult> {
  const opts = {
    shell: true,
    throwOnError: true,
    ...options,
  };
  opts.env = {
    ...npmRunPathEnv({ cwd: opts.cwd }),
    ...opts.env,
  };
  opts.cwd = opts.cwd || process.cwd();

  const spawnOptions: SpawnOptions = {
    stdio: opts.stdio === 'inherit' ? 'inherit' : 'pipe',
    env: opts.env,
    cwd: opts.cwd,
    shell: opts.shell,
    windowsHide: true,
  };

  const result: ExecResult = { code: undefined, stdout: '' };

  /** Separate buffers per stream - stdout/stderr chunks must never be spliced into the same line. */
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const processLines = (data: string, stdio: 'stderr' | 'stdout', flush?: boolean) => {
    result.stdout += data;
    if (!opts.onLine) return;
    let buf = (stdio === 'stdout' ? stdoutBuffer : stderrBuffer) + data;
    /** Only synthesize a trailing newline if there's real unterminated content left - an
     *  already-empty buffer must not produce a spurious blank line on every flush. */
    if (flush && buf.length && !buf.endsWith('\n')) buf += '\n';
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      opts.onLine(line, stdio);
    }
    if (stdio === 'stdout') stdoutBuffer = buf;
    else stderrBuffer = buf;
  };

  const child = spawn(command, opts.argv || [], spawnOptions);
  if (child.pid) runningChildren.set(child.pid, child);
  child.stdout?.on('data', data => processLines(String(data), 'stdout'));
  child.stderr?.on('data', data => processLines(String(data), 'stderr'));

  return new Promise((resolve, reject) => {
    let resolved = false;
    child.on('error', (err: any) => {
      if (child.pid) runningChildren.delete(child.pid);
      processLines('', 'stdout', true);
      processLines('', 'stderr', true);
      if (resolved) return;
      resolved = true;
      result.code = err.code || 1;
      result.error =
        typeof err === 'string'
          ? new Error(err)
          : err instanceof Error
            ? err
            : new Error(`Command failed (${result.code})`);
      if (opts.throwOnError) return reject(result.error);
      resolve(result);
    });
    child.on('close', (code?: number) => {
      if (child.pid) runningChildren.delete(child.pid);
      processLines('', 'stdout', true);
      processLines('', 'stderr', true);
      if (resolved) return;
      resolved = true;
      result.code = code;
      if (code) result.error = new Error(`Command failed (${code})`);
      if (result.error && opts.throwOnError) return reject(result.error);
      resolve(result);
    });
  });
}

const runningChildren = new Map<number, ChildProcess>();

onExit(() => {
  runningChildren.forEach(child => child.kill());
});
