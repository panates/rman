import { spawn, type SpawnOptions } from 'node:child_process';
import type { RmanApplication } from '../core/application.js';
import { BinPath } from './bin-path.js';
import { trackChild } from './child-tracker.js';

export interface ExecOptions {
  /**
   * The application whose technologies put a repository's locally installed binaries on PATH -
   * `node_modules/.bin` for a Node repository, whatever another technology uses.
   *
   * Passed rather than looked up, so a command run against one repository can never pick up the
   * binaries of another in the same process. Omitted (a caller outside any repository) leaves the
   * inherited PATH exactly as it was, which is also what a repository naming no plugin gets.
   */
  app?: RmanApplication;
  /** 'inherit' streams the child directly to our stdio (used for non-TTY/CI passthrough).
   *  'pipe' (default) captures output so the caller can drive a live view via onLine. */
  stdio?: 'inherit' | 'pipe';
  cwd?: string;
  env?: Record<string, string | undefined>;
  onLine?: (line: string, stdio: 'stderr' | 'stdout') => void;
  /** Reject on a non-zero exit (default `true`). Set false to read `code` instead - for a command
   *  whose failure is an expected answer rather than a problem (`docker buildx create --use` on a
   *  builder that already exists). */
  throwOnError?: boolean;
}

export interface ExecResult {
  code?: number;
  error?: Error;
  stdout?: string;
}

/**
 * Runs `command` **through a shell, as one string** - the right tool for a command line a config
 * author wrote, shell operators and all (`run.<script>`, `version` hooks, `rman exec`).
 *
 * **It takes no argv and the shell is not optional**, deliberately: an `argv`/`shell: false` pair
 * would make this able to do `runBin`'s job badly, and for years nothing passed either. Arguments
 * assembled in code go to `runBin`, which spawns with no shell - so an interpolated value holding a
 * space stays one argument and one holding `;` stays data. Keeping the boundary in the *signature*
 * is what stops a caller from having to know that rule.
 */
export async function exec(command: string, options?: ExecOptions): Promise<ExecResult> {
  const opts = {
    throwOnError: true,
    ...options,
  };
  opts.env = {
    ...BinPath.env({ cwd: opts.cwd, app: opts.app }),
    ...opts.env,
  };
  opts.cwd = opts.cwd || process.cwd();

  const spawnOptions: SpawnOptions = {
    stdio: opts.stdio === 'inherit' ? 'inherit' : 'pipe',
    env: opts.env,
    cwd: opts.cwd,
    shell: true,
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

  const child = spawn(command, [], spawnOptions);
  trackChild(child);
  child.stdout?.on('data', data => processLines(String(data), 'stdout'));
  child.stderr?.on('data', data => processLines(String(data), 'stderr'));

  return new Promise((resolve, reject) => {
    let resolved = false;
    child.on('error', (err: any) => {
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
