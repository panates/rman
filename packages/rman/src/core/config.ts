import { DOMParser } from '@xmldom/xmldom';
import fs from 'fs';
import ini from 'ini';
import * as yaml from 'js-yaml';
import path from 'path';
import semver from 'semver';
import vm from 'vm';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { DETECTED_BUILTIN, type DetectedBuiltin } from '../plugins/detect.js';
import { assertSelectorBlocks, EXTENDS_KEY, resolveExtends } from './extends-config.js';
import { loadConfigModule } from './load-config-module.js';
import { mergeConfig, ORIGINS, PREVIOUS_VALUES, type PreviousValue } from './merge-config.js';
import type { RunConditionFn, RunStepFn } from './run-step.js';

/**
 * Identity helper for authoring a `.rmanrc.cjs`/`.mjs`/`.js` config with full type-checking and
 * autocomplete - the same `defineConfig` pattern Vite/Vitest use. Returns `config` completely
 * unchanged; this exists purely so TypeScript can infer/check against `RmanConfig`, not for any
 * runtime behavior:
 *
 *   // .rmanrc.mjs
 *   import { defineConfig } from 'rman';
 *   export default defineConfig({ packageManager: 'pnpm' });
 *
 *   // .rmanrc.cjs
 *   const { defineConfig } = require('rman');
 *   module.exports = defineConfig({ packageManager: 'pnpm' });
 */
export function defineConfig(config: RmanConfig): RmanConfig {
  return config;
}

/** `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js`, checked in this order - a JS module whose default
 *  export (or, lacking one, the module's own exports object) is the config. Both CommonJS (`.cjs`,
 *  or a `.js` under a `"type": "commonjs"` package.json) and native ESM (`.mjs`, or a `.js` under
 *  `"type": "module"`) are supported - the reason `readDirConfig`/`resolveConfig` are async at all. */
const JS_CONFIG_FILES = ['.rmanrc.cjs', '.rmanrc.mjs', '.rmanrc.js'];

/**
 * Reads the rman configuration defined at a single directory level, merging
 * (in increasing precedence): `package.json#rman`, `.rmanrc.yml`, `.rmanrc`,
 * then `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js` (whichever exist, in that order).
 *
 * `options.inject` supplies a built-in for a repository that declared no technology - **already
 * decided**, rather than a "please detect" flag. The decision needs the application (a programmatic
 * caller or a spec may have registered a technology without writing it in a config), which this
 * function has no business knowing about; `Repository.create` makes it once and hands the answer
 * to every read that has to agree with it. See `detectBuiltin`.
 */
export async function readDirConfig(dirname: string, options?: { inject?: DetectedBuiltin }): Promise<RmanConfig> {
  const result: RmanConfig = {};
  /** The file an `extends` in this directory resolves relative to. The last form that actually
   *  declared one wins, which matters only for the unusual directory holding several. */
  let extendsFrom = path.join(dirname, '.rmanrc');

  const pkgJsonFile = path.join(dirname, 'package.json');
  if (fs.existsSync(pkgJsonFile)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
    if (pkgJson && typeof pkgJson.rman === 'object') {
      assertSelectorBlocks(pkgJson.rman, pkgJsonFile);
      if (EXTENDS_KEY in pkgJson.rman) extendsFrom = pkgJsonFile;
      mergeConfig(result, pkgJson.rman, pkgJsonFile);
    }
  }

  const ymlFile = path.join(dirname, '.rmanrc.yml');
  if (fs.existsSync(ymlFile)) {
    const obj = yaml.load(fs.readFileSync(ymlFile, 'utf-8'));
    if (obj && typeof obj === 'object') {
      assertSelectorBlocks(obj as RmanConfig, ymlFile);
      if (EXTENDS_KEY in obj) extendsFrom = ymlFile;
      mergeConfig(result, obj as Record<string, any>, ymlFile);
    }
  }

  const rcFile = path.join(dirname, '.rmanrc');
  if (fs.existsSync(rcFile)) {
    const obj = JSON.parse(fs.readFileSync(rcFile, 'utf-8'));
    if (obj && typeof obj === 'object') {
      assertSelectorBlocks(obj, rcFile);
      if (EXTENDS_KEY in obj) extendsFrom = rcFile;
      mergeConfig(result, obj, rcFile);
    }
  }

  for (const jsFileName of JS_CONFIG_FILES) {
    const jsFile = path.join(dirname, jsFileName);
    if (fs.existsSync(jsFile)) {
      const obj = await loadConfigModule(jsFile);
      if (obj && typeof obj === 'object') {
        assertSelectorBlocks(obj, jsFile);
        if (EXTENDS_KEY in obj) extendsFrom = jsFile;
        mergeConfig(result, obj, jsFile);
      }
    }
  }

  /** Resolved per directory, once its own forms have been combined: `extends` is the base every
   *  one of them sits on, and the directory chain then layers on top as it always did. Each form
   *  was checked for a misplaced `extends` as it was read, so that error can name the file holding
   *  it rather than whichever form happened to declare the real one. */
  const resolved = await resolveExtends(result, extendsFrom);
  /**
   * **After `extends`, because a base may be what declares the technology** - a shared config
   * naming `plugins` is a statement, and detecting on top of it would be guessing over an answer.
   * `plugins` being *present* is what counts, so `plugins: []` is a repository saying "none".
   */
  const detected = options?.inject && resolved.plugins === undefined ? options.inject : undefined;
  if (detected) resolved.plugins = [detected.name];
  const expanded = await expandBuiltinPlugins(resolved);
  /**
   * **Marked after the expansion, not before, because the expansion rebuilds the object.**
   * `expandBuiltinPlugins` merges the built-in's config underneath and returns a *new* config, so a
   * symbol set on the way in is simply gone on the way out - measured: detection worked and the
   * "detected" line never printed. The same trap `PREVIOUS_VALUES` and `ORIGINS` document from the
   * other side, where `mergeConfig` has to copy them across by hand.
   */
  if (detected) {
    Object.defineProperty(expanded, DETECTED_BUILTIN, { value: detected, enumerable: false, configurable: true });
  }
  return expanded;
}

/**
 * Turns a built-in **name** in `plugins` into what that built-in contributes - `['node']` into the
 * node plugin, its two commands and its publish target.
 *
 * **Here, beside `extends`, because it is the same operation**: something named brings a config,
 * and that config sits *underneath* the one naming it. Doing it anywhere later would not reach far
 * enough - `commands` is read off the resolved root package by `cli.ts`, not off the raw config
 * `Repository.create` hands to `loadPlugins`, so a built-in expanded only there would register its
 * technology and silently lose its commands.
 *
 * **The name is consumed.** `plugins` always appends, so leaving the string beside the instance it
 * expanded into would hand `loadPlugins` a glob that matches no file - the built-in would load and
 * then the run would fail saying it did not.
 *
 * Runs per directory, like `extends`, but only the root's `plugins` is ever read (`loadPlugins`
 * needs the technologies before any package exists). The cost of walking a key that is almost
 * always absent is one `Array.isArray`.
 */
async function expandBuiltinPlugins(config: RmanConfig): Promise<RmanConfig> {
  const declared = config.plugins;
  const own = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
  const platform = declaredPlatform(config);
  if (!own.some(e => typeof e === 'string') && platform === undefined) return config;

  /**
   * **Imported here rather than at the top, and that is a cycle rather than a style.** A built-in
   * pulls in its commands and services, which read config - so a static import would have
   * `config.ts` and the plugin subtree initialising each other, which in ESM half-works and fails
   * silently. Node caches the module, so the cost is one resolution on a config that names one.
   */
  const { BUILTIN_PLUGINS, isBuiltinPlugin } = await import('../plugins/builtins.js');

  /**
   * **A `platform` naming a built-in puts it at the front of `plugins`.**
   *
   * Saying which technology this repository is *is* saying it has it, so making the author write
   * both was a distinction only rman could see. Measured on the repository this was noticed in:
   * `platform: 'node'` alone gave a working `rman list` with a `node` column and
   * `Unknown arguments: clean`, because the technology had loaded and its commands had not.
   *
   * **At the front, not the back**, and that is what makes it a statement rather than an addition:
   * `platformFor` takes the first registered platform that recognizes a directory, so the one this
   * repository says it *is* should win over anything a shared config brought along.
   *
   * **Only a built-in**, checked after the import above for exactly this reason: a `platform` naming
   * a third-party technology is answered by the `plugins` entry that loads it, and pushing the bare
   * name in here would hand `loadPlugins` a glob matching no file - the failure would read as the
   * plugin being missing when it is registered perfectly well.
   *
   * Already named, and nothing happens: `plugins` de-duplicates, and this keeps the author's own
   * ordering rather than promoting an entry they placed deliberately.
   */
  const entries =
    platform !== undefined && isBuiltinPlugin(platform) && !own.includes(platform) ? [platform, ...own] : own;

  const named = entries.filter((e): e is string => typeof e === 'string' && isBuiltinPlugin(e));
  if (!named.length) return config;

  const base: RmanConfig = {};
  /** De-duplicated first: two layers naming the same built-in is ordinary (a shared config and the
   *  repository that inherits it), and registering a plugin twice defines its commands twice. */
  for (const name of [...new Set(named)]) mergeConfig(base, BUILTIN_PLUGINS[name]!.contribute());
  const result = { ...(config as Record<string, unknown>) };
  result.plugins = entries.filter(e => !(typeof e === 'string' && isBuiltinPlugin(e)));
  return mergeConfig(base, result) as RmanConfig;
}

