import fs from 'node:fs/promises';
import path from 'node:path';
import colors from 'ansi-colors';
import {
  exec,
  filterPackages,
  formatDuration,
  Logger,
  type LogLevel,
  type Package,
  type PackageFilterOptions,
  type ProgressItem,
  ProgressPanel,
  type Repository,
  resolveRootLogLevel,
  type RmanApplication,
} from 'rman';

export namespace CiService {
  export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

  export interface Options extends PackageFilterOptions {
    packageManager?: PackageManager;
    /** Show the live progress panel while running. Default true, same as `run`/`build`; auto-disabled
     *  when stdout isn't a TTY. Doesn't affect what's printed once done - see `run`. */
    progress?: boolean;
    /** Verbosity of the classic per-step log (only applies when the live panel is off). Falls back to
     *  the root's `.rmanrc logLevel`, then 'info' - see `resolveRootLogLevel`. */
    logLevel?: LogLevel;
  }

  /** `.rmanrc packageManager` (root only) picks the package manager used for the final install;
   *  explicit CLI value wins over it. Defaults to 'npm'. */
  export function resolvePackageManager(repository: Repository, cliValue?: PackageManager): PackageManager {
    if (cliValue) return cliValue;
    const configured = repository.config?.packageManager;
    if (configured === undefined) return 'npm';
    if ((PACKAGE_MANAGERS as readonly string[]).includes(configured)) return configured as PackageManager;
    throw new Error(
      `Invalid "packageManager" in .rmanrc: "${configured}" (expected one of: ${PACKAGE_MANAGERS.join(', ')})`,
    );
  }

