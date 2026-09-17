import type { Logger } from '../utils/logger.js';
import type { RunBinOptions, RunBinResult } from '../utils/run-bin.js';
import type { Package } from './package.js';
import type { Repository } from './repository.js';

/**
 * What a **function step** is handed - a `run.<script>.before`/`.exec`/`.after` or a
 * `version.<slot>` written as JavaScript instead of a shell command, and the `if` deciding whether
 * a script runs at all.
 *
 * An object rather than loose parameters, for the reason `CommandContext` is one: a member added
 * later must not break every step already written against it.
 *
 * **The whole point of the function form is *when* it runs.** A `${{ }}` expression is evaluated
 * while the repository's config resolves - which every command does, `rman list` included - so it
 * can only ever answer questions about the state the config was loaded in, and anything it *did*
 * would happen on every invocation. A function step runs when its turn comes, with the real
 * objects, in the package's own directory. Reach for it exactly when that difference matters;
 * a shell command is still the right shape for a shell command.
 */
export interface RunStepContext {
  /**
   * The package this step is running for - `pkg`, matching `${{ pkg }}` in an expression rather
   * than `CommandContext.package`. `package` is a reserved word, so that spelling forces every
   * author to rename it while destructuring (`{ package: current }`), which is friction paid at
   * every call site for no benefit.
   *
   * Always set, unlike `CommandContext.package`: a step belongs to a package by construction, and
   * the repo-wide bookend belongs to the root package.
   */
  pkg: Package;
  repository: Repository;
  /**
   * The directory this step is *about* - the package's own, or the repository root for a monorepo's
   * bookend. The same directory a shell step in this slot is spawned in.
   *
   * **`process.cwd()` is NOT changed, and cannot be.** A shell step gets a real working directory
   * because it is a child process; a function step runs inside rman's own, and `run` executes
   * packages **concurrently** - one step calling `process.chdir()` would move the ground under
   * every other step running at that moment. So a relative path resolves against wherever rman was
   * invoked, which is almost never what the step meant:
   *
   * ```js
   * fs.writeFileSync('out.txt', data)                  // the repository root. Measured, and wrong.
   * fs.writeFileSync(path.join(ctx.cwd, 'out.txt'), data)   // the package
   * ```
   *
   * `ctx.runBin` is already bound to this directory, so a binary run through it needs no such care.
   */
  cwd: string;
  /**
   * The repository's locally installed binaries, already carrying this run's `cwd` and log level -
   * handed over rather than imported, for the reason `CommandContext.runBin` is.
   */
  runBin: (bin: string, argv: string[], options?: RunBinOptions) => Promise<RunBinResult>;
  /** Logger at this run's resolved level. **Prefer it to `console`**: with the live progress panel
   *  on, a direct write lands beside the panel rather than in the step's own log. */
  logger: Logger;
}

/**
 * A step written as JavaScript. **Failure is a throw** - the return value means nothing, exactly as
 * a non-zero exit is what fails a shell step and what `runBin` rejects on. A step that can report
 * trouble only by returning something nobody reads is a step that passes while doing nothing.
 */
export type RunStepFn = (context: RunStepContext) => void | Promise<void>;

/** One entry of a `before`/`exec`/`after` slot: a shell command, or a function. A list of them runs
 *  in sequence, and the two forms mix freely within one list. */
export type RunStepValue = string | RunStepFn;

/**
 * A `run.<script>.if` written as JavaScript, deciding whether the script runs for this package.
 *
 * The string form is a small closed grammar (`changed and not private`) which cannot express an
 * arbitrary condition, and a `${{ }}` one is frozen at config-load time. This is evaluated per
 * package, when the run reaches it - the same context a step gets.
 */
export type RunConditionFn = (context: RunStepContext) => boolean | Promise<boolean>;
