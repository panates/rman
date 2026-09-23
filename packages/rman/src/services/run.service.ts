import os from 'node:os';
import { inspect } from 'node:util';
import colors from 'ansi-colors';
import { tokenize } from 'fast-tokenizer';
import { Task } from 'power-tasks';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import type { RunConditionFn, RunStepContext, RunStepFn, RunStepValue } from '../core/run-step.js';
import { Service } from '../core/service.js';
import { exec } from '../utils/exec.js';
import { LOG_LEVELS, Logger, type LogLevel, resolveRootLogLevel } from '../utils/logger.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { type ProgressItem, ProgressPanel } from '../utils/progress-panel.js';
import { runBin } from '../utils/run-bin.js';

/**
 * A service class - see `ListService` for the shape and `Service` for the three measured
 * consequences a namespace had.
 *
 * **Only `runScript` became a method**, because only it takes a repository. `getConfig`,
 * `parseIfExpr`, `normalizeScriptValue` and the rest take a `Package` or a raw value and stay
 * functions on the namespace below - the same rule that leaves `ChangeHashService` a namespace
 * entirely. Declared before the namespace, which TypeScript requires for the merge.
 */
export class RunService extends Service {
  async runScript(script: string, options: RunService.Options & { commandName?: string } = {}): Promise<void> {
    const repository = this.repository;
    const commandName = options.commandName || 'run';
    const rootCfg = RunService.getConfig(repository.rootPackage, script);
    const logLevelDefault = resolveRootLogLevel(repository);

    /** Standing inside a single package's own directory scopes the run to just that package
     *  (and drops the root bookend below) unless `--from-root` asks for the whole repository anyway -
     *  a no-op when already at the root, or outside any known package. */
    const cwdScope = options.fromRoot ? undefined : repository.currentPackage;

    /** Global fallback for topo - individual packages can still override their own linking below,
     *  but the initial sort (topological vs alphabetical) has to be decided for the whole list at once. */
    const topo = resolveBool(options.topo, repository.rootPackage, script, 'topo', true);
    let packages = repository.getPackages({ toposort: topo, scope: cwdScope?.name });
    if (!topo) packages = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    packages = filterPackages(packages, options);

    const changed = resolveBool(options.changed, repository.rootPackage, script, 'changed', false);
    const changedSince =
      options.changedSince ?? (typeof rootCfg.changedSince === 'string' ? rootCfg.changedSince : undefined);
    if (changed || changedSince) {
      const status = await repository.listStatus({ hash: changedSince });
      packages = packages.filter(p => status[p.name] !== 'clean');
    }

    const concurrency =
      options.parallel === false
        ? 1
        : typeof options.parallel === 'number'
          ? options.parallel
          : options.parallel === true
            ? os.cpus().length
            : resolveNumber(undefined, repository.rootPackage, script, 'concurrency', os.cpus().length);

    const progress = resolveBool(options.progress, repository.rootPackage, script, 'progress', true);
    const panel = new ProgressPanel(`RUN ${script}`, !!process.stdout.isTTY && progress);

    /** Set once the aggregate Task exists, so a package's own failure can trigger a manual
     *  abort using *its own* resolved bail setting (see `runSteps` below) - power-tasks' own
     *  `bail` is a single blanket policy for the whole batch, it can't vary per package. */
    let rootTask: Task | undefined;

    const runSteps = async (
      ctx: ProgressItem,
      pkg: Package,
      pkgLabel: string,
      steps: RunService.ScriptStep[],
      cwd: string,
      pkgBail: boolean,
      pkgLogLevel: LogLevel,
    ) => {
      ctx.status = 'running';
      ctx.startedAt = Date.now();
      try {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          ctx.currentStep = step.name;
          ctx.stepIndex = i;
          if (panel.enabled) {
            const onLine = (line: string) => {
              ctx.log.push(line);
              ctx.lastLine = line;
            };
            if (step.run) await runFunctionStep(step.run, pkg, cwd, onLine);
            else await exec(step.command, { cwd, stdio: 'pipe', onLine, app: pkg.repository.app });
          } else {
            /** Match the classic rman output: raw command output streams straight through
             *  (unbuffered, unprefixed), followed by our own one-line-per-step summary. */
            printLegacyExecutingLine(commandName, pkgLabel, step, pkgLogLevel);
            const stepStart = Date.now();
            let stepError: Error | undefined;
            try {
              /** No capture with the panel off: the step owns the terminal, exactly as a shell
               *  step's `stdio: 'inherit'` does. */
              if (step.run) await runFunctionStep(step.run, pkg, cwd);
              else await exec(step.command, { cwd, stdio: 'inherit', app: pkg.repository.app });
            } catch (e) {
              /**
               * **Normalized to an `Error`, because a *falsy* throw was indistinguishable from no
               * failure at all.** This was `let stepError: any` with `if (stepError) throw
               * stepError` below, so a step doing `throw undefined` - legal JavaScript, and what a
               * rejected promise carrying nothing gives you - left `stepError` falsy: the step
               * line printed **success**, nothing was rethrown, and the run exited 0. Found by the
               * spec written for the message-reporting fix above, which is the only reason it is
               * not still there. A step that fails while reporting success is the one outcome this
               * slot exists to rule out.
               *
               * Only the panel-off path had it: with the panel on there is no local catch, and the
               * outer one runs whatever was thrown.
               */
              stepError = e instanceof Error ? e : new Error(messageOf(e));
            }
            printLegacyStepLine(commandName, pkgLabel, step, Date.now() - stepStart, pkgLogLevel, stepError);
            if (stepError) throw stepError;
          }
        }
        ctx.status = 'success';
      } catch (e) {
        ctx.status = 'failed';
        if (pkgBail) rootTask?.abort();
        throw e;
      } finally {
        ctx.finishedAt = Date.now();
      }
    };

