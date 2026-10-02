import fs from 'node:fs';
import path from 'node:path';
import colors from 'ansi-colors';
import fg from 'fast-glob';
import type { Package } from '../../../../core/classes/package.js';
import type { Repository } from '../../../../core/classes/repository.js';
import type { LogLevel } from '../../../../utils/logger.js';
import { Logger, resolveRootLogLevel } from '../../../../utils/logger.js';
import type { PackageFilterOptions } from '../../../../utils/package-filter.js';
import { filterPackages } from '../../../../utils/package-filter.js';
import type { ProgressItem } from '../../../../utils/progress-panel.js';
import { ProgressPanel } from '../../../../utils/progress-panel.js';

export namespace CleanService {
  export interface Options extends PackageFilterOptions {
    /** Show the live progress panel. Default true; auto-disabled when stdout isn't a TTY. */
    progress?: boolean;
    /** Report what would be removed without actually removing anything. Default false. */
    dryRun?: boolean;
    /** Clean the whole repository even when the current directory is inside a single package
     *  (which otherwise scopes cleaning to just that package - see `Repository.currentPackage`).
     *  Has no effect when already at the repository root, or outside any known package. */
    fromRoot?: boolean;
    /** Verbosity of the classic per-item log (only applies when the live panel is off). Falls back
     *  to the root's `.rmanrc logLevel`, then 'info' - see `resolveRootLogLevel`. */
    logLevel?: LogLevel;
  }