/**
 * The **root's** declared platform, however it was spelled - unmarked, or inside a `"[/]"` block.
 *
 * Both, because both are the root saying what it is and a reader would not expect one to bring the
 * built-in and the other not. `"[/]"` is the precise spelling (it speaks for the root package
 * alone, where an unmarked key also cascades to every package below), so leaving it out would have
 * punished the more careful author.
 *
 * A glob block is not consulted and cannot be: `assertSelectorBlocks` refuses `platform` there,
 * since the glob matches a selector the key is upstream of.
 */
function declaredPlatform(config: RmanConfig): string | undefined {
  const root = (config as Record<string, any>)[`[${ROOT_SELECTOR_INNER}]`];
  const declared = config.platform ?? (root && typeof root === 'object' ? root.platform : undefined);
  return typeof declared === 'string' && declared.trim() ? declared.trim() : undefined;
}

/**
 * Resolves the effective config for the package at `targetDir`, cascading from `rootDir` down to
 * it (inclusive) - each directory level overrides the ones above it, the way tsconfig's `extends`
 * chain does.
 *
 * Every level contributes in two ways:
 *
 * - **An unmarked key configures that directory and every package under it.** What a parent says
 *   reaches the children, which is what every directory-scoped config in the ecosystem does and
 *   what a reader expects without being told.
 * - **A `"[selector]"` block narrows the audience** - `"[/]"` to the root package alone, `"[*]"` or
 *   a glob to the packages below (never the root, which is nobody's child). See `parseSelector`.
 *
 * **The root used to be the one directory whose unmarked config did *not* cascade**, on the
 * reasoning that a setting means different things to a package and to the repository - and the
 * reasoning is sound, but the rule it produced was not readable: an intermediate `packages/`
 * cascaded while the root did not, so what a file meant depended on whether a `package.json` sat
 * beside it. `vars` then had to be carved out as an exception, which is what a rule fighting itself
 * looks like. One sentence now covers both: what is written above reaches below, and `"[/]"` is how
 * a statement stays at the root.
 *
 * **The cost is real and lands on one subtree.** `run.<script>`'s hooks on the root are a repo-wide
 * bookend, run once at the repository root; on a package they are that package's own hook, run in
 * its directory. Cascaded, one declaration is both - once at the root and once per package. A
 * repo-wide bookend therefore belongs under `"[/]"`, where its audience is visible; that is the
 * migration this change asks for, and the only one that is not mechanical.
 *
 * **`selector` is what a `"[glob]"` block matches** - `Package.selector`, which is the package's
 * `.rmanrc "name"` if it declares one and its platform's answer otherwise. Without it, glob blocks
 * contribute nothing: the walk resolves config for a directory *before* the package exists, since
 * that is where `platform` and `name` are read from, and a glob has nothing to match against yet.
 *
 * **`"[/]"` needs no selector, and that is the documented rule rather than an exception.** The root
 * is addressed structurally - its directory *is* the repository root - which is the whole reason it
 * is `/` and not a name. So a root block applies whenever the target is the root, named or not, and
 * `platform` under `"[/]"` therefore works during the walk. It did not until this was noticed: the
 * gate was `if (packageName)`, so the walk skipped every selector block including that one, and the
 * key documented as "keeps it on the root package alone" silently did nothing.
 *
 * It was called `packageName`, which was wrong twice over: a package is not guaranteed to have a
 * name (that is an ecosystem's promise, not rman's), and what this matches is the selector, which a
 * repository can assign itself.
 */
export async function resolveConfig(
  rootDir: string,
  targetDir: string,
  cache: Map<string, RmanConfig> = new Map(),
  selector?: string,
  /** The built-in `Repository.create` decided on, for a repository that declared no technology.
   *  Applied at the **root level only** - `plugins` is read nowhere else, and this is the read whose
   *  result becomes `pkg.config`, which is where `cli.ts` finds a built-in's `commands`. */
  inject?: DetectedBuiltin,
): Promise<RmanConfig> {
  const result: RmanConfig = {};
  const target = path.resolve(targetDir);
  /** The root *package* is the one whose directory is the repository root - no other test is
   *  needed, and none would be as reliable: a name can be anything. In a single-package repository
   *  that is the only package, so `"[/]"` reaches it and `"[*]"` reaches nothing. */
  const isRoot = target === path.resolve(rootDir);
  for (const dir of dirChain(rootDir, targetDir)) {
    let local = cache.get(dir);
    if (!local) {
      local = await readDirConfig(dir, {
        inject: path.resolve(dir) === path.resolve(rootDir) ? inject : undefined,
      });
      cache.set(dir, local);
    }
    /**
     * **Unmarked first, because it is the widest thing this level says** - and that is an inversion
     * of the order this loop used to run in, where a directory's own plain config beat a selector
     * declared beside it. Under the old reading "unmarked" meant *this package* and so was the
     * narrower of the two; it now means *this package and everything below*, which is the wider.
     * Precedence follows the audience, not the spelling, so it had to move.
     *
     * Its position in the file is deliberately not consulted: a selector block written above the
     * plain keys still wins. Unmarked is not a fourth selector - it is the level's floor, and the
     * layer that feeds the directories below it.
     */
    mergeConfig(result, stripSelectors(local));
    /** Then the selector blocks, **in the order they were written** - see `matchingSelectors`.
     *  Reached for the root even with no selector, since `"[/]"` is structural. */
    if (selector !== undefined || isRoot) {
      for (const block of matchingSelectors(local, selector, isRoot)) mergeConfig(result, block);
    }
  }
  return result;
}

/** A config key naming packages rather than settings: `"[*]"`, `"[/]"`, `"[pkg-a]"`. The
 *  brackets are what keep this space from colliding with real config keys - no setting starts with
 *  one - and in YAML they also mean the key always needs quoting (`"[*]":`), since a bare `[*]`
 *  parses as a flow sequence. */
export function isSelectorKey(key: string): boolean {
  return key.length > 2 && key.startsWith('[') && key.endsWith(']');
}

/**
 * **Which packages a selector speaks for.** Two audiences, and the second is a glob:
 *
 * | | |
 * | --- | --- |
 * | `"[/]"` | the **root package** alone |
 * | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | the packages **below** this directory that the glob matches |
 *
 * `/` for the root because that is what a repository root is called everywhere else, and it cannot
 * collide with a package name.
 *
 * **The root is never selected by name, and that one rule removes two traps.** A glob matches
 * package names, and the root is nobody's child - so `"[my-*]"` cannot quietly pick up a repository
 * whose root package happens to be called `my-repo`, and `"[*]"` cannot hand a package-shaped
 * setting to a root that has no build directory to apply it to. The root is addressed structurally
 * or not at all.
 *
 * **`"[ws:*]"` / `"[workspace:*]"` is accepted and means exactly `"[*]"`.** The qualifier existed to
 * say "not the root" back when a bare glob included it; the shape of the set says that now, so it
 * has nothing left to add. Accepted rather than rejected because the two spellings resolve to the
 * same packages - an error would be friction with no reader to protect.
 */
export function parseSelector(key: string): { scope: 'root' | 'package'; test: (name: string) => boolean } {
  const inner = key.slice(1, -1);
  if (inner === ROOT_SELECTOR_INNER) return { scope: 'root', test: () => true };
  const re = globToRegExp(stripWorkspacePrefix(inner));
  return { scope: 'package', test: name => re.test(name) };
}

/** The glob inside a selector key, as a `RegExp` anchored at both ends - so `"[*-dialect]"` matches
 *  `mysql-dialect` but not `my-dialect-helper`. Glob rather than regex, to match every other
 *  pattern in rman (`allowBranch`, `changelog.tagPattern`, `clean.include`). */
export function selectorToRegExp(key: string): RegExp {
  return globToRegExp(stripWorkspacePrefix(key.slice(1, -1)));
}

/**
 * Every selector block in `config` that speaks for this package, **in the order they were written**
 * - later wins, the way `overrides` works in eslint, prettier and babel, and the way a `.gitignore`
 * rule does.
 *
 * **There used to be a ranking** (`"[*]"` lowest, then a catch-all `"[ws:*]"`, then the rest by
 * declaration), so that "everything" could not beat a rule about one package by being written last.
 * It was dropped because the ordering it implies does not exist: specificity only ranks sets that
 * nest, and globs do not. For a package called `pkg-dialect`, neither `"[pkg-*]"` nor
 * `"[*-dialect]"` contains the other, so any answer is an invented tiebreak - and an invented
 * tiebreak is worse than the order the author typed. What was left was already declaration order
 * with one case lifted out of it; this removes the exception rather than generalizing it.
 *
 * The cost, which the docs state rather than hide: a catch-all written *below* a narrower block now
 * overrides it. Writing catch-alls first is a convention, not a rule - the file reads top to bottom.
 */