    const children: Task[] = [];
    /** Shared across all `if: changed[ = hash]` evaluations so the same reference is only `git`-queried once. */
    const ifStatusCache = new Map<string, Record<string, Repository.PackageStatus>>();

    /** Repo-wide bookend: root's own pre/post hooks run once each, exclusively, around every package
     *  (unless root itself opts out via `run.<script>.skip`, fails its own `run.<script>.if`, or the
     *  run is scoped to a single package by `cwdScope` - a repo-wide bookend has no place there).
     *
     *  Only in a monorepo. Without one the root *is* the single package, already in the loop below
     *  with the same hooks and the same directory - a bookend would simply run each of them a
     *  second time. */
    /** Short-circuited deliberately: a root already out of the run for a structural reason must not
     *  have its `if` evaluated, now that evaluating one can mean calling the repository's own code. */
    const rootSkipped =
      !!cwdScope ||
      !repository.monorepo ||
      rootCfg.skip === true ||
      !(await passesIf(repository, repository.rootPackage, rootCfg.if, repository.dirname, ifStatusCache));
    const rootSteps = rootSkipped ? [] : getScriptSteps(repository.rootPackage, script);
    /** Filtered on the slot, not on `'pre' + script`: the step labels are `before`/`exec`/`after`
     *  now - the same words the config uses - rather than npm's `pre<script>` naming, which moved
     *  out with the package.json source. */
    const rootPre = rootSteps.filter(s => s.name === 'before');
    const rootPost = rootSteps.filter(s => s.name === 'after');

    const rootPreName = 'root (pre)';
    const rootPostName = 'root (post)';

    if (rootPre.length) {
      const ctx = panel.addItem(rootPreName, rootPre.length);
      const pkgBail = resolveBail(options.bail, repository.rootPackage, script, true);
      const pkgLogLevel = resolveLogLevel(options.logLevel, repository.rootPackage, script, logLevelDefault);
      children.push(
        new Task(
          () => runSteps(ctx, repository.rootPackage, 'root', rootPre, repository.dirname, pkgBail, pkgLogLevel),
          {
            name: ctx.name,
            exclusive: true,
          },
        ),
      );
    }

    const stepsByPackage = new Map<string, RunService.ScriptStep[]>();
    for (const pkg of packages) {
      const pkgCfg = RunService.getConfig(pkg, script);
      if (pkgCfg.skip === true) continue;
      if (!(await passesIf(repository, pkg, pkgCfg.if, pkg.dirname, ifStatusCache))) continue;
      const steps = getScriptSteps(pkg, script);
      if (steps.length) stepsByPackage.set(pkg.name, steps);
    }
    for (const pkg of packages) {
      const steps = stepsByPackage.get(pkg.name);
      if (!steps) continue;
      const ctx = panel.addItem(pkg.name, steps.length);
      const pkgTopo = resolveBool(options.topo, pkg, script, 'topo', topo);
      const pkgBail = resolveBail(options.bail, pkg, script, true);
      const pkgLogLevel = resolveLogLevel(options.logLevel, pkg, script, logLevelDefault);
      /** power-tasks identifies a task by its name string, so the graph is handed over as names -
       *  the references are what rman reasons with, the names are what the scheduler wants. */
      const dependencies = pkgTopo ? pkg.dependencies.filter(d => stepsByPackage.has(d.name)).map(d => d.name) : [];
      if (rootPre.length) dependencies.push(rootPreName);
      children.push(
        new Task(() => runSteps(ctx, pkg, pkg.name, steps, pkg.dirname, pkgBail, pkgLogLevel), {
          name: ctx.name,
          dependencies,
        }),
      );
    }

