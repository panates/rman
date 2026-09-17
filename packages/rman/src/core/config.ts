import fs from 'fs';
import * as yaml from 'js-yaml';
import { createRequire } from 'module';
import path from 'path';
import semver from 'semver';
import { pathToFileURL } from 'url';
import vm from 'vm';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { assertNoSelectorExtends, EXTENDS_KEY, resolveExtends } from './extends-config.js';
import { finalizeConfig, mergeConfig } from './merge-config.js';

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

const requireJsConfig = createRequire(import.meta.url);

/**
 * Loads `file`'s config object. Tries `require()` first - not just an optimization: a CommonJS
 * module's `module.exports` is more reliably observed this way than through dynamic `import()`'s
 * CJS-interop synthesis, which some ESM loader hooks (e.g. ts-node/swc-node-style transpilers
 * registered via `--import`) can end up short-circuiting into an empty object. `require()` throws
 * `ERR_REQUIRE_ESM` for a genuinely-ESM file (`.mjs`, or `.js` under `"type": "module"`) - only
 * then does this fall back to `import()`, the one case that actually needs it. Either path can
 * hand back an ES module namespace instead of a plain object (Node's `require(esm)` support does
 * this too, not just `import()`), so `.default` is preferred whenever present.
 */
async function loadJsConfig(file: string): Promise<any> {
  let mod: any;
  try {
    mod = requireJsConfig(file);
  } catch (e: any) {
    if (e?.code !== 'ERR_REQUIRE_ESM') throw e;
    mod = await import(pathToFileURL(file).href);
  }
  return mod?.default ?? mod;
}

/**
 * Reads the rman configuration defined at a single directory level, merging
 * (in increasing precedence): `package.json#rman`, `.rmanrc.yml`, `.rmanrc`,
 * then `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js` (whichever exist, in that order).
 */
export async function readDirConfig(dirname: string): Promise<RmanConfig> {
  const result: RmanConfig = {};
  /** The file an `extends` in this directory resolves relative to. The last form that actually
   *  declared one wins, which matters only for the unusual directory holding several. */
  let extendsFrom = path.join(dirname, '.rmanrc');

  const pkgJsonFile = path.join(dirname, 'package.json');
  if (fs.existsSync(pkgJsonFile)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
    if (pkgJson && typeof pkgJson.rman === 'object') {
      assertNoSelectorExtends(pkgJson.rman, pkgJsonFile);
      if (EXTENDS_KEY in pkgJson.rman) extendsFrom = pkgJsonFile;
      mergeConfig(result, pkgJson.rman);
    }
  }

  const ymlFile = path.join(dirname, '.rmanrc.yml');
  if (fs.existsSync(ymlFile)) {
    const obj = yaml.load(fs.readFileSync(ymlFile, 'utf-8'));
    if (obj && typeof obj === 'object') {
      assertNoSelectorExtends(obj as RmanConfig, ymlFile);
      if (EXTENDS_KEY in obj) extendsFrom = ymlFile;
      mergeConfig(result, obj as Record<string, any>);
    }
  }

  const rcFile = path.join(dirname, '.rmanrc');
  if (fs.existsSync(rcFile)) {
    const obj = JSON.parse(fs.readFileSync(rcFile, 'utf-8'));
    if (obj && typeof obj === 'object') {
      assertNoSelectorExtends(obj, rcFile);
      if (EXTENDS_KEY in obj) extendsFrom = rcFile;
      mergeConfig(result, obj);
    }
  }

  for (const jsFileName of JS_CONFIG_FILES) {
    const jsFile = path.join(dirname, jsFileName);
    if (fs.existsSync(jsFile)) {
      const obj = await loadJsConfig(jsFile);
      if (obj && typeof obj === 'object') {
        assertNoSelectorExtends(obj, jsFile);
        if (EXTENDS_KEY in obj) extendsFrom = jsFile;
        mergeConfig(result, obj);
      }
    }
  }

  /** Resolved per directory, once its own forms have been combined: `extends` is the base every
   *  one of them sits on, and the directory chain then layers on top as it always did. Each form
   *  was checked for a misplaced `extends` as it was read, so that error can name the file holding
   *  it rather than whichever form happened to declare the real one. */
  return resolveExtends(result, extendsFrom);
}

/**
 * Resolves the effective config for the package at `targetDir`, cascading from `rootDir` down to
 * it (inclusive) - each directory level overrides the ones above it, the way tsconfig's `extends`
 * chain does.
 *
 * Every level contributes in two ways, and the difference is the whole model:
 *
 * - **Unmarked keys configure the package of the directory that declares them.** The root's own
 *   `.rmanrc` therefore configures the *root package* - which is where repo-wide settings
 *   (`packageManager`, `allowBranch`, `version.*`, `githubRelease.*`) are read from anyway - and
 *   not, silently, every package under it.
 * - **A `"[selector]"` block configures the packages it names** - `"[*]"` for all of them (the root
 *   included), `"[ws:*]"` for every one but the root, `"[/]"` for the root alone, `"[*-dialect]"`
 *   for a glob over package names. See `parseSelector`. This is the only way a directory speaks
 *   about anything but its own package.
 *
 * Splitting the two matters because the same key means different things to the two audiences. The
 * clearest case is `run.<script>.postScript`: on a package it's that package's build hook, run in
 * its own directory; on the root it's a repo-wide bookend run once at the repository root. A
 * cascade that fed one declaration to both ran a package-relative command (`node
 * ../../support/postbuild.cjs`) at the root, where it cannot resolve.
 *
 * `packageName` is what selectors match against; without it, selector blocks contribute nothing at
 * all. The root package passes its own, since `"[/]"` and `"[*]"` speak to it.
 */