function matchingSelectors(config: RmanConfig, selector: string | undefined, isRoot: boolean): RmanConfig[] {
  const matches: RmanConfig[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!isSelectorKey(key) || !value || typeof value !== 'object') continue;
    const { scope, test } = parseSelector(key);
    /** A root block asks only whether this *is* the root - no selector needed, which is what makes
     *  `/` structural. A glob has to have something to match, and during the walk it does not. */
    if (scope === 'root' ? !isRoot : isRoot || selector === undefined || !test(selector)) continue;
    matches.push(value as RmanConfig);
  }
  return matches;
}

/** `"[ws:*]"` and `"[workspace:*]"` are the pre-2.x spelling of "not the root", kept working
 *  because they now name the same set a bare glob does. Stripped here so one code path serves both. */
function stripWorkspacePrefix(inner: string): string {
  for (const prefix of WORKSPACE_PREFIXES) if (inner.startsWith(prefix)) return inner.slice(prefix.length);
  return inner;
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function stripSelectors(config: RmanConfig): RmanConfig {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) if (!isSelectorKey(key)) result[key] = value;
  return result as RmanConfig;
}

/** `"[/]"` - the root package, spelled the way a repository root is spelled everywhere else, and
 *  unable to collide with a package name. */
const ROOT_SELECTOR_INNER = '/';

/** Accepted spellings of the retired "not the root" qualifier - see `stripWorkspacePrefix`. */
const WORKSPACE_PREFIXES = ['workspace:', 'ws:'] as const;

function dirChain(rootDir: string, targetDir: string): string[] {
  const rel = path.relative(rootDir, targetDir);
  if (!rel || rel === '.' || rel.startsWith('..')) return [rootDir];
  const dirs = [rootDir];
  let dir = rootDir;
  for (const segment of rel.split(path.sep)) {
    dir = path.join(dir, segment);
    dirs.push(dir);
  }
  return dirs;
}

/** One package, as an expression sees it - the same shape for the package the config belongs to
 *  and for the repository itself, so `${{ repository.basename }}` reads the way `${{ pkg.basename }}` does. */
/**
 * `file` in a `${{ ... }}` expression: what is actually on disk, resolved against **the package
 * the config was resolved for** - so one declaration in a `"[*]"` block asks each package about
 * its own directory.
 *
 * The pair exists because a config has two different questions about a path, and answering both
 * with one function would mean picking a wrong default for the other:
 *
 * ```yaml
 * "[*]":
 *   run:
 *     build:
 *       # first of these that exists, and an error naming the config path if none do
 *       exec: 'tsc -b ${{ file.exists("tsconfig-build.json") || file.resolve("tsconfig.json") }}'
 * ```
 *
 * **Every member asks a question, and none may ever change anything - no `copy`, no `write`, no
 * `mkdir`.** Not a matter of taste: this is evaluated when the config *resolves*, which every
 * command does, so a member that acted would act on `rman list`, `rman info` and `rman config`.
 *
 * That has been tried, in the only way a missing function can be: a shared config reaching for a
 * `file.copyMany(...)` that does not exist made **every** rman command exit 1 - and had it existed,
 * the quieter outcome would have been files copied by `rman list`. Work belongs in a step
 * (`run.<script>`'s slots, `version`'s hooks), which is the one place rman runs anything, and a
 * step can now be a function - so there is nothing this would enable that is not already possible
 * at the right moment.
 */
export interface FileScope {
  /**
   * The absolute path if it exists, **`''` if it does not** - so `a || b || c` picks the first one
   * present, and so a miss never reaches the "nullish inside a string" guard that `undefined` would
   * trip. Accepts a relative path (against the package directory) or an absolute one.
   *
   * It returns a path rather than a boolean on purpose: the caller almost always wants the path,
   * and a separate `file.path()` to fetch it after a boolean test would read the disk twice and
   * invite the two calls to disagree.
   */
  exists(target: string): string;
  /** The absolute path, or **throws** - for a file whose absence is a mistake rather than a case to
   *  handle. The error names the config path holding the expression, like any other. */
  resolve(target: string): string;
  /**
   * The first of several that exists, or **throws** naming every candidate it tried:
   *
   * ```yaml
   * exec: 'tsc -b ${{ file.resolveFirst("tsconfig-build.json", "tsconfig.build.json", "tsconfig.json") }}'
   * ```
   *
   * The same thing an `exists() || exists() || resolve()` chain does, said once - and it cannot be
   * got subtly wrong the way that chain can: ending it in `exists()` leaves `tsc -b ` with no
   * argument when nothing matches, and tsc then silently falls back to the directory's default
   * rather than reporting that the package has no build config.
   */
  resolveFirst(...targets: string[]): string;
}

export interface PackageScope {
  /** The package's own name, scope included (`@sqb/builder`). */
  name: string;
  /** Just the scope (`@sqb`), or `undefined` for an unscoped package. */
  scope: string | undefined;
  /** The name with its scope stripped (`builder`). */
  unscopedName: string;
  version: string;
  /** The package directory's last segment (`builder`) - not always the same as `unscopedName`,
   *  which is why both exist, and usually what a sibling path (`../../coverage/builder`) is keyed on. */
  basename: string;
  /** Absolute path to the package's own directory - named as rman's own `Package.dirname` is. */
  dirname: string;
  /** That directory relative to the repository root (`packages/builder`), which is what a command
   *  addressing another package from the root usually needs. Empty string for the root itself. */
  relativeDir: string;
  /**
   * Which ecosystem this package belongs to - `'node'` for one the `node` built-in read, empty when no
   * plugin claimed it. The same `Package.provider`, so one declaration can address a single
   * ecosystem in a polyglot repository (`if: "${{ pkg.provider === 'node' }}"`).
   */
  provider: string;
  /**
   * The whole manifest, as a copy - so an expression can reach a field rman itself has no opinion
   * about (`${{ pkg.manifest.engines.node }}`).
   *
   * Named `manifest`, not `json`: which file a package's identity lives in is the ecosystem's
   * business now (see `Plugin`'s manifest members), and `json` was that assumption showing through the one
   * remaining user-facing name. A config written against `${{ pkg.json... }}` needs the rename.
   */
  manifest: Record<string, unknown>;
  /**
   * The version this run is about to write - **bound only during `version`**, and only once its
   * plan is computed. Reading it anywhere else throws rather than yielding `undefined`: no other
   * command has a target version, so an expression asking for one has been put in the wrong place,
   * and a config that quietly evaluates to "undefined" is the failure this evaluator exists to
   * prevent.
   */
  targetVersion: string;
}

/** Facts about the repository, on top of the root package's own - because the repository root *is*
 *  a package (`repository.name` is what its `package.json` says, `repository.basename` the directory
 *  it sits in, and the two genuinely differ). Sharing `PackageScope`'s shape is what makes
 *  `repository.version` read the way `pkg.version` does. */
export interface RepositoryScope extends PackageScope {
  monorepo: boolean;
  /** Every package in the repository - the root included only when it *is* the one package. */
  packages: PackageScope[];
  /** One package by name, or `undefined` - for reaching a sibling's directory. */
  package(name: string): PackageScope | undefined;
}

export interface GitScope {
  branch: string | undefined;
  sha: string | undefined;
  shortSha: string | undefined;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean | undefined;
}

/**
 * What a **value function** is handed - `clean: { include: ({ value, pkg }) => [...] }`.
 *
 * The same scope a `${{ }}` expression sees, plus `value`. There is no asymmetry between the two
 * spellings and that is an invariant with a spec on it: the argument *is* the expression context
 * with `value` on it, so a member defined straight onto the argument would split them silently and
 * a config author would meet a name that works in one spelling and not the other.
 *
 * **The config's own top-level keys are bound bare too**, and they cannot be typed here - they come
 * from the config being interpolated rather than from this object. Reach them through `pkg.config`
 * when a type matters, or accept `any` from the bare name.
 *
 * **Not what a *step* function is handed.** `run.<script>.exec` and `version.<slot>` take a
 * `RunStepFn`, which gets a `RunStepContext` (`pkg`, `repository`, `cwd`, `runBin`, `logger`) when
 * its turn comes - a different object at a different time, which is the whole distinction the two
 * forms exist to draw. Never widen a step key to accept this one.
 */
export interface ConfigValueContext extends ConfigScope {
  /**
   * What this key resolved to in the layers **below** this one - the list form of it, so
   * `[...value, 'x']` needs no guard. `any` rather than a generic: the key's own type is what the
   * function must return, while `value` is whatever the layers underneath happened to produce, and
   * a scalar underneath arrives as a one-element list. See `previousValue`.
   */
  value: any;
  /** The config's own top-level keys, bound bare - `vars`, `publish`, `clean`, … */
  [key: string]: any;
}