    if (rootPost.length) {
      const ctx = panel.addItem(rootPostName, rootPost.length);
      const pkgBail = resolveBail(options.bail, repository.rootPackage, script, true);
      const pkgLogLevel = resolveLogLevel(options.logLevel, repository.rootPackage, script, logLevelDefault);
      children.push(
        new Task(
          () => runSteps(ctx, repository.rootPackage, 'root', rootPost, repository.dirname, pkgBail, pkgLogLevel),
          {
            name: ctx.name,
            exclusive: true,
            /** Must wait for every package task to finish, not just be "exclusive" once it starts. */
            dependencies: [...stepsByPackage.keys()],
          },
        ),
      );
    }

    if (!children.length) {
      /**
       * Two different nothings, and only one of them is fine.
       *
       * Nobody in the repository defines this script at all: the name is a mistake - a typo, or a
       * script that used to exist - and `npm run` fails on exactly this. Staying silent is how
       * `rman run qc` sat in a CI pipeline for months reporting success while running nothing, with
       * `qc` defined only on the root (whose own scripts a monorepo never runs, only its
       * `pre`/`post` bookends).
       *
       * Everything was filtered out instead - `--scope`, `--changed`, `run.<script>.skip`, an
       * `if:` that didn't match: zero is the correct answer to what was asked, and asking "build
       * only what changed" when nothing changed must not fail a pipeline.
       */
      /** `getPackages()` and nothing else - in a monorepo that excludes the root, which is the
       *  point: the root contributes only `pre`/`post` bookends, never the script itself, so a
       *  `qc` defined *only* there is exactly the mistake above rather than an excuse for it. (And
       *  had the root contributed a bookend, `children` wouldn't be empty.) In a single-package
       *  repository the root *is* the one package, and is covered. */
      const definedSomewhere = repository.getPackages().some(pkg => getScriptSteps(pkg, script).length > 0);
      if (definedSomewhere) {
        console.log(colors.gray(`Nothing to run - every package was filtered out of "${script}".`));
        return;
      }
      const message = `No package defines a "${script}" script.`;
      console.log(colors.red(message));
      const err: any = new Error(message);
      err.logged = true;
      throw err;
    }

    panel.start();

    try {
      /** bail:false here - each package's own resolved bail setting decides whether to call
       *  `rootTask.abort()` itself (see `runSteps`), since power-tasks' own `bail` can't vary per package. */
      rootTask = new Task(children, { concurrency, bail: false });
      await rootTask.toPromise();
    } catch {
      // Swallowed on purpose: whether the root promise rejected says nothing reliable about the
      // run - see below. The per-package tallies are what decide.
    } finally {
      /** A package's own `bail` aborts the root task, which settles its promise *immediately* while
       *  the packages already in flight keep running. Waiting for every child here is what makes
       *  the summary below describe a finished run rather than a snapshot of one still going -
       *  measured: it printed "0 succeeded, 1 failed, 3 skipped" and then three of those "skipped"
       *  packages went on to succeed. */
      await Promise.allSettled(children.map(child => child.toPromise()));
      panel.stop();
    }

    const summary = panel.printSummary();

    /** The tallies, never `rootTask.toPromise()`'s own outcome: with a sibling still in flight at
     *  the moment one package failed, that promise *resolves*, and this command used to exit 0 on a
     *  run it had just reported as failed - non-deterministically, since it came down to which
     *  packages happened to still be running (measured: `1 0 1 1 0` across five identical runs).
     *  A single failed package must fail the command, every time. */
    if (summary.failedCount > 0) {
      const err: any = new Error(`"${script}" failed`);
      err.logged = true;
      throw err;
    }
  }
}

export namespace RunService {
  export interface Options extends PackageFilterOptions {
    /** Max packages built at once: `true`/omitted = CPU count, a number = that many, `false` = serial (1). */
    parallel?: boolean | number;
    /** Respect the package dependency graph: a package waits for its dependencies and is skipped
     *  if one fails. Default true (right for `build`). Set false for scripts like `lint`/`test`
     *  where packages are independent - order becomes alphabetical and one package's failure
     *  (or its dependency's) never skips another. */
    topo?: boolean;
    bail?: boolean;
    changed?: boolean;
    changedSince?: string;
    /** Show the live progress panel. Default true; auto-disabled when stdout isn't a TTY. */
    progress?: boolean;
    /** Verbosity of the classic per-step log (only applies when the live panel is off). Falls back to
     *  the root's `.rmanrc logLevel`, then 'info' - see `resolveRootLogLevel`. */
    logLevel?: LogLevel;
    /** Run across the whole repository even when the current directory is inside a single package
     *  (which otherwise scopes the run to just that package, and skips the root's own pre/post
     *  bookend - see `Repository.currentPackage`). Has no effect when already at the repository
     *  root, or outside any known package. */
    fromRoot?: boolean;
  }

