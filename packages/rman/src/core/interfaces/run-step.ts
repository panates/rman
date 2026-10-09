import type { RunBinOptions, RunBinResult } from '../../utils/run-bin.js';
import type { Logger } from '../classes/logger.js';
import type { Package } from '../classes/package.js';
import type { Repository } from '../classes/repository.js';

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
   * The package the run was narrowed to because rman was started inside it, or `undefined` when it
   * covers the repository - started at the root, or with `--from-root`.
   *
   * What a step asks to tell "the whole repository is building" from "just this package is":
   * `repository.currentPackage` answers where rman was started and cannot see `--from-root`. Set by
   * `run` and the commands built on it (`build`, `test`); `undefined` in a `version` hook, which
   * always covers the repository.
   */
  scopedTo?: Package;
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

/**
 * One step written as an object, which is how a step says something *about itself* - today, whether
 * it has to wait for the package's dependencies.
 *
 * ```yml
 * run:
 *   build:
 *     before:
 *       - { topo: false, command: eslint . }   # nothing to wait for
 *     exec: { topo: true, command: tsc -b }    # cannot start before the dependencies are built
 * ```
 *
 * `command` is the step itself and takes the same two forms the plain value does - a shell command
 * or a function - so the object adds the marker and takes nothing away. An unknown key is refused
 * rather than ignored.
 */
export interface RunStepObject {
  /**
   * What the step runs: a shell command, or a function ([`RunStepFn`](#RunStepFn)), exactly as the
   * plain value form. `${{ }}` in a string is interpolated as usual.
   *
   * One key for both, because `run.<script>.exec` is already one key taking both - a second name
   * for the function case would mean two spellings of one thing and a rule about which to use.
   */
  command?: string | RunStepFn;
  /**
   * Whether this step waits for every package this one depends on to finish. `true` is the useful
   * one - a `tsc -b` cannot start before the packages it compiles against are built, while an
   * `eslint .` beside it has nothing to wait for.
   *
   * **The wait is for a dependency's whole script, so the *first* `true` is where the package
   * actually blocks.** Everything after that has its dependencies behind it already, which makes a
   * later `topo: false` a true statement about the step that changes nothing about when it runs -
   * worth writing as intent, not a lever.
   *
   * **The barrier is the first step marked `true`; with none, the first unmarked step**, which
   * takes `run.<script>.topo` - on by default. A `false` frees its own step only, so a script waits
   * nowhere only when every step says `false`. A package's own script replacing a marked `exec`
   * (an npm `build`) keeps that mark. `run.<script>.topo: false` and `--no-topo` still turn
   * ordering off outright.
   *
   * Only in `run.<script>`: a `version` hook runs for one package around its own version write,
   * with no package graph to join, and the key is refused there rather than quietly doing nothing.
   */
  topo?: boolean;
  /**
   * Whether this one step runs, asked when its turn comes - the same two forms
   * `run.<script>.if` takes: a condition (`changed`, `dirty and not committed`) or a function
   * handed the step's context. A step that says no is passed over, and the ones after it still
   * run.
   *
   * @example
   * // lint the package only when the build was started inside it
   * { if: ({ scopedTo }) => !!scopedTo, command: 'rman lint' }
   */
  if?: string | RunConditionFn;
}

/** One entry of a `before`/`exec`/`after` slot: a shell command, a function, or a
 *  [`RunStepObject`](#RunStepObject) saying something about the step. A list of them runs in
 *  sequence, and the forms mix freely within one list. */
export type RunStepValue = string | RunStepFn | RunStepObject;

/**
 * A `run.<script>.if` written as JavaScript, deciding whether the script runs for this package.
 *
 * The string form is a small closed grammar (`changed and not private`) which cannot express an
 * arbitrary condition, and a `${{ }}` one is frozen at config-load time. This is evaluated per
 * package, when the run reaches it - the same context a step gets.
 */
export type RunConditionFn = (context: RunStepContext) => boolean | Promise<boolean>;