/**
 * A config value that may be **written as a function instead**, computed per package at the moment
 * the config resolves.
 *
 * `T` is what the function has to return, so the same checking applies either way - measured, with
 * a control: a typo inside a wrapped object is still caught, and so is one inside an object a value
 * function *returns*.
 *
 * **Not for a step key.** `run.<script>.before`/`.exec`/`.after`, `run.<script>.if` and
 * `version.<slot>` already take a function, and it means something else there - code for `run` to
 * call in its own time, with its own context. Wrapping one of those would produce a type that
 * accepts a value function where a step is what actually runs. The key path decides which a
 * function is (`STEP_PATHS`, `CODE_SUBTREES`), and the type can only follow that split by hand.
 */
export type ConfigValue<T> = T | ((ctx: ConfigValueContext) => T);

/**
 * The same config **after** it resolves: every `ConfigValue<T>` is just `T`, because
 * `interpolateConfig` has already called it.
 *
 * **This is the half that lets `RmanConfig` be the author's type.** One type cannot answer both
 * "what may I write?" (a function is fine - rman calls it) and "what do I get?" (never a function -
 * it was already called), so it used to answer only the second, and writing a value function was a
 * compile error the docs themselves committed. Widening `RmanConfig` alone just moves the problem:
 * measured, six read sites needed a cast. The author's type widens and the *reader's* is computed
 * from it - one derived type, applied at `Package.config`, rather than a second one to keep in step
 * by hand.
 *
 * **Two guards, and each was measured by leaving it out.**
 *
 * - **Steps are named first.** A value function is recognised by its parameter, and
 *   `ConfigValueContext` carries an index signature - so `RunStepFn` is assignable to it and a
 *   `run.build.exec` function collapsed to its *return type*, leaving `RunService` nothing to call.
 * - **`CODE_SUBTREES` is skipped, at every level.** `plugins`/`commands`/`publishTargets` hold code
 *   all the way down, and the selector index (`[selector]: RmanConfig`) re-enters the config, so a
 *   top-level-only guard misses the copy inside a `"[*]"` block. Left out, the walk reached
 *   `Plugin.manifestProvider.versionScheme` and rewrote its **methods**: `smallestBump(): string`
 *   became `string`, `bumpFor`/`isValid`/`compare`/`next` became `{}`. A function with *fewer*
 *   parameters is assignable to one with more, so a zero-argument method matches the value-function
 *   pattern - which makes this transform unsafe over any object carrying methods, and the guard the
 *   only thing keeping one out of its way.
 *
 * Both lists are the runtime's own (`STEP_PATHS`' function types, `CODE_SUBTREES` itself), so the
 * type follows the rule rather than restating it - the drift `ScopedVars` already demonstrated is
 * not available here.
 */
export type Resolved<T> = T extends RunStepFn | RunConditionFn
  ? T
  : T extends (ctx: ConfigValueContext) => infer R
    ? R
    : T extends object
      ? { [K in keyof T]: K extends CodeSubtree ? T[K] : Resolved<T[K]> }
      : T;

/** `pkg.config`'s type: what every command reads, with the value functions already called. */
export type ResolvedConfig = Resolved<RmanConfig>;

/**
 * What a `${{ ... }}` expression can see - the bindings of the fresh global it is evaluated in.
 * Namespaced rather than a flat bag of loose names: one obvious place per fact, and room to add
 * helpers to `pkg`/`repository` later without crowding the global.
 *
 * Alongside these, **the config's own top-level keys are bound bare** (`${{ changelog.filePath }}`,
 * `${{ clean.include }}`) - see `interpolateConfig`. They are not listed here because they come
 * from the config being interpolated, not from this object; a name here wins over a config key of
 * the same name.
 *
 * **Trap: bare `${{ version }}` is the `version` *options block*, not the package's version
 * string** - that is `${{ pkg.version }}`. Same word, two different things, and the plain one
 * belongs to the config because every other config key is reachable that way.
 */
export interface ConfigScope {
  /** The package the config was resolved for - which is what lets one declaration at the root
   *  still say something package-specific. */
  pkg: PackageScope;
  repository: RepositoryScope;
  /** Paths, resolved against the package the config was resolved for. */
  file: FileScope;
  /**
   * The **contents** of a structured file - `${{ read('tsconfig.json').compilerOptions.outDir }}` -
   * where `file` answers only where one is. Resolved against `pkg.dirname` like `file`, so a
   * `"[*]"` block asks each package about its own; a repository-level file is reached through
   * `read(path.join(repository.dirname, ...))`.
   *
   * `.json`, `.yml`/`.yaml` and `.ini` by extension, or name it for a file that does not say
   * (`read('.npmrc', 'ini')`). **Throws** when the file is absent, as `file.resolve` does - compose
   * with `file.exists` when its absence is a case to handle.
   *
   * **A manifest is `pkg.manifest`, not this.** `read('package.json')` works and is the wrong
   * answer: which file a package's identity lives in belongs to the ecosystem, so that expression
   * is already wrong in a Cargo package sitting beside a Node one.
   *
   * The result is **deeply frozen and shared** - see `readStructuredFile`. Spread it to change it.
   */
  read: ReadFile;
  env: Record<string, string | undefined>;
  /** rman's own `semver`, for the arithmetic every release config eventually wants
   *  (`semver.major(pkg.version)`). */
  semver: typeof semver;
  /**
   * Node's own `node:path` - `${{ path.join(pkg.dirname, 'LICENSE') }}`, rather than gluing
   * strings with `+ "/" +` and getting a double separator or none.
   *
   * The platform's flavour, not `path.posix`, so a joined path is the one the shell on *this*
   * machine understands; `path.posix` and `path.win32` are reachable through it when a config
   * genuinely needs one of them (a Docker image path, say, which is always posix).
   */
  path: typeof path;
  /**
   * The checkout: branch, sha, whether the tree is dirty.
   *
   * **Top level, not `repository.git`** - which is where it used to be, and the move is the point.
   * `repository` shares its shape with `pkg` because the repository root *is* a package, and its
   * only other members (`monorepo`, `packages`, `package()`) say something about the repository as
   * a container of packages. A branch name says nothing about any package; it describes the
   * working tree every one of them happens to be sitting in - the same kind of ambient fact as
   * `env`, and it belongs beside it.
   *
   * **Read from git only if an expression actually asks**, then remembered for the whole run: every
   * command resolves config, and a repository that never mentions git must not pay for one. See
   * `Repository.configScope` for the getter, and `interpolateConfig` for why the context is built
   * from property descriptors rather than a spread - a spread would fire this getter on every
   * command, which is exactly what moving it up here risked.
   */
  git: GitScope;
}

/**
 * Evaluates every `${{ ... }}` expression in **every** string value of a resolved config, against
 * the package it was resolved for:
 *
 * ```yaml
 * "[*]":
 *   clean:
 *     include: ["build", "../../coverage/${{ pkg.basename }}"]
 *   publish:
 *     directory: build
 *     docker:
 *       image: "panates/${{ pkg.basename }}:${{ semver.major(pkg.version) }}"
 *   run:
 *     build:
 *       # the config's own keys are in scope, so this is not a second copy of "build"
 *       after: "cp README.md ${{ changelog.filePath }}/"
 * ```
 *
 * Every string, with no list of "interpolated keys" to memorize - a rule with exceptions is a rule
 * nobody remembers.
 *
 * The contents are **real JavaScript**, not a template mini-language, so there is no growing list
 * of substitutions to keep adding (`{{major}}`, `{{scope}}`, ...) - see `ConfigScope` for what is
 * in scope.
 *
 * **`${{ }}`, deliberately not `{{ }}`.** A config value may legitimately carry `{{...}}` meant for
 * something else entirely (`helm template --set tag={{.Values.tag}}`); with the plainer delimiter
 * rman would try to evaluate it. To emit a literal, let an expression produce it, the way GitHub
 * Actions does: `${{ '${{' }}`.
 *
 * A string that is *nothing but* one expression keeps the value's own type (`"${{ pkg.private }}"`
 * -> a boolean), since otherwise this could only ever produce strings and settings like
 * `run.<script>.skip` would be unreachable. Embedded in surrounding text it is stringified.
 *
 * Evaluation happens in a fresh V8 context holding only the scope's bindings. That is a clean
 * scope, **not a sandbox** - `node:vm` is explicitly not a security mechanism, and no sandbox is
 * called for here anyway: a `.rmanrc` that can say `exec: "..."` already runs arbitrary shell, so
 * the expression evaluator adds no trust boundary that wasn't already wide open.
 *
 * A failing expression throws with the config path that holds it, rather than being left in place:
 * silently passing through a mistake is how a config ends up quietly doing nothing.
 */
export interface InterpolateOptions {
  /** Config paths to leave entirely untouched - `DEFERRED_PATHS`, when the whole config is walked. */
  skip?: string[];
  /** Where `config` sits in the whole config, for a caller interpolating a fragment. */
  at?: string[];
}

