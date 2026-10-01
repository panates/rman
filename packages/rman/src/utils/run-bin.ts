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
  /**
   * Called once per line of the child's output **instead of writing it to the terminal**.
   */
  /* **This is what makes a function step behave like a shell one.** `RunService` gives `exec` an
   * `onLine` so a shell step's output lands in the progress panel's item log and shows as that
   * row's last line; `runBin` had no equivalent, so a function step calling it streamed its child
   * straight to the screen through the live region. Measured on a failing build: a shell step
   * showed `✔ check 554ms` on its row while a function step's `tsc` filled the terminal with every
   * error it had, pushing the panel down the screen. Same panel, two contracts. */
  onLine?: (line: string) => void;
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
  /**
   * **A live status region forces `pipe`, whatever the log level would have chosen.** The region
   * draws a block at the bottom of the terminal and redraws it in place; a child writing straight
   * to the terminal scrolls the screen, and the next redraw's "move up N rows" then erases what the
   * child just printed. So the child is piped and every line goes through `passThrough`, which
   * erases the block, writes, and redraws below it - the same arrangement `RunService` makes for the
   * progress panel, for the same reason.
   *
   * An explicit `options.stdio` still wins: a caller that has thought about it outranks this.
   */
  const region = options.app?.statusRegion?.live ? options.app.statusRegion : undefined;
  /** Below 'info' the output is captured rather than streamed, so a quiet run stays quiet and a
   *  failing one can still say what went wrong. */
  /** **`onLine` forces `pipe` the same way a live region does.** Left to the default, a caller at
   *  `info` would get `inherit` - the child writes straight to the terminal, `child.stdout` is
   *  null, and the callback is never called at all. An option that silently does nothing is worse
   *  than one that does not exist. */
  const stdio = options.stdio ?? (options.onLine || region ? 'pipe' : atLeast('info') ? 'inherit' : 'pipe');
  if (atLeast('verbose')) console.log(colors.magenta('verbose'), colors.gray('$'), bin, argv.join(' '));
  const child = spawn(process.platform === 'win32' ? `${bin}.cmd` : bin, argv, {
    cwd,
    stdio: stdio === 'inherit' ? 'inherit' : 'pipe',
    /** **`FORCE_COLOR` when a region made us pipe.** A child checks `isTTY` to decide whether to
     *  colour, and a pipe is not one - so routing eslint's output through the region would
     *  otherwise strip the colour it had when it inherited the terminal. Set only for that case:
     *  a caller that asked for `pipe` itself is usually capturing text to read, not to show. */
    /* **It is added *onto* a base environment, never written as one.** `BinPath.env`'s `env` is the
     * environment to derive from - it replaces `process.env` rather than extending it - so
     * `{ FORCE_COLOR: '1' }` handed over alone left the child with that one variable plus a PATH
     * holding only `node_modules/.bin`. Measured on `panates/sqb` at 2.3.0: `rman test` found npm
     * (the walk ends at the running node's own directory) and npm then died with
     * `spawn sh ENOENT`, because `/bin` was not on the PATH it was given. Every `runBin` call made
     * while a status region is live had it, which since 2.3.0 is every one of them. */
    env: BinPath.env({
      cwd,
      env: region && atLeast('info') ? { FORCE_COLOR: '1', ...(options.env ?? process.env) } : options.env,
      app: options.app,
    }) as NodeJS.ProcessEnv,
    windowsHide: true,
  });
  /** So an interrupted rman does not leave this running - `exec` always did this and this did not,
   *  which meant a plugin command's child outlived a Ctrl-C. See `trackChild`. */
  trackChild(child);

  let output = '';
  /** **Streamed through the region as it arrives, not held to the end.** Piping is how the region
   *  stays intact; buffering would additionally make a long command look silent, which is the very
   *  thing the region exists to fix. Only when a region is live - otherwise `pipe` keeps meaning
   *  "capture, and surface it if this fails". */
  const collect = (d: Buffer) => {
    const text = d.toString();
    output += text;
    /** A caller taking the lines owns them - it is showing them somewhere of its own, and writing
     *  them here as well would both double them and scroll whatever it is drawing. */
    if (options.onLine) {
      for (const line of text.split(/\r?\n/)) if (line) options.onLine(line);
      return;
    }
    if (region && atLeast('info')) region.passThrough(text);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

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
      /** Already streamed through the region, so printing it again would double it. */
      if (stdio === 'pipe' && output && logLevel !== 'silent' && !options.onLine && !(region && atLeast('info'))) {
        process.stderr.write(output);
      }
      const err: any = new Error(`"${bin} ${argv.join(' ')}" exited with code ${code}`);
      err.code = code;
      err.output = output;
      reject(err);
    });
  });
}
