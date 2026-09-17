import os from 'node:os';
import colors from 'ansi-colors';
import { Task } from 'power-tasks';
import type { Repository } from '../core/repository.js';
import { exec as execCommand } from '../utils/exec.js';
import { Logger, type LogLevel, resolveRootLogLevel } from '../utils/logger.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { type ProgressItem, ProgressPanel } from '../utils/progress-panel.js';

export namespace ExecService {
  export interface Options extends PackageFilterOptions {
    /** Max packages at once: `true`/omitted = CPU count, a number = that many, `false` = serial (1). */
    parallel?: boolean | number;
    /** Respect the package dependency graph: a package waits for its dependencies and is skipped
     *  if one fails. Default true. Set false to run in every matching package independently,
     *  alphabetically, regardless of the dependency graph. */
    topo?: boolean;
    bail?: boolean;
    changed?: boolean;
    changedSince?: string;
    /** Show the live progress panel. Default true; auto-disabled when stdout isn't a TTY. */
    progress?: boolean;
    /** Verbosity of the classic per-package log (only applies when the live panel is off). Falls
     *  back to the root's `.rmanrc logLevel`, then 'info' - see `resolveRootLogLevel`. */
    logLevel?: LogLevel;
    /** Run across the whole repository even when the current directory is inside a single package
     *  (which otherwise scopes the run to just that package). Has no effect when already at the
     *  repository root, or outside any known package. */
    root?: boolean;
  }

  /**
   * `exec`: runs `command` (an arbitrary shell command, not an npm script) directly in every
   * matching package's own directory - unlike `run`, there's no `package.json` script to resolve
   * and no `pre<script>`/`post<script>` npm lifecycle convention to honor, since the command isn't
   * tied to any script name at all. Everything else about how packages are selected and scheduled
   * matches `run`: topological order and per-package bail by default, the same live progress panel
   * (falling back to a classic one-line-per-package log when it's off), and the same
   * `--scope`/`--ignore`/`--deps`/`--dependents`/`--changed` package filtering.
   */
  export async function exec(repository: Repository, command: string, options: Options = {}): Promise<void> {
    const logLevelDefault = resolveRootLogLevel(repository);
    const logger = new Logger(options.logLevel ?? logLevelDefault);

    const cwdScope = options.root ? undefined : repository.currentPackage;
    const topo = options.topo ?? true;
    let packages = repository.getPackages({ toposort: topo, scope: cwdScope?.name });
    if (!topo) packages = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    packages = filterPackages(packages, options);

    if (options.changed || options.changedSince) {
      const status = await repository.listStatus({ hash: options.changedSince });
      packages = packages.filter(p => status[p.name] !== 'clean');
    }

    if (!packages.length) {
      logger.info(colors.gray('No package matched.'));
      return;
    }

    const concurrency =
      options.parallel === false
        ? 1
        : typeof options.parallel === 'number'
          ? options.parallel
          : options.parallel === true
            ? os.cpus().length
            : os.cpus().length;

    const progress = options.progress ?? true;
    const panel = new ProgressPanel('EXEC', !!process.stdout.isTTY && progress);
    const bail = options.bail ?? true;

    let rootTask: Task | undefined;
    const names = new Set(packages.map(p => p.name));
    const children = packages.map(pkg => {
      const ctx = panel.addItem(pkg.name);
      const dependencies = topo ? pkg.dependencies.filter(d => names.has(d.name)).map(d => d.name) : [];
      return new Task(
        () =>
          execForPackage(ctx, panel.enabled, pkg.dirname, command, logger, bail ? () => rootTask?.abort() : () => {}),
        { name: pkg.name, dependencies },
      );
    });

    panel.start();
    let failed = false;
    try {
      /** bail:false here - each item's own task decides whether to call `rootTask.abort()`
       *  itself (see `execForPackage`), mirroring `run`'s own reasoning: power-tasks' own `bail`
       *  is a single blanket policy, it can't be conditional on `options.bail`. `toPromise()`
       *  still rejects on any child's failure regardless, whether or not it triggered an abort. */
      rootTask = new Task(children, { concurrency, bail: false });
      await rootTask.toPromise();
    } catch {
      failed = true;
    } finally {
      panel.stop();
    }

    panel.printSummary();

    if (failed) {
      const err: any = new Error('"exec" failed');
      err.logged = true;
      throw err;
    }
  }
}

async function execForPackage(
  ctx: ProgressItem,
  panelEnabled: boolean,
  cwd: string,
  command: string,
  logger: Logger,
  abort: () => void,
): Promise<void> {
  ctx.status = 'running';
  ctx.startedAt = Date.now();
  try {
    if (panelEnabled) {
      await execCommand(command, {
        cwd,
        stdio: 'pipe',
        onLine: line => {
          ctx.log.push(line);
          ctx.lastLine = line;
        },
      });
    } else {
      logger.info(colors.cyan('exec'), colors.cyan(ctx.name), command);
      const t = Date.now();
      try {
        await execCommand(command, { cwd, stdio: 'inherit' });
        logger.info(colors.green('success'), colors.cyan(ctx.name), colors.yellow(`(${Date.now() - t} ms)`));
      } catch (e) {
        logger.error(colors.red('failed'), colors.cyan(ctx.name), colors.yellow(`(${Date.now() - t} ms)`));
        throw e;
      }
    }
    ctx.status = 'success';
  } catch (e) {
    ctx.status = 'failed';
    abort();
    throw e;
  } finally {
    ctx.finishedAt = Date.now();
  }
}
