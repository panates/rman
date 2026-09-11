import fs from 'node:fs';
import path from 'node:path';
import colors from 'ansi-colors';
import fg from 'fast-glob';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { Logger, type LogLevel, resolveRootLogLevel } from '../utils/logger.js';
import { type ProgressItem, ProgressPanel } from '../utils/progress-panel.js';

export namespace CleanService {
  export interface Options {
    /** Show the live progress panel. Default true; auto-disabled when stdout isn't a TTY. */
    progress?: boolean;
    /** Report what would be removed without actually removing anything. Default false. */
    dryRun?: boolean;
    /** Clean the whole repository even when the current directory is inside a single package
     *  (which otherwise scopes cleaning to just that package - see `Repository.currentPackage`).
     *  Has no effect when already at the repository root, or outside any known package. */
    root?: boolean;
    /** Verbosity of the classic per-item log (only applies when the live panel is off). Falls back
     *  to the root's `.rmanrc logLevel`, then 'info' - see `resolveRootLogLevel`. */
    logLevel?: LogLevel;
  }

  /**
   * `clean`: removes build output across every package (root included) - the built-in replacement
   * for `ts-cleanup`, plus whatever else `.rmanrc clean.include`/`clean.exclude` says to remove.
   *
   * For every package not opted out via its own (cascaded) `clean.skip: true`:
   *  - deletes compiled `.js`/`.js.map`/`.d.ts` files under its `src`/`test` (see `cleanTsArtifacts`);
   *  - deletes any `*.tsbuildinfo` incremental-build cache file anywhere in it;
   *  - deletes anything matching its own (cascaded) `clean.include` glob(s), minus `clean.exclude`.
   *
   * `include`/`exclude` are resolved relative to *that* package's own directory - a root-level
   * `.rmanrc` pattern like `packages/*\/build` is naturally evaluated from the repository root
   * (spanning every package in one pass), while a package's own override in its own `.rmanrc`
   * (e.g. `include: ./cache`) only ever reaches that one package, since a package normally
   * overrides rather than merges with the root's value for the same key.
   *
   * Never touches `node_modules` - that's `ci`'s job, not this one.
   *
   * Run from inside a single package's own directory, it only cleans that package unless
   * `options.root` says otherwise (see `Repository.currentPackage`).
   *
   * Uses the same live progress panel as `run`/`build` (see `../utils/progress-panel.ts`) - unlike
   * `ci`, cleaning genuinely is independent per-package work, so the final per-package tally stays.
   */
  export async function clean(repository: Repository, options: Options = {}): Promise<void> {
    /** Standing inside a single package's own directory scopes cleaning to just that package
     *  (root's own artifacts included) unless `--root` asks for the whole repository anyway - a
     *  no-op when already at the root, or outside any known package. */
    const cwdScope = options.root ? undefined : repository.currentPackage;
    const packages = repository.getPackages().filter(p => p !== repository.rootPackage);
    const allTargets = cwdScope ? [cwdScope] : [repository.rootPackage, ...packages];
    const targets = allTargets.filter(pkg => !cleanConfig(pkg).skip);

    const dryRun = options.dryRun ?? false;
    const progress = options.progress ?? true;
    const logger = new Logger(options.logLevel ?? resolveRootLogLevel(repository));
    const panel = new ProgressPanel(dryRun ? 'CLEAN (dry-run)' : 'CLEAN', !!process.stdout.isTTY && progress);
    panel.start();

    let failed = false;
    try {
      const results = await Promise.allSettled(
        targets.map(pkg => {
          const label = pkg === repository.rootPackage ? 'root' : pkg.name;
          return cleanPackage(pkg, panel.addItem(label), panel.enabled, dryRun, logger);
        }),
      );
      if (results.some(r => r.status === 'rejected')) failed = true;
    } finally {
      panel.stop();
    }

    panel.printSummary();

    if (failed) {
      const err: any = new Error('"clean" failed');
      err.logged = true;
      throw err;
    }
  }
}

/** Directories a package's TypeScript output gets cleaned from, mirroring `ts-cleanup -s src`
 *  and `-s test` (the only way it was ever actually invoked in this project's own scripts). */
const TS_SOURCE_DIRS = ['src', 'test'];

/** A package's (cascaded) `.rmanrc clean.include`/`clean.exclude`/`clean.skip` - a package that
 *  declares its own `clean` block replaces the root's entirely for itself (same as any other
 *  rman config key), rather than combining with it. `include`/`exclude` accept a single glob
 *  string or an array of them. */
function cleanConfig(pkg: Package): { include: string[]; exclude: string[]; skip: boolean } {
  const cfg = pkg.config?.clean;
  const normalize = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    return typeof v === 'string' && v ? [v] : [];
  };
  return { include: normalize(cfg?.include), exclude: normalize(cfg?.exclude), skip: cfg?.skip === true };
}

/** Deletes `file`, unless `dryRun` - either way the caller treats it as removed for reporting. */
async function remove(file: string, dryRun: boolean): Promise<void> {
  if (!dryRun) await fs.promises.rm(file, { force: true });
}

/** Removes now-empty directories under `dir`, deepest first (so a parent left empty once its
 *  only child is removed gets caught in the same pass). Also removes `dir` itself once empty
 *  when `includeSelf` is set - used when `dir` is itself something the user asked to delete
 *  (e.g. an `include: build` match), as opposed to a source root like `src`/`test` that should
 *  stay even if everything inside it was cleaned out. No-op in dry-run mode: nothing was actually
 *  deleted, so there's nothing that could have been left empty. */
