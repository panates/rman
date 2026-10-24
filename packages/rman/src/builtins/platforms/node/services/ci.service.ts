import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import colors from 'ansi-colors';
import type { RmanApplication } from '../../../../core/application.js';
import type { LogLevel } from '../../../../core/classes/logger.js';
import { Logger, resolveRootLogLevel } from '../../../../core/classes/logger.js';
import type { Package } from '../../../../core/classes/package.js';
import type { ProgressItem } from '../../../../core/classes/progress-panel.js';
import { formatDuration, ProgressPanel } from '../../../../core/classes/progress-panel.js';
import type { Repository } from '../../../../core/classes/repository.js';
import { exec } from '../../../../utils/exec.js';
import type { PackageFilterOptions } from '../../../../utils/package-filter.js';
import { filterPackages } from '../../../../utils/package-filter.js';
import { runBin } from '../../../../utils/run-bin.js';

export namespace CiService {
  /**
   * The package managers this plugin knows how to drive, and the `choices` both `ci --package-manager`
   * and the `npm` publish target's own flag offer.
   *
   * Exported rather than module-private, which it was: the publish target needs the same list, and
   * a second copy of it is the kind of drift that shows up as a flag accepting a value nothing can
   * act on. One list, one place it is written down.
   */
  export const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'] as const;

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

  /**
   * The package manager `pkg` uses: `cliValue` when given, else its `.rmanrc "packageManager.node"`,
   * else the one its lockfile belongs to (`detectPackageManager`), else `npm`. Pass the repository
   * for the one the repository installs with.
   */
  /* **The bare string is refused rather than read.** `packageManager: pnpm` was the old spelling,
   * and rman validates no config keys, so read as an object it would simply have no `node` entry -
   * a pnpm repository installing with npm, saying nothing. No repository of this organization
   * wrote it, so a clear refusal costs nobody anything. */
  export function resolvePackageManager(pkg: Package, cliValue?: PackageManager): PackageManager {
    if (cliValue) return cliValue;
    const configured: unknown = pkg.config?.packageManager;
    if (typeof configured === 'string') {
      throw new Error(
        `.rmanrc "packageManager" takes one entry per technology - write packageManager: { node: ${configured} } ` +
          `instead of packageManager: ${configured}.`,
      );
    }
    const node = (configured as { node?: unknown } | undefined)?.node;
    if (node === undefined) return detectPackageManager(pkg) ?? 'npm';
    if (typeof node === 'string' && (PACKAGE_MANAGERS as readonly string[]).includes(node))
      return node as PackageManager;
    throw new Error(
      `Invalid "packageManager.node" in .rmanrc: "${String(node)}" (expected one of: ${PACKAGE_MANAGERS.join(', ')})`,
    );
  }

  /**
   * The package manager whose lockfile sits nearest `pkg` - its own directory, then each one above
   * it up to the repository root - or `undefined` when there is none. Throws when the nearest
   * directory holding a lockfile holds two package managers' lockfiles, naming them.
   */
  /* **The lockfile, not `package.json#packageManager`.** The lockfile is what the last install
   * actually wrote; the field is a declaration nothing checks, and it goes stale. Measured on this
   * repository: its root `package.json` says `yarn@3.4.1` and it has only ever installed with npm
   * (`package-lock.json`, no `yarn.lock`) - read first, the field would have sent `rman ci` to yarn.
   *
   * **Two managers in one directory is refused, not ranked.** Any order picks a tool on the
   * repository's behalf, and the wrong pick is silent: `ci` wipes every lockfile before it installs,
   * so the one it guessed against is gone and the next run sees only what it wrote. The fix is one
   * line of config, and the message says which.
   *
   * **Nearest, not root-only**: a package installing on its own keeps its lockfile beside its own
   * `package.json`, and the walk stops at the repository root so a checkout nested inside another
   * project never answers with the outer one's tool. */
  export function detectPackageManager(pkg: Package): PackageManager | undefined {
    if (!pkg.dirname) return undefined;
    for (const dir of lockfileDirs(pkg)) {
      const found = Object.keys(LOCKFILE_MANAGERS).filter(name => existsSync(path.join(dir, name)));
      if (!found.length) continue;
      const managers = [...new Set(found.map(name => LOCKFILE_MANAGERS[name]))];
      if (managers.length === 1) return managers[0];
      throw new Error(
        `Cannot tell which package manager ${dir} uses: it holds lockfiles of ${managers.join(' and ')} ` +
          `(${found.join(', ')}). Delete the stale one, or say which in .rmanrc: ` +
          `packageManager: { node: ${managers.join(' | ')} }.`,
      );
    }
    return undefined;
  }

  /** What `rman install` hands on, in rman's own words - `installArgv` spells each one for the
   *  package manager that runs. */
  export interface InstallOptions {
    packageManager?: PackageManager;
    /** Install exactly what the lockfile says, failing rather than changing it. */
    frozenLockfile?: boolean;
    /** Production dependencies only - no `devDependencies`. */
    prod?: boolean;
    ignoreScripts?: boolean;
    /** Bring the lockfile up to date with the manifests, installing nothing. */
    lockfileOnly?: boolean;
    offline?: boolean;
    preferOffline?: boolean;
    /** Report what an install would change, writing nothing. */
    dryRun?: boolean;
    registry?: string;
    /** Handed on last, as written - whatever a package manager has and these do not say. */
    extra?: string[];
    logLevel?: LogLevel;
  }