  /** Deletes `node_modules` and any known lockfile directly under `dirname`. Returns the names
   *  that actually existed (and were removed), so the caller can log only those. */
  export async function wipe(dirname: string): Promise<string[]> {
    const removed: string[] = [];
    for (const name of ['node_modules', ...LOCK_FILES]) {
      const target = path.join(dirname, name);
      const existed = await fs
        .access(target)
        .then(() => true)
        .catch(() => false);
      if (!existed) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }

  /**
   * `ci`: a from-scratch, reproducible install for CI pipelines. For every package (root
   * included), deletes `node_modules` and any lockfile - or, if the package defines its own
   * `"ci"` script, runs that instead. Once every package is clean, installs once at the root
   * with the configured package manager (`npm`/`yarn`/`pnpm`/`bun`).
   *
   * Uses the same live progress panel as `run`/`build` (see `../utils/progress-panel.ts`) while it
   * runs, falling back to a plain rmdir/clean/run/install log line per step when the panel is off.
   *
   * Unlike `run`/`build`, it does *not* end with a per-package success tally: `ci`'s packages don't
   * have independently meaningful outcomes the way a build or test run does - wiping a package is
   * trivial and the one step that can genuinely fail, the install, is a single operation for the
   * whole repository. Counting "N succeeded" across packages would just be noise, so only actual
   * failures get called out (by name, with whatever output they produced), followed by one plain
   * completed/failed line.
   */
  export async function reinstall(repository: Repository, options: Options = {}): Promise<void> {
    const packageManager = resolvePackageManager(repository, options.packageManager);
    const logger = new Logger(options.logLevel ?? resolveRootLogLevel(repository));
    // root is handled separately below - for a non-monorepo, getPackages() would otherwise
    // include it a second time (it doubles as "the" package).
    const packages = filterPackages(
      repository.getPackages().filter(p => p !== repository.rootPackage),
      options,
    );

    const progress = options.progress ?? true;
    const panel = new ProgressPanel('CI', !!process.stdout.isTTY && progress);
    const runStartedAt = Date.now();
    panel.start();

    const items: ProgressItem[] = [];
    let failed = false;
    try {
      const results = await Promise.allSettled(
        packages.map(pkg => {
          const item = panel.addItem(pkg.name);
          items.push(item);
          return ciForPackage(pkg, item, panel.enabled, logger);
        }),
      );
      if (results.some(r => r.status === 'rejected')) failed = true;

      const rootItem = panel.addItem('root');
      items.push(rootItem);
      try {
        await ciForRoot(repository, rootItem, panel.enabled, packageManager, logger);
      } catch {
        failed = true;
      }
    } finally {
      panel.stop();
    }

    for (const item of items) {
      if (item.status !== 'failed') continue;
      logger.error(colors.red.bold('X'), item.name);
      if (item.log.length) logger.error(colors.red(item.log.join('\n')));
    }
    const totalElapsed = formatDuration(Date.now() - runStartedAt);
    const summary = [failed ? colors.red('ci failed') : colors.green('ci completed'), colors.gray(`(${totalElapsed})`)];
    if (failed) logger.error(...summary);
    else logger.info(...summary);

    if (failed) {
      const err: any = new Error('"ci" failed');
      err.logged = true;
      throw err;
    }
  }
}

const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'] as const;

const LOCK_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

/** Runs a shell `command` in `cwd`, driving `item` for the live panel when it's on, or falling
 *  back to the plain "classic" log line `logLine` prints first - the same split `run`'s classic
 *  log uses. `logLine` is expected to go through a `Logger` (so it respects `--log-level`), not a
 *  raw `console.log`. */
async function runStep(
  app: RmanApplication,
  item: ProgressItem,
  panelEnabled: boolean,
  cwd: string,
  command: string,
  logLine: () => void,
): Promise<void> {
  if (panelEnabled) {
    await exec(command, {
      app,
      cwd,
      stdio: 'pipe',
      onLine: line => {
        item.log.push(line);
        item.lastLine = line;
      },
    });
  } else {
    logLine();
    await exec(command, { cwd, app, stdio: 'inherit' });
  }
}

/** Logs (or reflects onto the live panel) the outcome of a `wipe()` call - including the "nothing
 *  to remove" case, which otherwise prints nothing at all in the classic log and can look like the
 *  package was never processed (most workspace layouts hoist deps to the root's `node_modules`,
 *  so an individual package legitimately has nothing of its own to wipe most of the time). */
function logWipeResult(
  item: ProgressItem,
  panelEnabled: boolean,
  logger: Logger,
  label: string,
  removed: string[],
): void {
  if (panelEnabled) {
    item.lastLine = removed.length ? `removed ${removed.join(', ')}` : 'already clean';
    return;
  }
  if (!removed.length) {
    logger.info(colors.gray('clean'), colors.cyan(label));
    return;
  }
  for (const name of removed) logger.info(colors.yellow('rmdir'), colors.cyan(label), name);
}

/** A package can opt out of the default wipe by defining its own `"ci"` npm script - if present,
 *  that runs instead of the wipe, same as any other rman script. */
async function ciForPackage(pkg: Package, item: ProgressItem, panelEnabled: boolean, logger: Logger): Promise<void> {
  item.status = 'running';
  item.startedAt = Date.now();
  try {
    const script = pkg.manifest.raw.scripts?.ci;
    if (typeof script === 'string' && script) {
      item.currentStep = 'ci';
      await runStep(pkg.repository.app, item, panelEnabled, pkg.dirname, script, () =>
        logger.info(colors.cyan('run'), colors.cyan(item.name), script),
      );
    } else {
      item.currentStep = 'wipe';
      const removed = await CiService.wipe(pkg.dirname);
      logWipeResult(item, panelEnabled, logger, item.name, removed);
    }
    item.status = 'success';
  } catch (e) {
    item.status = 'failed';
    throw e;
  } finally {
    item.finishedAt = Date.now();
  }
}

/** The root gets one extra step over a regular package once it isn't opting out with its own
 *  `"ci"` script: after its own wipe, it installs once for the whole repository. */
async function ciForRoot(
  repository: Repository,
  item: ProgressItem,
  panelEnabled: boolean,
  packageManager: CiService.PackageManager,
  logger: Logger,
): Promise<void> {
  item.status = 'running';
  item.startedAt = Date.now();
  try {
    const script = repository.rootPackage.manifest.raw.scripts?.ci;
    if (typeof script === 'string' && script) {
      item.currentStep = 'ci';
      await runStep(repository.app, item, panelEnabled, repository.dirname, script, () =>
        logger.info(colors.cyan('run'), colors.cyan('root'), script),
      );
    } else {
      item.stepsTotal = 2;

      item.stepIndex = 0;
      item.currentStep = 'wipe';
      const removed = await CiService.wipe(repository.dirname);
      logWipeResult(item, panelEnabled, logger, 'root', removed);

      item.stepIndex = 1;
      item.currentStep = 'install';
      await runStep(repository.app, item, panelEnabled, repository.dirname, `${packageManager} install`, () =>
        logger.info(colors.cyan('install'), `Running "${packageManager} install"`),
      );
    }
    item.status = 'success';
  } catch (e) {
    item.status = 'failed';
    throw e;
  } finally {
    item.finishedAt = Date.now();
  }
}