function pruneEmptyDirs(dir: string, includeSelf: boolean, dryRun: boolean): void {
  if (dryRun || !fs.existsSync(dir)) return;
  const entries = fg.sync('**', { cwd: dir, onlyDirectories: true, dot: true });
  entries.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const rel of entries) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
  }
  if (includeSelf && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Deletes every path matched by `include` (minus `exclude`) under `dirname` - files and
 * directories alike, gulp-`src()`-style. Returns what was actually removed (or, in dry-run mode,
 * what *would* be), relative to `dirname`, so the caller only logs what really happened.
 *
 * `exclude` protects at two levels: a pattern matching a whole `include` result directly (e.g.
 * `packages/pkg1/*` against a matched `packages/pkg1/build` directory) drops that result before
 * anything under it is touched; a finer pattern (e.g. `build/*.json`) instead protects just the
 * matching files *inside* an otherwise-deleted directory, leaving the rest of it gone and the
 * protected files (and their now non-empty parent) in place.
 */
async function cleanGlobs(dirname: string, include: string[], exclude: string[], dryRun: boolean): Promise<string[]> {
  if (!include.length) return [];
  const matches = await fg(include, { cwd: dirname, ignore: exclude, onlyFiles: false, dot: true, absolute: true });
  const protectedFiles = exclude.length
    ? new Set(await fg(exclude, { cwd: dirname, onlyFiles: true, dot: true, absolute: true }))
    : new Set<string>();

  const removed: string[] = [];
  for (const m of matches) {
    const stat = await fs.promises.stat(m).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const filesInside = await fg('**', { cwd: m, onlyFiles: true, dot: true, absolute: true });
      for (const f of filesInside) {
        if (protectedFiles.has(f)) continue;
        await remove(f, dryRun);
        removed.push(path.relative(dirname, f));
      }
      pruneEmptyDirs(m, true, dryRun);
    } else if (!protectedFiles.has(m)) {
      await remove(m, dryRun);
      removed.push(path.relative(dirname, m));
    }
  }
  return removed;
}

/**
 * Removes compiled TypeScript output (`.js`, `.js.map`, `.d.ts`) sitting next to its `.ts`
 * source under `src`/`test` - the same job `ts-cleanup -s <dir> --all` did (the only mode this
 * project ever actually used it in). A `.d.ts` with no matching `.ts`/`.tsx` is left alone - it's
 * presumably a hand-written declaration file, not build output. Prunes directories left empty
 * afterward.
 */
async function cleanTsArtifacts(dirname: string, dryRun: boolean): Promise<string[]> {
  const removed: string[] = [];
  for (const sub of TS_SOURCE_DIRS) {
    const dir = path.join(dirname, sub);
    if (!fs.existsSync(dir)) continue;
    const files = await fg('**/*.{js,js.map,d.ts}', { cwd: dir, onlyFiles: true, dot: true, absolute: true });
    for (const f of files) {
      if (f.endsWith('.d.ts')) {
        const base = f.slice(0, -'.d.ts'.length);
        if (!fs.existsSync(base + '.ts') && !fs.existsSync(base + '.tsx')) continue;
      }
      await remove(f, dryRun);
      removed.push(path.relative(dirname, f));
    }
    pruneEmptyDirs(dir, false, dryRun);
  }
  return removed;
}

/**
 * Removes TypeScript's incremental-build cache files (`*.tsbuildinfo`) anywhere under `dirname` -
 * `tsc --build`/`composite`/`incremental` output that `ts-cleanup` never touched, but which can
 * leave a project in a stale state if a clean rebuild is expected to start from nothing. Skips
 * `node_modules` (dependencies may ship their own, irrelevant to this package's own build).
 */
async function cleanTsBuildInfo(dirname: string, dryRun: boolean): Promise<string[]> {
  const files = await fg('**/*.tsbuildinfo', {
    cwd: dirname,
    ignore: ['**/node_modules/**'],
    onlyFiles: true,
    dot: true,
    absolute: true,
  });
  for (const f of files) await remove(f, dryRun);
  return files.map(f => path.relative(dirname, f));
}

async function cleanPackage(
  pkg: Package,
  item: ProgressItem,
  panelEnabled: boolean,
  dryRun: boolean,
  logger: Logger,
): Promise<void> {
  item.status = 'running';
  item.startedAt = Date.now();
  try {
    item.currentStep = 'ts';
    const tsRemoved = await cleanTsArtifacts(pkg.dirname, dryRun);
    const buildInfoRemoved = await cleanTsBuildInfo(pkg.dirname, dryRun);

    item.currentStep = 'glob';
    const { include, exclude } = cleanConfig(pkg);
    const globRemoved = await cleanGlobs(pkg.dirname, include, exclude, dryRun);

    const removed = [...tsRemoved, ...buildInfoRemoved, ...globRemoved];
    const verb = dryRun ? 'would rm' : 'rm';
    if (panelEnabled) {
      item.lastLine = removed.length
        ? `${dryRun ? 'would remove' : 'removed'} ${removed.length} item(s)`
        : 'already clean';
    } else if (removed.length) {
      for (const r of removed) logger.info(colors.yellow(verb), colors.cyan(item.name), r);
    } else {
      logger.info(colors.gray('clean'), colors.cyan(item.name));
    }
    item.status = 'success';
  } catch (e) {
    item.status = 'failed';
    item.log.push((e as Error)?.message ?? String(e));
    throw e;
  } finally {
    item.finishedAt = Date.now();
  }
}