  /**
   * A package's `.rmanrc` (cascaded) can configure `run.<script>.*` - e.g.
   *   run:
   *     build:
   *       concurrency: 2
   *     lint:
   *       topo: false
   *       bail: false
   * and a package can opt itself out of a script entirely:
   *   run:
   *     build:
   *       skip: true
   * or supply the command(s) to run when its own package.json doesn't define this script (or its
   * pre/post hooks) at all - a single string, or an array to run several in sequence - see
   * `getScriptSteps`:
   *   run:
   *     build:
   *       before: [node ./generate.js, node ./validate.js]
   *       exec: tsc -b
   *       after: node ./copy-assets.js
   *       override: true   # use these even if the package *does* define its own
   *
   * A bare string is shorthand for `exec`, which is by far the common case - a script that is just
   * a command, with nothing to configure about how it runs:
   *   run:
   *     test: mocha          # same as   test: { exec: mocha }
   */
  /**
   * One step of a script - a shell command, or a function ([`RunStepFn`](../core/run-step.ts)).
   *
   * A union rather than one shape with two optional fields, so every consumer is made to say which
   * it is handling: the executor that forgets is the one that silently runs nothing, which is
   * exactly the bug this type replaces (a function in `after` used to be dropped by
   * `normalizeScriptValue` and reported as a step that succeeded).
   */
  export type ScriptStep = CommandStep | FunctionStep;

  interface StepBase {
    /** The slot it came from - `before`/`exec`/`after`, which is what the log line shows. */
    name: string;
    /** What the progress panel and the per-step log print: the command itself, or the function's
     *  own name. */
    label: string;
  }

  export interface CommandStep extends StepBase {
    command: string;
    run?: undefined;
  }

  export interface FunctionStep extends StepBase {
    run: RunStepFn;
    command?: undefined;
  }

  /** The three slots a script is made of, each one step or several run in sequence. The same three
   *  names a `.rmanrc "run.<script>"` block uses, because they are the same three things. */
  export interface ScriptSlots {
    before?: RunStepValue[];
    exec?: RunStepValue[];
    after?: RunStepValue[];
  }

  /**
   * Where a package's steps can come from besides its `.rmanrc`.
   *
   * The core knows one source: the config. **`package.json#scripts` is not a source the core has**,
   * because "a script lives in package.json" is true of a Node repository and of nothing else -
   * the `node` built-in contributes that one (with npm's `pre<script>`/`post<script>` convention and its
   * `&&` splitting), and a plugin for another ecosystem would contribute its own.
   *
   * Returns `undefined` for "this package declares nothing", not empty slots - the difference
   * decides whether the config's value applies.
   */
  export type StepSource = (pkg: Package, script: string) => ScriptSlots | undefined;

  /**
   * What the *package itself* declares for the lifecycle `script`, from the contributed sources
   * alone - no `.rmanrc` involved. `undefined` when it declares nothing.
   *
   * Exported because `run` is not the only lifecycle rman wraps: `version` runs hooks around the
   * version write, and npm spells those `preversion`/`version`/`postversion` in `package.json` -
   * which is the same `pre<script>`/`<script>`/`post<script>` shape a step source already answers.
   * So `VersionService` asks here for `'version'` instead of reading `manifest.raw.scripts` itself,
   * and npm's version lifecycle keeps working with no second seam and no extra line in any plugin.
   * A plugin for another ecosystem gets its own lifecycle hooks the moment it contributes steps.
   */
  export function contributedSlots(pkg: Package, script: string): ScriptSlots | undefined {
    return contributedSlotsFor(pkg, script);
  }

  /**
   * Runs one slot of a lifecycle belonging to some operation other than `run` itself - `version`'s
   * hooks around the version write are the only one so far.
   *
   * **Here rather than in `VersionService`, because the rule it applies is this service's**: the
   * package's own declaration for `script` wins over the caller's `fallback`, slot by slot, exactly
   * as `getScriptSteps` decides it for `run`. Kept in two places that rule would drift, and one of
   * the copies would sit in the file that writes versions - which now runs no command of its own at
   * all.
   *
   * `fallback` is the caller's own configured step(s), **already evaluated**: `version`'s three
   * paths are in `DEFERRED_PATHS` precisely because only the caller can bind
   * `${{ pkg.targetVersion }}`, so interpolating here would either be too early or need a scope this
   * service has no business holding.
   *
   * **A list, not one joined string.** `VersionService` used to `join(' && ')` an array into a
   * single shell line, which a function step cannot be part of - and which quietly changed the
   * semantics of the shell case too, since `cd x && y` in one process is not the same as two.
   */
  export async function runLifecycleSlot(
    pkg: Package,
    script: string,
    slot: keyof ScriptSlots,
    fallback?: RunStepValue[],
  ): Promise<void> {
    const own = contributedSlots(pkg, script)?.[slot] ?? [];
    const values = own.length ? own : (fallback ?? []);
    for (const value of values) {
      if (typeof value === 'function') {
        await value(createStepContext(pkg, pkg.dirname));
        continue;
      }
      await exec(value, { cwd: pkg.dirname, stdio: 'inherit', app: pkg.repository.app });
    }
  }