  /**
   * `clean`: removes build output across every package (root included) - the replacement for
   * `ts-cleanup`, plus whatever else `.rmanrc clean.include`/`clean.exclude` says to remove.
   *
   * **The `node` built-in's rather than always present, because what it knows how to delete is not
   * repository-shaped knowledge but TypeScript-shaped**: a compiled `.js`/`.js.map`/`.d.ts` beside
   * its `.ts` source, a `*.tsbuildinfo`, and a `node_modules` to skip while looking. A Cargo or Go
   * repository has `cargo clean` and `go clean` and nothing here would fire for it, so a core
   * `clean` was a command that only appeared to be general.
   *
   * The `clean.include`/`clean.exclude` globs move with it, and that is the one cost worth naming:
   * they are ecosystem-neutral, so a repository wanting only those now has to name this plugin (or
   * write the two `rm` lines as a `run` script). Keeping a stub `clean` in core for them would mean
   * two commands with one name and a precedence rule between them - worse than the honest move.
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
   * `options.fromRoot` says otherwise (see `Repository.currentPackage`).
   *
   * Uses the same live progress panel as `run`/`build` (see `../utils/progress-panel.ts`) - unlike
   * `ci`, cleaning genuinely is independent per-package work, so the final per-package tally stays.
   */
  export async function clean(repository: Repository, options: Options = {}): Promise<void> {
    /** Standing inside a single package's own directory scopes cleaning to just that package
     *  (root's own artifacts included) unless `--from-root` asks for the whole repository anyway - a
     *  no-op when already at the root, or outside any known package. */
    const cwdScope = options.fromRoot ? undefined : repository.currentPackage;
    const packages = repository.getPackages().filter(p => p !== repository.rootPackage);
    const allTargets = cwdScope ? [cwdScope] : [repository.rootPackage, ...packages];
    const targets = filterPackages(allTargets, options).filter(pkg => !cleanConfig(pkg).skip);

    const dryRun = options.dryRun ?? false;
    const progress = options.progress ?? true;
    const logger = new Logger(options.logLevel ?? resolveRootLogLevel(repository));
    const panel = new ProgressPanel(dryRun ? 'CLEAN (dry-run)' : 'CLEAN', !!process.stdout.isTTY && progress);
    panel.detail = repository.name;
    panel.start(repository.app.statusRegion);

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

/**
 * Where a package's own build output lives, so the sweep below can leave it alone - the resolved
 * `publish.npm.directory`, falling back to `build`.
 *
 * **Read from the config, never hardcoded.** The directory is the repository's to name: the shared
 * preset drives it from a `vars.buildDir`, and a repository that renames it moves
 * `publish.npm.directory`, `clean.include` and the build itself together. A literal `build` here
 * would sweep a repository that calls it `dist` - deleting every emitted file in it, one at a time,
 * because each sits beside nothing and the guard below would not fire. `publish`'s own generated
 * manifest reads the same key, which is what keeps the two from disagreeing about where a package
 * is built.
 */
function buildDirOf(pkg: Package): string {
  const configured = pkg.config?.publish?.npm?.directory;
  return typeof configured === 'string' && configured ? configured : 'build';
}

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
 * Removes compiled TypeScript output (`.js`, `.js.map`, `.d.ts`) sitting next to its `.ts` source,
 * anywhere in the package except `node_modules` and the build directory. Prunes directories left
 * empty afterward.
 *
 * **Two tiers, because how much a directory tells you differs.** Under `src`/`test` everything is
 * TypeScript, so a compiled file is swept whether or not its source is still there - which keeps
 * the orphan case working, a `.js` whose `.ts` was renamed or deleted. Anywhere else in the package
 * a file is swept **only when a matching `.ts`/`.tsx` sits beside it**, because that is the only
 * thing that distinguishes output from something somebody wrote.
 */
/* **It used to look only in `src/` and `test/`**, inherited from `ts-cleanup -s src` - and that is
 * the half this exists to fix. `tsc` writes its output beside the source whenever a config does not
 * send it elsewhere, which is exactly the accident `clean` is reached for, and a package keeping
 * `index.ts` at its own root was therefore never swept. Measured on `panates/opra`: ten emitted
 * files in `examples/**` survived every `rman clean`, and `rman lint` there died inside
 * `eslint-plugin-import-x` on one of them - a crash that looks like an eslint problem and is a stale
 * artifact.
 *
 * **Widening the search without a guard outside `src`/`test` would have been destructive**, which
 * is why the two tiers arrived together. Under `src/` a bare `.js` is deleted unconditionally and
 * should be; over a whole package the same rule reaches `index.js`, `*.config.js`, `scripts/*.js` -
 * hand-written files with no `.ts` behind them. The `.d.ts` rule was already the right one for that
 * ground and now covers all three extensions there. The cost, stated rather than hidden: outside a
 * source root, a compiled `.js` whose `.ts` has since been deleted is left alone, because nothing
 * on disk says it was ever generated.
 *
 * **The build directory is excluded by name from the config, never as the literal `build`** - see
 * `buildDirOf`. Its contents are the *point* of a build and are removed by `clean.include` when the
 * repository asks, not by a rule about stray files. */
async function cleanTsArtifacts(pkg: Package, dryRun: boolean): Promise<string[]> {
  const dirname = pkg.dirname;
  const buildDir = buildDirOf(pkg);
  const files = await fg('**/*.{js,js.map,d.ts}', {
    cwd: dirname,
    ignore: ['**/node_modules/**', `${buildDir}/**`, `**/${buildDir}/**`],
    onlyFiles: true,
    dot: true,
    absolute: true,
  });

  const removed: string[] = [];
  for (const f of files) {
    if (!isBuildOutput(dirname, f)) continue;
    await remove(f, dryRun);
    removed.push(path.relative(dirname, f));
  }
  /** Pruned from the source roots, exactly as before - `pruneEmptyDirs` with `includeSelf: false`
   *  clears what is *under* a directory and keeps the directory itself, so `src/sub` left empty is
   *  removed and `src` is not. Nothing is pruned elsewhere in the package: a directory that was
   *  only searched is not one the caller asked to delete. */
  for (const sub of TS_SOURCE_DIRS) {
    const dir = path.join(dirname, sub);
    if (fs.existsSync(dir)) pruneEmptyDirs(dir, false, dryRun);
  }
  return removed;
}

/**
 * Whether a compiled file is this package's own build output, and so may go.
 *
 * Three rules, and each is a different amount of evidence:
 *
 * - **A `.d.ts` always needs its `.ts`/`.tsx` beside it**, everywhere including `src` - a
 *   hand-written declaration is an ordinary thing to keep in a source tree, and this is the rule
 *   that has always been here.
 * - **A `.js`/`.js.map` under `src`/`test` goes regardless.** Everything there is TypeScript, so an
 *   orphan - output whose source was renamed or deleted - is still output, and sweeping it is the
 *   `ts-cleanup --all` behaviour this replaced.
 * - **A `.js`/`.js.map` anywhere else needs its source beside it**, because out there it could just
 *   as easily be `index.js`, `*.config.js` or `scripts/*.js`, which nobody generated.
 */
function isBuildOutput(dirname: string, file: string): boolean {
  if (file.endsWith('.d.ts')) return hasTsSource(file, '.d.ts');
  if (insideTsSourceDir(dirname, file)) return true;
  return hasTsSource(file, file.endsWith('.js.map') ? '.js.map' : '.js');
}

/** Directories where everything is TypeScript, so a compiled file needs no source beside it to be
 *  recognized as one - the two `ts-cleanup -s <dir>` was ever invoked with here. */
const TS_SOURCE_DIRS = ['src', 'test'];

/** Whether `file` sits under one of the package's TypeScript source roots. Compared on the path
 *  segments rather than with `startsWith`, so a `source/` directory is not read as `src`. */
function insideTsSourceDir(dirname: string, file: string): boolean {
  const rel = path.relative(dirname, file).split(path.sep);
  return TS_SOURCE_DIRS.includes(rel[0]!);
}

/** Whether a compiled file has its `.ts`/`.tsx` source sitting beside it - which is what makes it
 *  compiled output rather than something somebody wrote. `suffix` is the compiled extension to
 *  strip, passed in because `.js.map` and `.js` both end in `.js` and the caller already knows. */
function hasTsSource(file: string, suffix: string): boolean {
  const base = file.slice(0, -suffix.length);
  return fs.existsSync(base + '.ts') || fs.existsSync(base + '.tsx');
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
    const tsRemoved = await cleanTsArtifacts(pkg, dryRun);
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
