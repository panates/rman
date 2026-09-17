import os from 'node:os';
import colors from 'ansi-colors';
import { tokenize } from 'fast-tokenizer';
import { Task } from 'power-tasks';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { exec } from '../utils/exec.js';
import { LOG_LEVELS, type LogLevel, resolveRootLogLevel } from '../utils/logger.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { type ProgressItem, ProgressPanel } from '../utils/progress-panel.js';

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
    root?: boolean;
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
  /** One command of a script, with the label the progress panel and the per-step log show. */
  export interface ScriptStep {
    name: string;
    command: string;
  }

  /** The three slots a script is made of, each one command or several run in sequence. The same
   *  three names a `.rmanrc "run.<script>"` block uses, because they are the same three things. */
  export interface ScriptSlots {
    before?: string[];
    exec?: string[];
    after?: string[];
  }

  /**
   * Where a package's steps can come from besides its `.rmanrc`.
   *
   * The core knows one source: the config. **`package.json#scripts` is not a source the core has**,
   * because "a script lives in package.json" is true of a Node repository and of nothing else -
   * `@rman/node` contributes that one (with npm's `pre<script>`/`post<script>` convention and its
   * `&&` splitting), and a plugin for another ecosystem would contribute its own.
   *
   * Returns `undefined` for "this package declares nothing", not empty slots - the difference
   * decides whether the config's value applies.
   */
  export type StepSource = (pkg: Package, script: string) => ScriptSlots | undefined;

  /**
   * Registers a source. Called by `loadPlugins` for each plugin's `runSteps`, in `plugins`
   * declaration order - never as an import side effect, so what is registered is exactly what the
   * repository's `.rmanrc` asked for.
   */
  export function addStepSource(source: StepSource): void {
    /** Idempotent per source: a plugin both declares `runSteps` (registered by `loadPlugins`) and
     *  may call its own `augmentRun()` for programmatic callers, so the same function arrives
     *  twice. Pushing twice is harmless - the first match wins - but it makes the registry lie
     *  about what is in it. */
    if (stepSources.includes(source)) return;
    stepSources.push(source);
  }

  /** For tests, which would otherwise leak a source into every later case in the process. */
  export function clearStepSources(): void {
    stepSources.length = 0;
  }

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
    return firstContributed(pkg, script);
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
   * `fallback` is the caller's own configured command, **already evaluated**: `version`'s three
   * paths are in `DEFERRED_PATHS` precisely because only the caller can bind
   * `${{ pkg.targetVersion }}`, so interpolating here would either be too early or need a scope this
   * service has no business holding.
   */
  export async function runLifecycleSlot(
    pkg: Package,
    script: string,
    slot: keyof ScriptSlots,
    fallback?: string,
  ): Promise<void> {
    const own = contributedSlots(pkg, script)?.[slot] ?? [];
    const commands = own.length ? own : fallback ? [fallback] : [];
    for (const command of commands) await exec(command, { cwd: pkg.dirname, stdio: 'inherit' });
  }

  export function getConfig(pkg: Package, script: string): Record<string, unknown> {
    const runCfg = pkg.config?.run;
    const cfg = runCfg && typeof runCfg === 'object' ? (runCfg as Record<string, unknown>)[script] : undefined;
    if (typeof cfg === 'string' || Array.isArray(cfg)) return { exec: cfg };
    return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
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

  export async function runScript(
    repository: Repository,
    script: string,
    options: Options & { commandName?: string } = {},
  ): Promise<void> {
    const commandName = options.commandName || 'run';
    const rootCfg = getConfig(repository.rootPackage, script);
    const logLevelDefault = resolveRootLogLevel(repository);

    /** Standing inside a single package's own directory scopes the run to just that package
     *  (and drops the root bookend below) unless `--root` asks for the whole repository anyway -
     *  a no-op when already at the root, or outside any known package. */
    const cwdScope = options.root ? undefined : repository.currentPackage;

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
            await exec(step.command, {
              cwd,
              stdio: 'pipe',
              onLine: (line, stdio) => {
                ctx.log.push(line);
                ctx.lastLine = line;
                void stdio;
              },
            });
          } else {
            /** Match the classic rman output: raw command output streams straight through
             *  (unbuffered, unprefixed), followed by our own one-line-per-step summary. */
            printLegacyExecutingLine(commandName, pkgLabel, step, pkgLogLevel);
            const stepStart = Date.now();
            let stepError: any;
            try {
              await exec(step.command, { cwd, stdio: 'inherit' });
            } catch (e) {
              stepError = e;
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
    const rootIf = !cwdScope && repository.monorepo && parseIfExpr(rootCfg.if);
    const rootIfPasses = rootIf ? await evaluateIf(repository, repository.rootPackage, rootIf, ifStatusCache) : true;
    const rootSkipped = !!cwdScope || !repository.monorepo || rootCfg.skip === true || !rootIfPasses;
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
        new Task(() => runSteps(ctx, 'root', rootPre, repository.dirname, pkgBail, pkgLogLevel), {
          name: ctx.name,
          exclusive: true,
        }),
      );
    }

    const stepsByPackage = new Map<string, RunService.ScriptStep[]>();
    for (const pkg of packages) {
      const pkgCfg = getConfig(pkg, script);
      if (pkgCfg.skip === true) continue;
      const pkgIf = parseIfExpr(pkgCfg.if);
      if (pkgIf && !(await evaluateIf(repository, pkg, pkgIf, ifStatusCache))) continue;
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
        new Task(() => runSteps(ctx, pkg.name, steps, pkg.dirname, pkgBail, pkgLogLevel), {
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
        new Task(() => runSteps(ctx, 'root', rootPost, repository.dirname, pkgBail, pkgLogLevel), {
          name: ctx.name,
          exclusive: true,
          /** Must wait for every package task to finish, not just be "exclusive" once it starts. */
          dependencies: [...stepsByPackage.keys()],
        }),
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
    step.command,
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
    step.command,
    colors.yellow(` (${durationMs} ms)`),
  );
}

/** A `run.<script>.before`/`.exec`/`.after` value: one command, or several to run in sequence. */
function normalizeScriptValue(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
  return [];
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
 * 2. a **contributed** source - `package.json#scripts` via `@rman/node`. It wins over the config
 *    because it is the *package's own* declaration, while a config value typically arrives
 *    cascaded from the root or an `extends` base; the more specific statement wins, as everywhere
 *    else in rman.
 * 3. the config's own `before`/`exec`/`after`, letting a package run a script it never declared.
 * 4. nothing - and an empty result is what tells `runScript` this package defines no such script.
 */
function getScriptSteps(pkg: Package, script: string): RunService.ScriptStep[] {
  const cfg = RunService.getConfig(pkg, script);
  const override = cfg.override === true;
  const contributed = firstContributed(pkg, script);

  const fromConfig: RunService.ScriptSlots = {
    before: normalizeScriptValue(cfg.before),
    exec: normalizeScriptValue(cfg.exec),
    after: normalizeScriptValue(cfg.after),
  };

  const steps: RunService.ScriptStep[] = [];
  for (const slot of SCRIPT_SLOTS) {
    const own = contributed?.[slot] ?? [];
    const configured = fromConfig[slot] ?? [];
    const commands = override ? (configured.length ? configured : own) : own.length ? own : configured;
    for (const command of commands) steps.push({ name: slot, command });
  }
  return steps;
}

/** The first source that says this package declares the script at all. Declaration order, so a
 *  repository listing two plugins gets a predictable answer rather than a merged one. */
function firstContributed(pkg: Package, script: string): RunService.ScriptSlots | undefined {
  for (const source of stepSources) {
    const slots = source(pkg, script);
    if (slots && (slots.before?.length || slots.exec?.length || slots.after?.length)) return slots;
  }
  return undefined;
}

/** In execution order - `before`, the script itself, then `after`. */
const SCRIPT_SLOTS = ['before', 'exec', 'after'] as const;

const stepSources: RunService.StepSource[] = [];

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