  export function getConfig(pkg: Package, script: string): Record<string, unknown> {
    const runCfg = pkg.config?.run;
    const cfg = runCfg && typeof runCfg === 'object' ? (runCfg as Record<string, unknown>)[script] : undefined;
    /** The bare-value shorthand. A function is `typeof 'function'`, not `'object'`, so without
     *  naming it here `run: { build: myFn }` fell through to the `{}` below - the long form would
     *  have worked and the short one silently done nothing, an arbitrary difference. */
    if (typeof cfg === 'string' || typeof cfg === 'function' || Array.isArray(cfg)) return { exec: cfg };
    return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
  }

  /**
   * The context a function step or `if` is handed - see [`RunStepContext`](../core/run-step.ts).
   *
   * `runBin` and `logger` are bound to *this run* rather than left to be imported, which is the
   * whole reason they are handed over: an imported `runBin` knows neither the cwd nor the resolved
   * log level.
   */
  /**
   * A `run.<script>.before`/`.exec`/`.after` (or `version.<slot>`) value: one step, or several to
   * run in sequence. A shell command or a function, and a list may mix them.
   *
   * **Anything else throws, naming the path.** It used to `return []`, which meant a value rman did
   * not recognize was dropped with no trace: writing a function here - the obvious guess, and now
   * the supported form - produced `1 succeeded, 0 failed` with the step never run (measured). A
   * configuration mistake has to be loud; silence here reads as success.
   *
   * Exported, and the only implementation: `VersionService` used to carry a second one that behaved
   * differently, which is how `version.<slot>` came to join its array with `' && '`.
   */
  export function normalizeScriptValue(value: unknown, at: string): RunStepValue[] {
    const items = Array.isArray(value) ? value : [value];
    const steps: RunStepValue[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      /** An empty string and an absent value are both "nothing here", which is how a `"[*]"` block
       *  declaring a slot some packages don't use has always behaved. */
      if (item === undefined || item === null || item === '') continue;
      if (typeof item === 'string' || typeof item === 'function') {
        steps.push(item as RunStepValue);
        continue;
      }
      const where = Array.isArray(value) ? `${at}[${i}]` : at;
      throw new Error(
        `"${where}" must be a shell command or a function, but it is ${describeValue(item)}.\n` +
          `  A list of either (or both) runs them in sequence.`,
      );
    }
    return steps;
  }

  export function createStepContext(pkg: Package, cwd: string): RunStepContext {
    const logLevel = resolveRootLogLevel(pkg.repository);
    return {
      pkg,
      repository: pkg.repository,
      cwd,
      runBin: (bin, argv, opts) => runBin(bin, argv, { cwd, logLevel, app: pkg.repository.app, ...opts }),
      logger: new Logger(logLevel),
    };
  }

  /**
   * `.rmanrc` conditional execution, GitHub Actions-`if`-flavored but a small closed grammar
   * instead of a full expression language (less to get wrong, still covers what's asked for) -
   * atoms combined with `and`/`or` (`and` binds tighter, same as most languages) and `(...)`:
   *
   *   run:
   *     build:
   *       if: changed                                    # changed since the last publish
   *     test:
   *       if: changed = a1b2c3d                           # changed since a specific commit
   *       if: changed = {CHANGE_HASH}                     # {NAME} -> process.env.NAME first
   *       if: (changed or dirty) and not committed
   */
  export type IfNode =
    | { kind: 'atom'; name: string; value?: string }
    | { kind: 'not'; node: IfNode }
    | { kind: 'and'; left: IfNode; right: IfNode }
    | { kind: 'or'; left: IfNode; right: IfNode };

  function resolveEnvPlaceholders(value: string): string {
    return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
  }

  /** Recursive-descent parser over `tokenizeIf`'s output: expr := or ; or := and ('or' and)* ;
   *  and := unary ('and' unary)* ; unary := 'not' unary | GROUP | NAME ['=' VALUE] */
  export function parseIfExpr(raw: unknown): IfNode | undefined {
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    const tokens = tokenizeIf(raw);
    if (!tokens.length) return undefined;
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];