/**
 * **Returns `Resolved<T>`, not `T`, because resolving is what it does.** Calling every value
 * function is half this function's job, so the type it hands back is the one where they are gone -
 * which is what makes `pkg.config` a `ResolvedConfig` without a cast anywhere between.
 */
export function interpolateConfig<T>(config: T, scope: ConfigScope, options?: InterpolateOptions): Resolved<T> {
  const skip = options?.skip ?? [];
  /**
   * Where `config` sits in the whole config, when a caller hands over a fragment rather than the
   * root - `version` interpolates its own `version.<slot>` value on its own, those three paths being
   * in `DEFERRED_PATHS`.
   *
   * It matters because the path is what decides whether a function is a value to compute or a step
   * to leave alone (`STEP_PATHS`). Without it, a fragment starts at the root and matches nothing, so
   * a function in a `version` hook was called while the hook was being *prepared* - measured, and it
   * failed inside the user's own code with `path.join` receiving undefined.
   */
  const base = options?.at ?? [];
  /**
   * Built from `scope`'s property **descriptors**, never `{ ...scope }`.
   *
   * A spread reads every property, so a lazy getter on the scope is no longer lazy the moment one
   * is added - and `git` is exactly that: it shells out to `git rev-parse`, and a spread here would
   * do it on `rman list`, `rman info` and every other command, in a repository whose config never
   * mentions git. (The same trap `pkg.targetVersion` documents from the other side: it is a
   * *throwing* getter, and being enumerable is what made a spread fire it.)
   */
  const context = vm.createContext(Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)));
  if (!config || typeof config !== 'object' || Array.isArray(config)) return walk(config, scope, context, base, skip);

  /**
   * The config's own top-level keys, readable bare: `${{ changelog.filePath }}`. So a value that
   * restates another - `after: "cp README.md ${{ changelog.filePath }}/"` - stops being a second
   * copy that drifts when the first one changes.
   *
   * Resolved **on demand**, one key at a time, and memoized. Interpolating the config in tree order
   * and handing an expression whatever was ready would make the answer depend on key order in the
   * file, which is exactly the kind of quiet wrongness this evaluator exists to prevent: a key
   * declared above would read as resolved and one below as raw. On demand, each key is resolved
   * when first read and the order in the file means nothing.
   */
  const resolved = new Map<string, unknown>();
  const resolving: string[] = [];
  /**
   * A cycle is **recorded here rather than thrown from the getter**, and that is not a style
   * choice: a host getter that throws inside a `vm` property interceptor has its exception
   * swallowed, and V8 then reports the global as absent - so a self-referencing key came out as
   * `publish is not defined`, which sends the reader looking for a missing key instead of a loop
   * (measured). The getter returns `undefined`, the resulting `ReferenceError` is caught below, and
   * this replaces it.
   */
  let cycle: Error | undefined;
  const resolve = (key: string): unknown => {
    if (resolved.has(key)) return resolved.get(key);
    if (resolving.includes(key)) {
      cycle ??= new Error(
        `Config expression forms a cycle: ${[...resolving, key].join(' -> ')}\n` +
          `  A value cannot be derived from itself, directly or through another key.`,
      );
      return undefined;
    }
    resolving.push(key);
    try {
      const chain = (config as Record<symbol, unknown>)[PREVIOUS_VALUES] as Record<string, PreviousValue> | undefined;
      const origins = (config as Record<symbol, unknown>)[ORIGINS] as Record<string, string> | undefined;
      const value = withOrigin(origins?.[key], () =>
        walkWithPrevious((config as Record<string, unknown>)[key], chain?.[key], scope, context, [...base, key], skip),
      );
      resolved.set(key, value);
      return value;
    } catch (e: any) {
      /** Not cleared: a cycle aborts the whole interpolation, and each level up would otherwise
       *  re-swallow its own replacement the same way - leaving it set lets the outermost frame,
       *  the one with a real stack to throw from, report it. */
      if (cycle) throw new Error(`${String(e?.message).split('\n')[0]}\n  ${cycle.message}`, { cause: e });
      throw e;
    } finally {
      resolving.pop();
    }
  };

  for (const key of Object.keys(config)) {
    /** A scope binding wins: `pkg`/`repository`/`env`/`semver` are not config keys, so nothing
     *  collides today, and a future key that did must not silently take over the namespace. */
    if (key in scope || !IDENTIFIER.test(key)) continue;
    Object.defineProperty(context, key, { enumerable: true, configurable: true, get: () => resolve(key) });
  }

  /** Built through the same memo the getters use, so every key is walked exactly once whether an
   *  expression asked for it first or the result did. */
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(config)) result[key] = resolve(key);
  /**
   * **The one cast in the whole two-view split, and it is here rather than at every read.** No type
   * can prove that a runtime walk turned `T` into `Resolved<T>`; this walk is what makes it true.
   * Putting it at this single return is what keeps `pkg.config` honest without a cast in any of the
   * commands - which is the arrangement the alternative (widening `RmanConfig` alone) gave up, six
   * read sites at a time.
   */
  return result as Resolved<T>;
}

/**
 * Config paths left untouched when a repository's config is first resolved, and evaluated only by
 * the command that runs them.
 *
 * `version`'s own hooks are the one place `${{ pkg.targetVersion }}` makes sense, and the version
 * being written is not known until `version` has computed its plan - long after the config was
 * resolved. Evaluating these eagerly would throw while merely *loading* the repository, so any
 * command at all would fail on a config that mentions it.
 */
export const DEFERRED_PATHS = ['version.before', 'version.exec', 'version.after'];

/**
 * Paths whose value is a **step** - something to run later - rather than a setting to compute now.
 * `*` matches one path segment (`run.<script>.exec`).
 *
 * This is what tells a step function from a value function, and the two live side by side in one
 * config:
 *
 * ```js
 * '[*]': {
 *   clean: { include: ({ vars, value }) => [...value, vars.buildDir] },   // a value: called here
 *   run: { build: { after: ({ pkg }) => copyDocs(pkg) } },                // a step: called by `run`
 * }
 * ```
 *
 * **The key decides, and it already did.** `run.build.exec: 'tsc -b'` is a shell command and
 * `publish.npm.directory: 'build'` is a path - not because of anything about the strings, but because of
 * where they sit. A function inherits the same rule, so nothing new has to be learned and no marker
 * has to be remembered. The alternative was inspecting the function (arity, parameter names), which
 * is the kind of guess `loadPlugins` refuses to make about a module's export for the same reason:
 * guessing wrong here means running build-time code while merely loading the repository, or
 * silently never running it.
 *
 * A **string** at one of these paths is still interpolated - `exec: 'tsc -b ${{ file.resolve(...) }}'`
 * has to keep working - so this is narrower than `DEFERRED_PATHS`, which skips its paths entirely.
 */
export const STEP_PATHS = [
  /** The bare-value shorthand: `run: { build: fn }` means `{ exec: fn }`, as `run: { build: 'cmd' }`
   *  means `{ exec: 'cmd' }`. Missing it made the two spellings disagree about *when* the function
   *  runs, which is worse than not supporting the short one at all. */
  'run.*',
  'run.*.before',
  'run.*.exec',
  'run.*.after',
  /** A condition, evaluated per package by `RunService` when the run reaches it. Called here
   *  instead, it collapsed to the boolean it happened to return at load time - and `parseIfExpr`
   *  then read that boolean as "no condition given", so the script ran unconditionally (measured). */
  'run.*.if',
  'version.before',
  'version.exec',
  'version.after',
];

/**
 * Keys whose **whole subtree** is code rather than config, so no function under them is a value to
 * compute.
 *
 * The three contribution keys, and each has to be here: an entry may be the *instance* itself, and
 * a `Plugin` is almost entirely functions - `manifestProvider.read`, `getWorkspace`,
 * `getBinPaths`, `versionPlanner` - while a command is often a bare factory and a publish target
 * carries `getPlan`/`applyPlan`.
 *
 * Measured twice, once per shape. With `plugins` walked like any other key, resolving the config
 * of a repository that named a plugin called that plugin's yargs builder with the config scope:
 * `Config function in "plugins[0].commands[0].builder" failed: cmd.option is not a function`. And
 * with `commands` left out of this list, a declarative command - which *is* a function - was
 * invoked with the interpolation scope instead of the application, so its handler closed over a
 * repository that was not one: `repository.getPackages is not a function`, from inside `clean`.
 *
 * These entries are loaded by `loadPlugins` and `cli.ts`, never read as settings.
 */
export const CODE_SUBTREES = ['plugins', 'commands', 'publishTargets'] as const;

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

/** A config key an expression could actually name. Anything else - a `"[selector]"` block, a
 *  `"lint:fix"` - is unreachable as a bare identifier anyway, so it is not bound. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The `file` namespace for one package's directory - see `FileScope`. */
