import fs from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';
import type { RunBinOptions, RunBinResult } from '../../../../utils/run-bin.js';

/**
 * The files `copyAssets` copies when it is given no patterns: the data formats a package keeps
 * beside its sources - translations, fixtures, schemas - that `tsc` does not emit.
 */
/* **A list, not "everything that is not TypeScript"** - the user's call, and the reason is what
 * ships: a published package is what lands in a consumer's `node_modules`, and "every other file"
 * puts a stray `.md`, a `.DS_Store` or a test's data file there with nothing saying so. A list
 * leaves out what nobody named, and a repository that needs more names it. */
export const DEFAULT_ASSET_PATTERNS: readonly string[] = ['**/*.json', '**/*.xml', '**/*.yaml', '**/*.yml'];

export interface CopyAssetsOptions {
  /** The tsconfig the build compiles with - its `rootDir` and `outDir` say where the files are and
   *  where they go. */
  tsconfig: string;
  /** Globs over paths relative to `rootDir`. Default `DEFAULT_ASSET_PATTERNS`. */
  patterns?: readonly string[];
  /** Runs `tsc` - a function step's own `ctx.runBin`, which already resolves the repository's
   *  installed copy. */
  runBin: (bin: string, argv: string[], options?: RunBinOptions) => Promise<RunBinResult>;
}

/**
 * Copies the files under a tsconfig's `rootDir` that match `patterns` into its `outDir`, keeping
 * their place in the tree - `src/i18n/tr.json` lands at `build/i18n/tr.json`, where the compiled
 * code that reads it expects to find it. Returns the files it wrote, absolute.
 *
 * `tsc` emits none of them: it compiles sources, and a `.json` reaches the output only when code
 * imports it under `resolveJsonModule`. A file read at run time - a translation, an XML template, a
 * fixture - is left behind, and the built package fails on a path that exists only in `src`.
 *
 * A tsconfig with no `outDir` compiles beside its sources, so there is nothing to copy and nothing
 * is. `node_modules`, the output directory itself, `tsconfig*.json`, `package.json` and
 * `package-lock.json` are never copied.
 */
/* **`rootDir`/`outDir` are asked of `tsc --showConfig`, not read out of the file.** A package's
 * tsconfig usually inherits both through `extends` - a relative path or a package such as
 * `@panates/tsconfig` - and resolving that chain is `tsc`'s own logic: JSON with comments, a list
 * of bases, package `exports`. `--showConfig` prints the resolved result with every path relative
 * to the config it was given, in about 0.4s (measured on `panates/opra`'s `common`), which is small
 * beside the compile it follows.
 *
 * **No `rootDir` means `tsc` computed one** - the common directory of its inputs - and `--showConfig`
 * lists those inputs under `files`, so the same answer is taken from there. Declaration files are
 * left out of it, as `tsc` leaves them out. */
export async function copyAssets(options: CopyAssetsOptions): Promise<string[]> {
  const configDir = path.dirname(path.resolve(options.tsconfig));
  /** **`onLine` swallows the lines**: a step's `runBin` hands every line to the step's log, and the
   *  whole resolved configuration printed under the package is noise. `output` still collects them. */
  let output: string;
  try {
    ({ output } = await options.runBin('tsc', ['--showConfig', '-p', options.tsconfig], {
      stdio: 'pipe',
      onLine: () => undefined,
    }));
  } catch (e: any) {
    throw new Error(`"tsc --showConfig -p ${options.tsconfig}" failed:\n${String(e?.output ?? e?.message).trim()}`, {
      cause: e,
    });
  }
  const config = parseShowConfig(output, options.tsconfig);
  const outDir = config.compilerOptions?.outDir;
  if (!outDir) return [];

  const out = path.resolve(configDir, outDir);
  const root = config.compilerOptions?.rootDir
    ? path.resolve(configDir, config.compilerOptions.rootDir)
    : (commonDir((config.files ?? []).filter(f => !/\.d\.[cm]?ts$/.test(f)).map(f => path.resolve(configDir, f))) ??
      configDir);

  /** `package.json` and its lockfile because a `rootDir` of the package itself would otherwise send
   *  them along - and the build directory's manifest is `publish`'s (or the preset's) to write. */
  const ignore = ['**/node_modules/**', '**/tsconfig*.json', '**/package.json', '**/package-lock.json'];
  const outInsideRoot = path.relative(root, out);
  if (outInsideRoot && !outInsideRoot.startsWith('..') && !path.isAbsolute(outInsideRoot)) {
    ignore.push(`${outInsideRoot.split(path.sep).join('/')}/**`);
  }

  const files = await glob([...(options.patterns ?? DEFAULT_ASSET_PATTERNS)], {
    cwd: root,
    ignore,
    onlyFiles: true,
    dot: false,
  });
  const written: string[] = [];
  for (const rel of files.sort()) {
    const target = path.join(out, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, rel), target);
    written.push(target);
  }
  return written;
}

interface ShowConfig {
  compilerOptions?: { rootDir?: string; outDir?: string };
  files?: string[];
}

/** `tsc --showConfig`'s answer. It prints the JSON alone on success; anything else is a tsconfig
 *  `tsc` could not read, which is reported with what it said. */
function parseShowConfig(output: string, tsconfig: string): ShowConfig {
  const start = output.indexOf('{');
  try {
    return JSON.parse(output.slice(start)) as ShowConfig;
  } catch {
    throw new Error(`"tsc --showConfig -p ${tsconfig}" did not print a configuration:\n${output.trim()}`);
  }
}

/** The deepest directory holding every one of `files`, or `undefined` for none. */
function commonDir(files: string[]): string | undefined {
  if (!files.length) return undefined;
  let common = path.dirname(files[0]!);
  for (const file of files.slice(1)) {
    while (path.relative(common, file).startsWith('..')) common = path.dirname(common);
  }
  return common;
}
