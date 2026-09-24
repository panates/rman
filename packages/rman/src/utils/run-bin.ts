import { spawn } from 'node:child_process';
import colors from 'ansi-colors';
import type { RmanApplication } from '../core/application.js';
import { BinPath } from './bin-path.js';
import { trackChild } from './child-tracker.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

export interface RunBinOptions {
  /**
   * The application whose technologies put a repository's locally installed binaries on PATH -
   * `node_modules/.bin` for a Node repository, whatever another technology uses.
   *
   * Passed rather than looked up, so a command run against one repository can never pick up the
   * binaries of another in the same process. Omitted (a caller outside any repository) leaves the
   * inherited PATH exactly as it was, which is also what a repository naming no plugin gets.
   */
  app?: RmanApplication;
  /** Where to run it, and the directory `node_modules/.bin` is resolved from. Default `process.cwd()`. */
  cwd?: string;
  /** 'inherit' streams the child's output straight to the terminal; 'pipe' captures it and resolves
   *  with it instead - for a binary being asked a question rather than doing work. Defaults to
   *  whatever `logLevel` implies (see below). */
  stdio?: 'inherit' | 'pipe';
  /**
   * Verbosity, defaulting to 'info'. This is what a caller holding the session's resolved level
   * passes in - `CommandContext.runBin` does exactly that, so a repository's own command honors
   * `--log-level` and `.rmanrc logLevel` without reading either itself.
   *
   * - 'verbose' also prints the command before running it.
   * - 'info' streams the child's output through (`stdio: 'inherit'`).
   * - 'error'/'silent' capture it instead, and surface it only if the command fails - 'silent' not
   *   even then. An explicit `stdio` still wins over all of this.
   */
  logLevel?: LogLevel;
  env?: Record<string, string | undefined>;
}

export interface RunBinResult {
  code: number;
  /** Captured stdout+stderr, only with `stdio: 'pipe'`. */
  output: string;
}

/**
 * Runs one of the repository's locally installed binaries, passing **argv as an array** - no shell.
 *
 * Use this over `exec` whenever the arguments aren't a fixed string: `exec` runs through a shell, so
 * an interpolated path containing a space silently becomes two arguments, and a value containing
 * `;` or `&&` becomes another command. Here they cannot - each element of `argv` arrives as exactly
 * one argument. `exec` remains the right tool for a command the config author wrote as a string,
 * shell operators and all (`run.<script>`, `version` hooks).
 *
 * The binary is found by PATH, not spawned by path: `BinPath.env` prepends whatever the repository's
 * plugins say a local install lives in (`node_modules/.bin`
 * from `cwd` up the directory tree, which is what makes `eslint` resolve to the repository's own
 * copy - and on Windows resolve `eslint.cmd`, which spawning a bare path would not.
 *
 * Rejects on a non-zero exit (the error names the command and the code) and on a missing binary,
 * where it asks the useful question instead of reporting `ENOENT`. A non-zero exit has to be an
 * error rather than a returned code: a lint or type-check step that passes in CI having checked
 * nothing is the outcome worth ruling out, and that is what silently discarding a code produces.
 */
export async function runBin(bin: string, argv: string[], options: RunBinOptions = {}): Promise<RunBinResult> {
  const cwd = options.cwd ?? process.cwd();
  const logLevel = options.logLevel ?? 'info';
  const atLeast = (level: LogLevel) => LOG_LEVELS.indexOf(logLevel) >= LOG_LEVELS.indexOf(level);
  /** Below 'info' the output is captured rather than streamed, so a quiet run stays quiet and a
   *  failing one can still say what went wrong. */
  const stdio = options.stdio ?? (atLeast('info') ? 'inherit' : 'pipe');
  if (atLeast('verbose')) console.log(colors.magenta('verbose'), colors.gray('$'), bin, argv.join(' '));
  const child = spawn(process.platform === 'win32' ? `${bin}.cmd` : bin, argv, {
    cwd,
    stdio: stdio === 'inherit' ? 'inherit' : 'pipe',
    env: BinPath.env({ cwd, env: options.env, app: options.app }) as NodeJS.ProcessEnv,
    windowsHide: true,
  });
  /** So an interrupted rman does not leave this running - `exec` always did this and this did not,
   *  which meant a plugin command's child outlived a Ctrl-C. See `trackChild`. */
  trackChild(child);

  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

  return new Promise<RunBinResult>((resolve, reject) => {
    child.on('error', (e: any) => {
      reject(
        e?.code === 'ENOENT' ? new Error(`"${bin}" was not found - is it installed in this repository?`) : (e as Error),
      );
    });
    child.on('close', code => {
      if (code === 0) return resolve({ code: 0, output });
      /** Captured output has to be surfaced here or it is lost with the process - the one thing
       *  worse than a noisy failure is a silent one. 'silent' is the caller saying otherwise. */
      if (stdio === 'pipe' && output && logLevel !== 'silent') process.stderr.write(output);
      const err: any = new Error(`"${bin} ${argv.join(' ')}" exited with code ${code}`);
      err.code = code;
      err.output = output;
      reject(err);
    });
  });
}