/**
 * `read` in a `${{ ... }}` expression (and in a value function): a structured file's **contents**,
 * parsed - where `file` answers only where a path is.
 *
 * ```yaml
 * "[*]":
 *   run:
 *     build:
 *       exec: 'tsc --outDir ${{ read("tsconfig.json").compilerOptions.outDir }}'
 * ```
 *
 * `cache` is shared across every package (see `Repository.configScope`) and keyed by what the file
 * *is*, not merely where - so the same file read by twenty packages is parsed once, and a file rman
 * itself rewrites mid-run is re-read rather than remembered. See `readStructuredFile`.
 */
export function createReadScope(dirname: string, cache: Map<string, CachedFile>): ReadFile {
  return (target: string, format?: FileFormat): unknown => {
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error('read() needs a path - it was given ' + JSON.stringify(target));
    }
    return readStructuredFile(path.resolve(dirname, target), format, cache);
  };
}

/**
 * What `read` can parse.
 *
 * **`.env` is deliberately absent, and that is the durable part of this list**: `env` is already in
 * scope, and a `.env` file exists to be loaded *into* an environment by something else - a config
 * reading one as data would mean two different things called the environment.
 *
 * Nothing else is excluded on principle. `xml` arrived because a `pom.xml` or a `.csproj` holds a
 * version exactly the way a `package.json` does, and rman is language-agnostic; the earlier line
 * ("no new parsers") did not survive it, since xmldom *is* a new one.
 */
export type FileFormat = 'json' | 'yaml' | 'ini' | 'xml';

/** `read(path)`, or `read(path, 'ini')` for a file whose name does not say what it is (`.npmrc`). */
export type ReadFile = (target: string, format?: FileFormat) => unknown;

/** One parsed file, kept against the identity of the bytes it came from - see `readStructuredFile`. */
export interface CachedFile {
  /** `mtimeNs:size`. */
  stamp: string;
  value: unknown;
}

export function createFileScope(dirname: string): FileScope {
  const locate = (target: string): { path: string; found: boolean } => {
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error('file.exists()/file.resolve() need a path - they were given ' + JSON.stringify(target));
    }
    const resolved = path.resolve(dirname, target);
    return { path: resolved, found: fs.existsSync(resolved) };
  };
  return {
    exists(target: string): string {
      const { path: resolved, found } = locate(target);
      return found ? resolved : '';
    },
    resolve(target: string): string {
      const { path: resolved, found } = locate(target);
      if (!found) {
        throw new Error(
          `file.resolve("${target}") found nothing at ${resolved}\n` +
            `  Use file.exists() instead if its absence is a case to handle rather than a mistake.`,
        );
      }
      return resolved;
    },
    resolveFirst(...targets: string[]): string {
      if (!targets.length) throw new Error('file.resolveFirst() needs at least one path');
      for (const target of targets) {
        const { path: resolved, found } = locate(target);
        if (found) return resolved;
      }
      throw new Error(
        `file.resolveFirst() found none of: ${targets.map(t => `"${t}"`).join(', ')}\n` + `  Looked in ${dirname}.`,
      );
    },
  };
}

function walk(value: unknown, scope: ConfigScope, context: vm.Context, at: (string | number)[], skip: string[]): any {
  /** Compared on the key path rather than the value, so a deferred key's whole subtree - a single
   *  command or an array of them - is handed on untouched. */
  if (at.length && skip.includes(at.filter(p => typeof p === 'string').join('.'))) return value;
  if (typeof value === 'function') {
    /** Code, not a value: a step for `run`/`version` to call in its own time, or a plugin's own
     *  function. Carried through exactly as a command string would be - calling it here would run
     *  build-time work while merely *loading* the repository, which is the whole distinction the
     *  function form exists to draw. */
    if (isCodePath(at)) return value;
    return callValueFn(value as (arg: unknown) => unknown, context, at);
  }
  if (typeof value === 'string') return interpolateString(value, context, at);
  if (Array.isArray(value)) return value.map((item, i) => walk(item, scope, context, [...at, i], skip));
  if (value && typeof value === 'object') {
    const chain = (value as Record<symbol, unknown>)[PREVIOUS_VALUES] as Record<string, PreviousValue> | undefined;
    return withScopedVars(value as Record<string, unknown>, scope, context, at, skip, () => {
      const result: Record<string, unknown> = {};
      const origins = (value as Record<symbol, unknown>)[ORIGINS] as Record<string, string> | undefined;
      for (const [key, item] of Object.entries(value)) {
        result[key] = withOrigin(origins?.[key], () =>
          walkWithPrevious(item, chain?.[key], scope, context, [...at, key], skip),
        );
      }
      return result;
    });
  }
  return value;
}

/**
 * Runs `body` with `vars` scoped to this node: **a fresh copy at every level**, with the node's own
 * `vars` block - if it declares one - merged over what the level above resolved to.
 *
 * ```yaml
 * vars: { x: 1 }
 * run:
 *   vars: { x: 2 }
 *   clean: { before: '${{ read(vars.x + ".json") }}' }     # 2.json
 *   build:
 *     vars: { x: 3 }
 *     before: '${{ read(vars.x + ".json") }}'              # 3.json
 * ```
 *
 * **Copied at every node, not only where a `vars` block appears**, and that is the difference
 * between scoping and leaking: a value function is handed this object, so one that writes to it
 * (`vars.built = Date.now()`) must not be writing into the level above. Without a copy per node,
 * a write inside `run.build` would land in `run`'s object and `run.clean` would see it. Merged per
 * key rather than replaced, so redeclaring one var keeps the rest - the rule the top-level `vars`
 * has always followed.
 *
 * The node's own block is resolved **against the outer scope** before being installed, so
 * `vars: { out: '${{ vars.x }}/dist' }` reads the `x` it is refining rather than itself.
 *
 * Installed as a plain property over the context's lazy top-level getter and restored afterwards -
 * `walk` is depth-first and synchronous, so the window is exactly this subtree, and a value function
 * called inside it reads the same object through its prototype.
 */
function withScopedVars<T>(
  node: Record<string, unknown>,
  scope: ConfigScope,
  context: vm.Context,
  at: (string | number)[],
  skip: string[],
  body: () => T,
): T {
  /**
   * **A `vars` block does not scope itself.** Resolving one walks its own values, and without this
   * that walk asks for the scope it is in the middle of producing - which the cycle guard catches
   * and reports as `vars -> vars`. It recovered (the guard returns `undefined`, so the block simply
   * saw no outer scope, which is what it should see anyway), but it left the cycle *flag* set, and
   * the next genuine error in that key came out wearing `Config expression forms a cycle` - found by
   * running a real shared config, whose `[...value]` mistake arrived with a loop attached that had
   * nothing to do with it.
   *
   * Any path with a `vars` segment is inside a block: its contents are values, not config nodes.
   */
  if (at.some(segment => segment === VARS_KEY)) return body();

  const outer = context[VARS_KEY] as Record<string, unknown> | undefined;
  const own = node[VARS_KEY];
  /** Nothing to shadow and nothing to protect: a node with no object below it can hold no function
   *  either, so the copy would be pure cost. */
  if (own === undefined && !hasObjectChild(node)) return body();

  const resolvedOwn = own === undefined ? undefined : walk(own, scope, context, [...at, VARS_KEY], skip);
  const scoped = { ...outer, ...(isPlainObject(resolvedOwn) ? resolvedOwn : undefined) };

  const previous = Object.getOwnPropertyDescriptor(context, VARS_KEY);
  Object.defineProperty(context, VARS_KEY, { value: scoped, enumerable: true, configurable: true, writable: true });
  try {
    return body();
  } finally {
    if (previous) Object.defineProperty(context, VARS_KEY, previous);
    else delete context[VARS_KEY];
  }
}