    function parseUnary(): IfNode {
      if (peek()?.toLowerCase() === 'not') {
        next();
        return { kind: 'not', node: parseUnary() };
      }
      const tok = next() ?? '';
      /** A token containing whitespace can only be a collapsed `(...)` group - plain
       *  atom/operator tokens never do, since they're themselves split on whitespace. */
      if (/\s/.test(tok)) {
        const inner = parseIfExpr(tok);
        if (!inner) throw new Error(`Empty group in "if" expression: "${raw}"`);
        return inner;
      }
      let value: string | undefined;
      if (peek() === '=') {
        next();
        value = resolveEnvPlaceholders(next() ?? '');
      }
      return { kind: 'atom', name: tok, value };
    }

    function parseAnd(): IfNode {
      let node = parseUnary();
      while (peek()?.toLowerCase() === 'and') {
        next();
        node = { kind: 'and', left: node, right: parseUnary() };
      }
      return node;
    }

    function parseOr(): IfNode {
      let node = parseAnd();
      while (peek()?.toLowerCase() === 'or') {
        next();
        node = { kind: 'or', left: node, right: parseAnd() };
      }
      return node;
    }

    return parseOr();
  }

  /** Evaluates a parsed `if` expression for one package. `statusCache` avoids repeat `git` calls
   *  for the same reference hash across packages/scripts in a single run. */
  export async function evaluateIf(
    repository: Repository,
    pkg: Package,
    node: IfNode,
    statusCache: Map<string, Record<string, Repository.PackageStatus>>,
  ): Promise<boolean> {
    if (node.kind === 'and') {
      if (!(await evaluateIf(repository, pkg, node.left, statusCache))) return false;
      return evaluateIf(repository, pkg, node.right, statusCache);
    }
    if (node.kind === 'or') {
      if (await evaluateIf(repository, pkg, node.left, statusCache)) return true;
      return evaluateIf(repository, pkg, node.right, statusCache);
    }
    if (node.kind === 'not') {
      return !(await evaluateIf(repository, pkg, node.node, statusCache));
    }
    return evaluateIfAtom(repository, pkg, node.name, node.value, statusCache);
  }
}

/**
 * Classic one-line-per-step log ("info build pkg ┆ step success ┆ command  (123 ms)"),
 * matching rman's original npmlog-based output. Used when the live panel is off.
 *
 * Respects `logLevel`: 'verbose' also prints an "executing" line before the step runs
 * (rman's old behavior, hidden by default); 'error' suppresses success lines; 'silent'
 * suppresses everything but a real failure.
 */
function printLegacyExecutingLine(commandName: string, pkgLabel: string, step: RunService.ScriptStep, level: LogLevel) {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf('verbose')) return;
  const sep = colors.gray('┆');
  console.log(
    colors.magenta('verbose'),
    commandName,
    colors.cyan(pkgLabel),
    sep,
    colors.cyanBright.bold(step.name),
    colors.cyanBright.bold('executing'),
    sep,
    step.label,
  );
}