  /**
   * `rman install`: one install at the repository root, with the repository's own package manager
   * (`resolvePackageManager`) - nothing is deleted first, which is what sets it apart from
   * `reinstall`.
   */
  export async function install(repository: Repository, options: InstallOptions = {}): Promise<void> {
    const manager = resolvePackageManager(repository, options.packageManager);
    await runBin(manager, installArgv(manager, options), {
      cwd: repository.dirname,
      app: repository.app,
      logLevel: options.logLevel ?? resolveRootLogLevel(repository),
    });
  }

  /**
   * The argv `manager` is run with for `options`. Throws, before anything runs, for an option
   * `manager` has no spelling of, naming it and the way round it.
   */
  /* **One table, read flag by flag** (`INSTALL_FLAGS`, below), each spelling taken from that tool's
   * own `install --help`: npm 11.12.1, pnpm 12.10.1, bun 1.4.2, yarn 3.4.1. A spelling nobody
   * checked is left out rather than guessed - a flag that means something else, or nothing, to the
   * tool that receives it is the silent version of this refusal.
   *
   * **`--frozen-lockfile` is `npm ci` under npm**, and that is the one place this command deletes
   * anything: npm has no frozen install that keeps `node_modules`, and `ci` is npm's own answer to
   * "exactly the lockfile". Refusing it would leave the one flag a CI script needs most unable to be
   * written without knowing the tool, which is the whole point of the command.
   *
   * **yarn takes `--frozen-lockfile` and nothing else here.** Berry's `install` has no production,
   * offline, dry-run or registry flag at all, and spells the rest as `--mode` values that cannot be
   * combined; classic spells them differently again. Both accept `--frozen-lockfile` - berry as an
   * alias of `--immutable`. */
  export function installArgv(manager: PackageManager, options: InstallOptions): string[] {
    if (options.frozenLockfile && options.lockfileOnly) {
      throw new Error(
        '--frozen-lockfile and --lockfile-only contradict each other: one refuses to change the lockfile, the other only changes it.',
      );
    }
    const argv = manager === 'npm' && options.frozenLockfile ? ['ci'] : ['install'];
    for (const flag of INSTALL_FLAGS) {
      const value = options[flag.option];
      if (value === undefined || value === false || value === '') continue;
      const spelled = flag.spellings[manager];
      if (spelled === undefined) {
        throw new Error(
          `${manager} install has no equivalent of --${flag.cliName}. Pass ${manager}'s own flag after --, ` +
            `e.g. rman install -- <flag>.`,
        );
      }
      if (!spelled) continue;
      argv.push(typeof value === 'string' ? `${spelled}=${value}` : spelled);
    }
    argv.push(...(options.extra ?? []));
    return argv;
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
   * Uses the same live progress panel as `run`/`build` (see `core/classes/progress-panel.ts`) while it
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
    panel.detail = repository.name;
    panel.start(repository.app.statusRegion);

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

const LOCK_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

/** Each `rman install` option, as each package manager spells it: `''` when the subcommand already
 *  says it (`npm ci`), missing when that tool has none. See `installArgv`. */
const INSTALL_FLAGS: {
  option:
    'frozenLockfile' | 'prod' | 'ignoreScripts' | 'lockfileOnly' | 'offline' | 'preferOffline' | 'dryRun' | 'registry';
  cliName: string;
  spellings: Partial<Record<CiService.PackageManager, string>>;
}[] = [
  {
    option: 'frozenLockfile',
    cliName: 'frozen-lockfile',
    spellings: { npm: '', pnpm: '--frozen-lockfile', bun: '--frozen-lockfile', yarn: '--frozen-lockfile' },
  },
  { option: 'prod', cliName: 'prod', spellings: { npm: '--omit=dev', pnpm: '--prod', bun: '--production' } },
  {
    option: 'ignoreScripts',
    cliName: 'ignore-scripts',
    spellings: { npm: '--ignore-scripts', pnpm: '--ignore-scripts', bun: '--ignore-scripts' },
  },
  {
    option: 'lockfileOnly',
    cliName: 'lockfile-only',
    spellings: { npm: '--package-lock-only', pnpm: '--lockfile-only', bun: '--lockfile-only' },
  },
  { option: 'offline', cliName: 'offline', spellings: { npm: '--offline', pnpm: '--offline', bun: '--offline' } },
  {
    option: 'preferOffline',
    cliName: 'prefer-offline',
    spellings: { npm: '--prefer-offline', pnpm: '--prefer-offline', bun: '--prefer-offline' },
  },
  { option: 'dryRun', cliName: 'dry-run', spellings: { npm: '--dry-run', pnpm: '--dry-run', bun: '--dry-run' } },
  { option: 'registry', cliName: 'registry', spellings: { npm: '--registry', pnpm: '--registry', bun: '--registry' } },
];

/** Which package manager each lockfile belongs to, for `detectPackageManager`. */
/* `npm-shrinkwrap.json` is here and not in `LOCK_FILES`: it says npm as surely as a
 * `package-lock.json` does, but it is published with the package, so `ci` has no business deleting
 * it. */
const LOCKFILE_MANAGERS: Record<string, CiService.PackageManager> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};

/** `pkg`'s own directory, then each one above it, ending at the repository root - only `pkg`'s own
 *  when it has no repository or does not sit inside it. */
function lockfileDirs(pkg: Package): string[] {
  const root = pkg.repository?.dirname;
  const dirs = [pkg.dirname];
  if (!root || path.relative(root, pkg.dirname).startsWith('..')) return dirs;
  let dir = pkg.dirname;
  while (dir !== root) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dirs.push((dir = parent));
  }
  return dirs;
}

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
  /** **Set here rather than at each of the three call sites**, which is also what keeps `wipe` out
   *  of it: a wipe runs no command, and this is the one place a `ci` step has one. */
  item.currentCommand = command;
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