function hasObjectChild(node: Record<string, unknown>): boolean {
  for (const item of Object.values(node)) {
    if (typeof item === 'function') return true;
    if (item && typeof item === 'object') return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The one key that scopes rather than configures - see `withScopedVars`. Reserved at **every**
 *  level, which costs a script that would have been called `vars`: `run.vars` is a scope, not a
 *  script. Nothing enumerates `run`'s keys as a list of script names, so the cost stops there. */
const VARS_KEY = 'vars';

/**
 * The file the key being walked was written in, for the errors below to name.
 *
 * A config is merged from several files before anything reads it - a directory's own forms, an
 * `extends` base, every `"[selector]"` block, one layer per directory - so `version.commitMessage`
 * alone does not say where to go and look. `mergeConfig` records the file per key (`ORIGINS`); this
 * is the depth-first cursor over that, kept in a module variable rather than threaded through
 * `walk`'s signature because every error site would otherwise have to carry a parameter it only
 * passes on.
 *
 * Nested keys inherit the enclosing file when the merge recorded none of their own, which is what a
 * nested object in one file means.
 */
let currentOrigin: string | undefined;

function withOrigin<T>(origin: string | undefined, body: () => T): T {
  const outer = currentOrigin;
  if (origin !== undefined) currentOrigin = origin;
  try {
    return body();
  } finally {
    currentOrigin = outer;
  }
}

/** `"version.commitMessage" (.rmanrc.yml)`, or just the path when nothing recorded a file - a
 *  caller interpolating a fragment it built itself, say. Relative to the repository when it sits
 *  inside one, since an absolute path is noise in a message about the repository you are in. */
function describeAt(at: (string | number)[]): string {
  const where = at.length ? formatPath(at) : 'the config root';
  return currentOrigin ? `${where}" (${shortenOrigin(currentOrigin)})` : `${where}"`;
}

function shortenOrigin(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/**
 * Walks one key of an object with **`value` bound** to whatever the layers below it resolved to.
 *
 * Bound on the interpolation context rather than passed as an argument, because an expression reads
 * it as a global (`"${{ [...value, 'x'] }}"`) - a function then picks the same binding up through
 * its prototype, so the two spellings cannot disagree about what `value` is. It was function-only
 * at first, on the reasoning that a string cannot carry an array back; that was wrong, since a
 * string which is *nothing but* one expression keeps the value's own type.
 *
 * **Always bound, even with nothing underneath.** Left unbound, an expression naming it fails with
 * V8's `value is not defined`, which reads as "there is no such thing" rather than "nothing below
 * this layer set it" - two different mistakes needing two different fixes. With nothing underneath
 * it is `unsetValue()` rather than `undefined` - see there.
 *
 * The chain resolves bottom-up, so a layer deriving from a layer that itself derived from something
 * is handed the finished value rather than a half-resolved expression.
 */
function walkWithPrevious(
  item: unknown,
  previous: PreviousValue | undefined,
  scope: ConfigScope,
  context: vm.Context,
  at: (string | number)[],
  skip: string[],
): unknown {
  const resolved = previousValue(
    previous === undefined ? undefined : walkWithPrevious(previous.value, previous.previous, scope, context, at, skip),
    at,
  );

  const outer = Object.getOwnPropertyDescriptor(context, VALUE_KEY);
  /** A getter, so the catch below can tell whether the value **actually read `value`**: the hint is
   *  irrelevant to any other failure, and attaching it anyway is the send-the-reader-to-the-wrong-
   *  place mistake it exists to prevent. Recorded, never matched on V8's wording. */
  let wasRead = false;
  Object.defineProperty(context, VALUE_KEY, {
    configurable: true,
    enumerable: true,
    get: () => {
      wasRead = true;
      return resolved;
    },
  });
  try {
    return walk(item, scope, context, at, skip);
  } catch (e: any) {
    /**
     * **The hint is only about *reading* `value`**, so it is attached only when the value did -
     * recorded through the getter above, never matched on V8's wording. Attaching it to any other
     * failure is the send-the-reader-to-the-wrong-place mistake it exists to prevent.
     *
     * The sentence itself comes from `unsetValue`, which knows the key and throws at the exact
     * point of misuse; all this adds is the case the sentinel cannot catch, where a value reads
     * `value` and fails for a reason of its own. `rmanValueHint` keeps a rethrow from stacking it
     * twice as the error passes back up through the enclosing keys.
     */
    if (wasRead && isUnsetValue(resolved) && !e?.rmanValueHint) {
      e.rmanValueHint = true;
      e.message = `${e.message}\n  Note: nothing below this layer sets "${describeAt(at)}, so \`value\` is empty.`;
    }
    throw e;
  } finally {
    if (outer) Object.defineProperty(context, VALUE_KEY, outer);
    else delete context[VALUE_KEY];
  }
}

/** What a layer deriving from the one below it reads - see `walkWithPrevious`. */
const VALUE_KEY = 'value';

/**
 * Whether a function at `at` is **code** - a step to run later, or part of a plugin - rather than a
 * value to compute now.
 *
 * Array indices are dropped before matching, so a function inside a *list* of steps is still a
 * step; `*` in a `STEP_PATHS` entry matches any one segment (`run.<script>.exec`).
 */
function isCodePath(at: (string | number)[]): boolean {
  const segments = at.filter((p): p is string => typeof p === 'string');
  if ((CODE_SUBTREES as readonly string[]).includes(segments[0]!)) return true;
  return STEP_PATHS.some(pattern => {
    const parts = pattern.split('.');
    return parts.length === segments.length && parts.every((part, i) => part === '*' || part === segments[i]);
  });
}

/**
 * Calls a **value** function: the JS spelling of a `${{ }}` expression, and it answers the same
 * question at the same moment.
 *
 * It receives one object carrying everything an expression can name - `pkg`, `repository`, `file`,
 * `env`, `semver`, `path`, plus the config's own top-level keys - and, in addition, **`value`**: what
 * this key resolved to in the layers underneath, which is what makes a derived value possible
 * without restating the base.
 *
 * Built with the interpolation context as its **prototype**, not copied from it. The top-level keys
 * are lazy getters (`resolve`, memoized, so key order in the file means nothing and a cycle is
 * reported rather than half-resolved); spreading them into a new object would fire every one of
 * them on every call, including the ones a function never reads - and one of those throwing would
 * blame the wrong key.
 *
 * **It must compute and return, never act.** This runs while the repository's config resolves,
 * which *every* command does - so a value function that writes a file writes it on `rman list`,
 * `rman info` and `rman config` too, N times for N packages, with no command having asked for
 * anything. That is the same reason `FileScope` offers no way to change anything. Work goes in a
 * step, which is the one thing rman runs on purpose and which can also be a function.
 */
function callValueFn(fn: (arg: unknown) => unknown, context: vm.Context, at: (string | number)[]): unknown {
  /** `value` arrives through the prototype, bound by `walkWithPrevious` for exactly this key - so
   *  nothing here may *read* it. Passing it in as an argument did, which tripped the "was it read"
   *  getter before the function ran and put the `value` hint on every unrelated failure (caught by
   *  the spec that exists for precisely that). */
  const arg = Object.create(context);
  /**
   * A getter only so the catch below can tell whether the function **actually read `value`**.
   *
   * Without that, the "value is undefined" hint went out with *every* failure of a first-layer
   * function - a frozen-object `TypeError` from `read()` arrived wearing advice about spreading an
   * inherited list, which is precisely the send-the-reader-to-the-wrong-place mistake the hint
   * exists to prevent. Recorded rather than inferred from the message, because matching on V8's
   * wording is the other way to get this wrong.
   */
  try {
    return fn(arg);
  } catch (e: any) {
    /** The `value` hint comes from `walkWithPrevious`, which wraps this call and is the one place
     *  that knows whether `value` was read - so the expression spelling gets the same sentence. */
    throw new Error(`Config function in "${describeAt(at)} failed: ${e?.message}`, { cause: e });
  }
}

function interpolateString(value: string, context: vm.Context, at: (string | number)[]): unknown {
  if (!value.includes('${{')) return value;
  const found = [...value.matchAll(EXPRESSION)];
  if (!found.length) return value;
  /** Counted rather than matched with an anchored `^...$` regex: a lazy quantifier still backtracks
   *  to satisfy an end anchor, so `"${{ a }} and ${{ b }}"` looked like *one* expression whose body
   *  ran from `a` to `b`, brace-ends and all - invalid JavaScript. */
  const soleExpression = found.length === 1 && found[0][0] === value.trim();
  // Alone, a nullish result is just "this setting is unset" - a legitimate answer.
  if (soleExpression) return evaluate(found[0][1], value, context, at);
  return value.replace(EXPRESSION, (_, expr: string) => {
    const result = evaluate(expr, value, context, at);
    /** Embedded in text, though, it never is: splicing in the word "undefined" produces a path or
     *  tag like `app:undefined` that looks plausible and is wrong - the exact silent-mistake shape
     *  this evaluator exists to avoid. `?? 'fallback'` says what was meant. */
    if (result === undefined || result === null) {
      throw new Error(
        `Expression in "${describeAt(at)} is ${result} inside a string: ${value.trim()}\n` +
          `  \${{${expr}}} has no value here - give it a fallback (\${{${expr.trim()} ?? '...'}}).`,
      );
    }
    return String(result);
  });
}

/** Names the config path as well as the expression: an error saying only "x is not defined" sends
 *  the reader hunting through a file that may hold dozens of them. */
function evaluate(expr: string, source: string, context: vm.Context, at: (string | number)[]): unknown {
  try {
    return vm.runInContext(expr, context, { timeout: EXPRESSION_TIMEOUT });
  } catch (e: any) {
    throw new Error(`Invalid expression in "${describeAt(at)}: ${source.trim()}\n  ${e?.message ?? e}`, { cause: e });
  }
}

function formatPath(at: (string | number)[]): string {
  return at.reduce<string>(
    (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : String(part)),
    '',
  );
}

/** Guards against an expression that never returns (`while(true)`) taking the whole command with
 *  it - a typo, not an attack, but the failure mode is identical. */
const EXPRESSION_TIMEOUT = 1000;

/**
 * Reads and parses one structured file, memoized against **the identity of its contents** rather
 * than its path alone: the cache key is `mtimeNs:size`.
 *
 * Both halves of that were chosen against a measurement.
 *
 * - **A stat rather than a re-read**: `statSync` is 1.3µs where `readFileSync` + `JSON.parse` is
 *   16.1µs on a 2KB manifest - so the check costs a thirteenth of what it saves, and the same file
 *   read by twenty packages is parsed once. (`interpolateConfig` runs once *per package*, so a
 *   cache living in one pass would not have helped across them at all.)
 * - **Keyed on the stat rather than held for the run**: rman writes JSON files while it is running
 *   - `version` rewrites every bumped manifest, then re-interpolates its own deferred hooks. A
 *   cache that only remembered the path would hand those back as they were before the write.
 *   `mtimeNs` is nanoseconds, so a rewrite within the same millisecond does not slip through; the
 *   size is in the key as well because it costs nothing.
 *
 * **Frozen, deeply, once on the way into the cache.** Every package is handed the same object, so
 * one config mutating it would quietly change what the next package sees - the reason `pkg.manifest`
 * has always been a copy. Freezing is better than copying here: a copy costs 5.6µs on *every* call,
 * freezing costs ~1µs *once*, and it turns the mistake into a `TypeError` instead of an effect at a
 * distance. A caller that wants to change something spreads it first.
 */
function readStructuredFile(file: string, format: FileFormat | undefined, cache: Map<string, CachedFile>): unknown {
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(file, { bigint: true });
  } catch {
    throw new Error(
      `read("${path.basename(file)}") found nothing at ${file}\n` +
        `  Use file.exists() first if its absence is a case to handle rather than a mistake.`,
    );
  }
  if (stat.isDirectory()) throw new Error(`read() was given a directory, not a file: ${file}`);

  const stamp = `${stat.mtimeNs}:${stat.size}`;
  const cached = cache.get(file);
  if (cached?.stamp === stamp) return cached.value;

  const resolved = format ?? formatOf(file);
  const text = fs.readFileSync(file, 'utf-8');
  let value: unknown;
  try {
    value = parseStructured(text, resolved);
  } catch (e: any) {
    /** The parser's own message says what is wrong with the syntax but never which file it was
     *  reading - and an expression can name several. */
    throw new Error(`read("${path.basename(file)}") could not parse ${file} as ${resolved}: ${e?.message}`, {
      cause: e,
    });
  }
  deepFreeze(value);
  cache.set(file, { stamp, value });
  return value;
}

/** The extension decides, because the caller already wrote it - naming the parser as well would
 *  restate it and let the two disagree (`json("x.yml")`). A name that says nothing takes the
 *  explicit argument instead. */
function formatOf(file: string): FileFormat {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.ini') return 'ini';
  if (XML_EXTENSIONS.has(ext)) return 'xml';
  throw new Error(
    `read() cannot tell what "${path.basename(file)}" is from its name.\n` +
      `  Name the format: read("${path.basename(file)}", "json" | "yaml" | "ini" | "xml").`,
  );
}

/** The XML family worth recognizing by name: a project file is XML whatever its extension calls
 *  itself, and `.csproj`/`.pom` are what a .NET or Maven repository actually holds. Anything else
 *  still reads with an explicit `read(p, 'xml')`. */
const XML_EXTENSIONS = new Set(['.xml', '.csproj', '.vbproj', '.fsproj', '.props', '.targets', '.nuspec', '.plist']);

function parseStructured(text: string, format: FileFormat): unknown {
  if (format === 'json') return JSON.parse(text);
  /** `load`, not `loadAll`: a multi-document stream has no single value to be, and js-yaml says so
   *  clearly enough ("expected a single document in the stream") to leave alone. */
  if (format === 'yaml') return yaml.load(text);
  if (format === 'xml') return parseXml(text);
  return ini.parse(text);
}

/**
 * A **DOM**, not an object - and the asymmetry with the other three formats is the honest shape
 * rather than an omission.
 *
 * XML has no lossless object form: an element can repeat, carry attributes and hold text at the
 * same time, so any flattening has to pick a convention (`$`? `_text`? array-or-not?) and be wrong
 * for somebody. A DOM is the shape XML actually has, so a config reads it the way every other XML
 * tool does:
 *
 * ```yaml
 * version: '${{ read("pom.xml").getElementsByTagName("version")[0].textContent }}'
 * ```
 *
 * **Freezing it is safe** - measured, not assumed: a frozen `@xmldom/xmldom` document still answers
 * `getElementsByTagName` for a tag first asked about *after* the freeze (the live-collection case
 * that would have broken it), reads attributes, resolves namespaces, walks `childNodes` and
 * serialises back.
 */
function parseXml(text: string): unknown {
  /** xmldom reports a malformed document through a handler and otherwise carries on with whatever
   *  it could salvage - so without this, a broken file would come back as a half-parsed DOM and the
   *  expression reading it would simply find nothing. `read()` throws for a broken JSON file; it has
   *  to throw for this one too. */
  const problems: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') problems.push(message.split('\n')[0]);
    },
  }).parseFromString(text, 'text/xml');
  if (problems.length) throw new Error(problems[0]);
  return doc;
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
}