export async function resolveConfig(
  rootDir: string,
  targetDir: string,
  cache: Map<string, RmanConfig> = new Map(),
  packageName?: string,
): Promise<RmanConfig> {
  const result: RmanConfig = {};
  const target = path.resolve(targetDir);
  /** The root *package* is the one whose directory is the repository root - no other test is
   *  needed, and none would be as reliable: a name can be anything. In a single-package repository
   *  that is the only package, so `"[/]"` reaches it and `"[ws:*]"` reaches nothing. */
  const isRoot = target === path.resolve(rootDir);
  for (const dir of dirChain(rootDir, targetDir)) {
    let local = cache.get(dir);
    if (!local) {
      local = await readDirConfig(dir);
      cache.set(dir, local);
    }
    // A directory holding a package speaks for that package only - which is what keeps the root's
    // own config off every package under it. A directory that holds none (an intermediate
    // `packages/`, say) has no package to speak for, so its unmarked config can only mean
    // "everything below" and still cascades.
    const ownsAPackage = fs.existsSync(path.join(dir, 'package.json'));
    const speaksForTarget = !ownsAPackage || path.resolve(dir) === target;
    /**
     * `vars` is the **one** unmarked key that cascades past the package its directory speaks for,
     * and it is not a hole in that rule - it is a key the rule was never about. The rule exists
     * because a setting means different things to the two audiences (`run.build.after` on the root
     * is a repo-wide bookend, on a package its own hook), so one declaration cannot serve both.
     * `vars: {x: 1}` means the number 1 to everyone; there is no second audience to be wrong for.
     *
     * Merged *before* this directory's selector blocks, so `"[*]": {vars: ...}` - which names the
     * packages explicitly - overrides the same directory's plainer statement.
     */
    if (!speaksForTarget && local.vars !== undefined) mergeConfig(result, { vars: local.vars });
    // Selectors next, so a directory's own unmarked config still wins over a selector declared
    // alongside it - "this package" is a more specific statement than "packages matching a glob".
    if (packageName) {
      for (const block of matchingSelectors(local, packageName, isRoot)) mergeConfig(result, block);
    }
    if (speaksForTarget) mergeConfig(result, stripSelectors(local));
  }
  /** Every layer has had its turn, so an append still outstanding has nothing left to attach to
   *  and becomes the value itself. Done here rather than per layer: until the chain is finished,
   *  the key it appends to may still be coming. */
  return finalizeConfig(result);
}

/** A config key naming packages rather than settings: `"[*]"`, `"[/]"`, `"[ws:*]"`, `"[pkg-a]"`. The
 *  brackets are what keep this space from colliding with real config keys - no setting starts with
 *  one - and in YAML they also mean the key always needs quoting (`"[*]":`), since a bare `[*]`
 *  parses as a flow sequence. */
export function isSelectorKey(key: string): boolean {
  return key.length > 2 && key.startsWith('[') && key.endsWith(']');
}

/**
 * **Which packages a selector speaks for.** Three audiences, because a repository has three:
 *
 * | | |
 * | --- | --- |
 * | `"[/]"` | the **root package** only |
 * | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | **every** package the glob matches, root included |
 * | `"[ws:*]"`, `"[workspace:pkg-*]"` | every **non-root** package the glob matches |
 *
 * `/` for the root because that is what a repository root is called everywhere else, and it cannot
 * collide with a package name. `ws:` is a qualifier on the glob rather than a separate spelling of
 * `*`, so `"[ws:pkg-*]"` means what it looks like.
 *
 * **`"[*]"` includes the root, and that is a change from how it used to read.** Before, selectors
 * were not applied to the root at all, so `"[*]"` silently meant "the workspace packages" - a
 * catch-all with an exception nothing in the syntax mentioned. The three names above say which
 * audience is meant; `"[ws:*]"` is the old behaviour, now spelled.
 */
export function parseSelector(key: string): { scope: 'root' | 'all' | 'workspace'; test: (name: string) => boolean } {
  const inner = key.slice(1, -1);
  if (inner === ROOT_SELECTOR_INNER) return { scope: 'root', test: () => true };
  for (const prefix of WORKSPACE_PREFIXES) {
    if (inner.startsWith(prefix)) {
      const re = globToRegExp(inner.slice(prefix.length));
      return { scope: 'workspace', test: name => re.test(name) };
    }
  }
  const re = globToRegExp(inner);
  return { scope: 'all', test: name => re.test(name) };
}