function printLegacyStepLine(
  commandName: string,
  pkgLabel: string,
  step: RunService.ScriptStep,
  durationMs: number,
  level: LogLevel,
  error?: Error,
) {
  if (!error && LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf('info')) return;
  if (error && level === 'silent') return;
  const sep = colors.gray('┆');
  const levelLabel = error ? colors.red('error') : colors.green('info');
  const status = error ? colors.red.bold('failed') : colors.green.bold('success');
  console.log(
    levelLabel,
    commandName,
    colors.cyan(pkgLabel),
    sep,
    colors.cyanBright.bold(step.name),
    status,
    sep,
    step.label,
    colors.yellow(` (${durationMs} ms)`),
  );
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'a nested array';
  if (value && typeof value === 'object') return 'an object';
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

/** One step, with the label the panel and the per-step log show. A function's own name - so
 *  `function copyDocs()` and `const copyDocs = () => {}` both read as `copyDocs` - falling back to
 *  the slot's own word for one passed inline, which has no name at all. */
function toStep(slot: string, value: RunStepValue): RunService.ScriptStep {
  if (typeof value === 'function') return { name: slot, label: value.name || `${slot} (js)`, run: value };
  return { name: slot, label: value, command: value };
}

/**
 * Runs a function step.
 *
 * **`console` is redirected while it runs, but only when the panel is on** - and that is the same
 * split a shell step already makes. `exec` hands the panel its output through `stdio: 'pipe'` and
 * `onLine`, so a function writing straight to the real stdout would print *over* the panel it is
 * being rendered inside. With the panel off, `exec` uses `stdio: 'inherit'` and the step owns the
 * terminal; a function gets the same, untouched.
 *
 * Restored in a `finally`, because a step that throws must not leave the rest of the run writing
 * into a log nobody reads.
 *
 * **Its failure message is reported here, because nothing else does it.** A shell step's reason
 * reaches the user on its own - the output streams through `onLine` or straight to the terminal,
 * and `exec` names the command and its exit code. A function step has neither: it fails by
 * throwing, and the throw goes to the outer `catch` that marks the package failed and rethrows an
 * error the CLI treats as already-logged. Measured on a real config whose build step threw a
 * carefully worded message about a missing `tsconfig.json`: the run printed
 * `error build pkg-forgot ┆ exec failed ┆ buildWithTsc` and exited 1, and the message appeared
 * nowhere at all - so the one thing that said what to do was the one thing dropped.
 *
 * Written where a shell step's output goes, so it needs no second channel: through `onLine` with
 * the panel on (the step's own log, which is what the panel shows for a failed item), and to
 * stderr with it off, ahead of the `failed` line - the order a shell step already produces.
 */
async function runFunctionStep(
  run: RunStepFn,
  pkg: Package,
  cwd: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const context = RunService.createStepContext(pkg, cwd);
  if (!onLine) {
    try {
      await run(context);
    } catch (e: any) {
      console.error(colors.red(messageOf(e)));
      throw e;
    }
    return;
  }
  const console_ = globalThis.console as unknown as Record<string, (...args: any[]) => void>;
  const original: Record<string, (...args: any[]) => void> = {};
  for (const method of CAPTURED_CONSOLE) {
    original[method] = console_[method];
    console_[method] = (...args: any[]) => {
      /** Split, because one `console.log` may carry several lines and the panel's log is a list of
       *  them - a multi-line entry would render as one unreadable row. */
      for (const line of format(args).split('\n')) onLine(line);
    };
  }
  try {
    await run(context);
  } catch (e: any) {
    /** Through the patched `console` deliberately - `onLine` is still installed at this point, so
     *  the message lands in this step's log rather than over the panel it is drawn inside. */
    for (const line of messageOf(e).split('\n')) onLine(line);
    throw e;
  } finally {
    for (const method of CAPTURED_CONSOLE) console_[method] = original[method];
  }
}

/** What a thrown value has to say for itself. A step may throw anything, and `String(undefined)`
 *  reading as `undefined` in a run log is worse than saying nothing was said. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trim() || `the step threw ${inspect(error)}`;
}

const CAPTURED_CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const;

function format(args: any[]): string {
  return args.map(arg => (typeof arg === 'string' ? arg : inspect(arg))).join(' ');
}

/**
 * Whether a script runs for `pkg` at all - `run.<script>.if`, in either of its two forms.
 *
 * The function form is checked **first**: `parseIfExpr` answers `undefined` for anything that is
 * not a string, which the caller reads as "no condition given", so a function reaching it would be
 * a condition that silently always passed.
 */
async function passesIf(
  repository: Repository,
  pkg: Package,
  raw: unknown,
  cwd: string,
  statusCache: Map<string, Record<string, Repository.PackageStatus>>,
): Promise<boolean> {
  if (typeof raw === 'function') {
    return !!(await (raw as RunConditionFn)(RunService.createStepContext(pkg, cwd)));
  }
  const node = RunService.parseIfExpr(raw);
  return node ? RunService.evaluateIf(repository, pkg, node, statusCache) : true;
}

/**
 * Resolves a package's steps for `script`, from its `.rmanrc` and from whatever sources plugins
 * contributed (`RunService.addStepSource`).
 *
 * **Resolved slot by slot, not script by script**, and that is load-bearing: a package whose
 * `package.json` defines only `build` still gets `before`/`after` from a `"[*]"` config block. A
 * whole-script precedence would silently drop them.
 *
 * Precedence per slot, first match winning:
 *
 * 1. `run.<script>.override: true` -> the config, always. The escape hatch for "ignore what the
 *    package says it does".
 * 2. a **contributed** source - `package.json#scripts` via `rman-node`. It wins over the config
 *    because it is the *package's own* declaration, while a config value typically arrives
 *    cascaded from the root or an `extends` base; the more specific statement wins, as everywhere
 *    else in rman.
 * 3. the config's own `before`/`exec`/`after`, letting a package run a script it never declared.
 * 4. nothing - and an empty result is what tells `runScript` this package defines no such script.
 */
function getScriptSteps(pkg: Package, script: string): RunService.ScriptStep[] {
  const cfg = RunService.getConfig(pkg, script);
  const override = cfg.override === true;
  const contributed = contributedSlotsFor(pkg, script);

  const fromConfig: RunService.ScriptSlots = {
    before: RunService.normalizeScriptValue(cfg.before, `run.${script}.before`),
    exec: RunService.normalizeScriptValue(cfg.exec, `run.${script}.exec`),
    after: RunService.normalizeScriptValue(cfg.after, `run.${script}.after`),
  };

  const steps: RunService.ScriptStep[] = [];
  for (const slot of SCRIPT_SLOTS) {
    const own = contributed?.[slot] ?? [];
    const configured = fromConfig[slot] ?? [];
    const values = override ? (configured.length ? configured : own) : own.length ? own : configured;
    for (const value of values) steps.push(toStep(slot, value));
  }
  return steps;
}

/**
 * What this package's own technology says it declares for `script`.
 *
 * **Its own, not every registered one.** This walked all the contributed sources and took the first
 * that answered, which in a polyglot repository meant npm's `package.json#scripts` reader was handed
 * a Cargo package and asked whether it declared `build` - its first line is
 * `pkg.manifest.raw?.scripts`, so it was reading a manifest another technology produced. The package
 * already knows which technology claimed it; asking anyone else was only ever a way of finding that
 * out again.
 */
function contributedSlotsFor(pkg: Package, script: string): RunService.ScriptSlots | undefined {
  const slots = pkg.plugin.getRunSteps?.(pkg, script);
  return slots && (slots.before?.length || slots.exec?.length || slots.after?.length) ? slots : undefined;
}

/** In execution order - `before`, the script itself, then `after`. */
const SCRIPT_SLOTS = ['before', 'exec', 'after'] as const;

/**
 * Splits on whitespace, but a `(...)` group collapses to a single token holding its inner text
 * (parens stripped, inner whitespace kept) - `evaluate` below re-tokenizes any token that still
 * contains whitespace, which is what makes nested groups "just work" without a separate grammar
 * for parens: `((a or b) and c)` peels off one bracket layer per recursive `tokenizeIf` call.
 */
function tokenizeIf(raw: string): string[] {
  return tokenize(raw, { delimiters: /\s+/, brackets: true, keepBrackets: false }).all();
}

const warnedUnknownIf = new Set<string>();
const warnedEmptyIfValue = new Set<string>();

async function evaluateIfAtom(
  repository: Repository,
  pkg: Package,
  name: string,
  value: string | undefined,
  statusCache: Map<string, Record<string, Repository.PackageStatus>>,
): Promise<boolean> {
  switch (name) {
    case 'changed':
    case 'dirty':
    case 'committed': {
      if (value !== undefined && !value) {
        const warnKey = `${pkg.name}:${name}`;
        if (!warnedEmptyIfValue.has(warnKey)) {
          warnedEmptyIfValue.add(warnKey);
          console.log(
            colors.yellow(`[${pkg.name}] "if: ${name} = ..." resolved to an empty value - treating as not matched.`),
          );
        }
        return false;
      }
      const cacheKey = value || '';
      let statusMap = statusCache.get(cacheKey);
      if (!statusMap) {
        statusMap = await repository.listStatus(value ? { hash: value } : undefined);
        statusCache.set(cacheKey, statusMap);
      }
      const status = statusMap[pkg.name];
      /** With a hash, status only ever resolves to 'changed'/'clean' (see Repository.listStatus) -
       *  the dirty/committed distinction only exists relative to upstream, so those two conditions
       *  naturally never match when a hash is given. */
      if (name === 'changed') return status !== 'clean';
      return status === name;
    }
    default:
      if (!warnedUnknownIf.has(name)) {
        warnedUnknownIf.add(name);
        console.log(colors.yellow(`Unknown "if" condition "${name}" - ignoring, package will still run.`));
      }
      return true;
  }
}

/** Resolution order: explicit CLI flag > the package's resolved `.rmanrc` > `fallback`. */
export function resolveBool(
  cliValue: boolean | undefined,
  pkg: Package,
  script: string,
  key: string,
  fallback: boolean,
): boolean {
  if (cliValue !== undefined) return cliValue;
  const v = RunService.getConfig(pkg, script)[key];
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Bail is the one setting where a package's own `.rmanrc` outranks even an explicit CLI flag:
 * "this package's failure must always stop the batch" is a more specific, intentional statement
 * than a broad `--no-bail` meant for the run as a whole, and shouldn't be silently overridable by it.
 */
export function resolveBail(cliValue: boolean | undefined, pkg: Package, script: string, fallback: boolean): boolean {
  const v = RunService.getConfig(pkg, script).bail;
  if (typeof v === 'boolean') return v;
  return cliValue !== undefined ? cliValue : fallback;
}

export function resolveNumber(
  cliValue: number | undefined,
  pkg: Package,
  script: string,
  key: string,
  fallback: number,
): number {
  if (cliValue !== undefined) return cliValue;
  const v = RunService.getConfig(pkg, script)[key];
  return typeof v === 'number' ? v : fallback;
}

export function resolveLogLevel(
  cliValue: LogLevel | undefined,
  pkg: Package,
  script: string,
  fallback: LogLevel,
): LogLevel {
  if (cliValue !== undefined) return cliValue;
  const v = RunService.getConfig(pkg, script).logLevel;
  return typeof v === 'string' && (LOG_LEVELS as string[]).includes(v) ? (v as LogLevel) : fallback;
}

declare module '../core/service.js' {
  interface ServiceMap {
    run: RunService;
  }
}