/**
 * What a layer is handed as `value`: **the list form of whatever is underneath it.**
 *
 * `value` exists for one job - extending what a closer layer inherited, the general form of `+key`,
 * and `+key` only ever meant append. So the shape a spread wants is the shape to hand over:
 * `[...value, 'x']` works with no guard whether the layers below said nothing, said `'build'`, or
 * said `['build']`.
 *
 * **Coercing a scalar into a one-element list is not a guess about the key's type.** Every key this
 * is reached for is declared `X | X[]` - `clean.include`, `clean.exclude`, `version.stamp`,
 * `version.before`/`.exec`/`.after` - where the list is the type and the scalar is *shorthand*.
 * `CleanService` and `RunService` already normalize it; doing it here as well decides nothing new.
 * And spreading a string into its characters, which is what handing the raw value over did, is not
 * something any key wants.
 *
 * It reads as the scalar wherever a scalar is what makes sense, through `Symbol.toPrimitive`:
 * `` `${value}-x` `` is `'build-x'` and `value + 1` is `6`. A *list* underneath refuses both, since
 * splicing `a,b` into a sentence is a mistake worth naming; so does nothing-underneath.
 *
 * **A boolean is handed over as itself**, the one carve-out, because it is never a list nor a
 * list's shorthand - and an object cannot be fixed up for it: `!value` and `value ? :` use
 * ToBoolean, which has no hook and answers `true` for every object, so a wrapped `false` would read
 * as `true`. Measured. `[...value]` on one then throws, which is right - spreading a boolean means
 * nothing.
 *
 * **The cost, stated rather than hidden: strict equality and string methods on an inherited
 * scalar.** `value === 'build'` is `false` and `value.includes('bui')` is `false` (an array's
 * `includes` matches elements, not substrings). `value == 'build'`, `` `${value}` === 'build' `` and
 * `String(value).includes('bui')` all work, and `value.length` is the number of layers' worth of
 * entries rather than a string's length. That is the trade for the append case never needing a
 * guard; `value` was introduced for the append case.
 */
function previousValue(raw: unknown, at: (string | number)[]): unknown {
  /** Never a list, and unfixable as one - see above. */
  if (typeof raw === 'boolean') return raw;
  const list = raw === undefined ? [] : Array.isArray(raw) ? [...raw] : [raw];
  Object.defineProperty(list, UNSET_MARKER, { value: raw === undefined });
  return Object.defineProperty(list, Symbol.toPrimitive, {
    value: (hint: string) => {
      if (raw === undefined) {
        throw unusable(at, 'nothing below this layer sets it, so it is empty', "`value ?? ''`, `value ?? 0`");
      }
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw unusable(
          at,
          `the layer below it is ${Array.isArray(raw) ? 'a list' : 'an object'}`,
          '`value.join(", ")` for a list',
        );
      }
      return hint === 'string' ? String(raw) : raw;
    },
  });
}

/** The one sentence both refusals share: what was asked for, why it cannot be done, what to write
 *  instead. Marked `rmanValueHint` so `walkWithPrevious`'s catch leaves it alone - that note exists
 *  to explain an empty `value` to an error that does not mention it, and this error *is* that
 *  explanation. */
function unusable(at: (string | number)[], because: string, instead: string): Error {
  const error: any = new Error(
    `\`value\` cannot be used as a string or a number here - ${because}, for "${describeAt(at)}. ` +
      `It spreads as a list (\`[...value, x]\`); to use it as something else, say what it should be - ${instead}.`,
  );
  error.rmanValueHint = true;
  return error;
}

/** Whether `value` stands for "no layer underneath set this key" - by the marker `previousValue`
 *  puts on it, never by emptiness, since a layer may legitimately resolve to `[]`. */
function isUnsetValue(value: unknown): boolean {
  return Array.isArray(value) && (value as any)[UNSET_MARKER] === true;
}

const UNSET_MARKER = Symbol('rman.valueUnset');

/** The `CODE_SUBTREES` entries as a type, so the runtime list and `Resolved`'s guard cannot name
 *  different keys. */
type CodeSubtree = (typeof CODE_SUBTREES)[number];