/** The glob inside a selector key, as a `RegExp` anchored at both ends - so `"[*-dialect]"` matches
 *  `mysql-dialect` but not `my-dialect-helper`. Glob rather than regex, to match every other
 *  pattern in rman (`allowBranch`, `changelog.tagPattern`, `clean.include`). */
export function selectorToRegExp(key: string): RegExp {
  return globToRegExp(key.slice(1, -1));
}

/**
 * Every selector block in `config` that speaks for this package, in increasing precedence.
 *
 * Order, lowest first: **`"[*]"`, then a catch-all `"[ws:*]"`, then the rest in declaration
 * order** - so narrowing the audience wins over the widest one, a named package or `"[/]"` wins
 * over both, and two equally specific globs resolve by the order they were written in. A catch-all
 * is ranked rather than left to declaration order on purpose: where you happen to write "everything"
 * should not decide whether it beats a rule about one package.
 */
function matchingSelectors(config: RmanConfig, packageName: string, isRoot: boolean): RmanConfig[] {
  const matches: [number, RmanConfig][] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!isSelectorKey(key) || !value || typeof value !== 'object') continue;
    const { scope, test } = parseSelector(key);
    if (scope === 'root' && !isRoot) continue;
    if (scope === 'workspace' && isRoot) continue;
    if (!test(packageName)) continue;
    matches.push([selectorRank(key), value as RmanConfig]);
  }
  return matches.sort((a, b) => a[0] - b[0]).map(([, block]) => block);
}

/** 0 for `"[*]"`, 1 for a catch-all workspace selector, 2 for anything that names something. Equal
 *  ranks keep their declaration order, since `Array.prototype.sort` is stable. */
function selectorRank(key: string): number {
  if (key === CATCH_ALL) return 0;
  const inner = key.slice(1, -1);
  return WORKSPACE_PREFIXES.some(prefix => inner === `${prefix}*`) ? 1 : 2;
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

const CATCH_ALL = '[*]';

/** `"[/]"` - the root package, spelled the way a repository root is spelled everywhere else, and
 *  unable to collide with a package name. */
const ROOT_SELECTOR_INNER = '/';

/** Both spellings of "the workspace packages, not the root". The long one reads in a config file
 *  someone else has to understand; the short one is what gets typed. */
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
   * Which ecosystem this package belongs to - `'node'` for one read by `@rman/node`, empty when no
   * plugin claimed it. The same `Package.provider`, so one declaration can address a single
   * ecosystem in a polyglot repository (`if: "${{ pkg.provider === 'node' }}"`).
   */
  provider: string;
  /**
   * The whole manifest, as a copy - so an expression can reach a field rman itself has no opinion
   * about (`${{ pkg.manifest.engines.node }}`).
   *
   * Named `manifest`, not `json`: which file a package's identity lives in is the ecosystem's
   * business now (see `ManifestProvider`), and `json` was that assumption showing through the one
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
  /** Read from git only if an expression actually asks for it, then remembered: a repository that
   *  never mentions these pays nothing, and every command resolves config. All `undefined` outside
   *  a git checkout, which is a legitimate state rather than an error. */
  git: GitScope;
}

export interface GitScope {
  branch: string | undefined;
  sha: string | undefined;
  shortSha: string | undefined;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean | undefined;
}

/**
 * What a `${{ ... }}` expression can see - the bindings of the fresh global it is evaluated in.
 * Namespaced rather than a flat bag of loose names: one obvious place per fact, and room to add
 * helpers to `pkg`/`repository` later without crowding the global.
 *
 * Alongside these, **the config's own top-level keys are bound bare** (`${{ publish.directory }}`,
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
 *       after: "cp README.md ${{ publish.directory }}/"
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
export function interpolateConfig<T>(config: T, scope: ConfigScope, options?: { skip?: string[] }): T {
  const skip = options?.skip ?? [];
  const context = vm.createContext({ ...scope });
  if (!config || typeof config !== 'object' || Array.isArray(config)) return walk(config, scope, context, [], skip);

  /**
   * The config's own top-level keys, readable bare: `${{ publish.directory }}`. So a value that
   * restates another - `after: "cp README.md ${{ publish.directory }}/"` - stops being a second
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
      const value = walk((config as Record<string, unknown>)[key], scope, context, [key], skip);
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
  return result as T;
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

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

/** A config key an expression could actually name. Anything else - a `"[selector]"` block, a
 *  `"lint:fix"` - is unreachable as a bare identifier anyway, so it is not bound. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The `file` namespace for one package's directory - see `FileScope`. */
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
  if (typeof value === 'string') return interpolateString(value, context, at);
  if (Array.isArray(value)) return value.map((item, i) => walk(item, scope, context, [...at, i], skip));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = walk(item, scope, context, [...at, key], skip);
    return result;
  }
  return value;
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
      const where = at.length ? formatPath(at) : 'the config root';
      throw new Error(
        `Expression in "${where}" is ${result} inside a string: ${value.trim()}\n` +
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
    const where = at.length ? formatPath(at) : 'the config root';
    throw new Error(`Invalid expression in "${where}": ${source.trim()}\n  ${e?.message ?? e}`, { cause: e });
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
