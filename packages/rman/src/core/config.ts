import { DOMParser } from '@xmldom/xmldom';
import fs from 'fs';
import ini from 'ini';
import * as yaml from 'js-yaml';
import { createRequire } from 'module';
import path from 'path';
import semver from 'semver';
import { pathToFileURL } from 'url';
import vm from 'vm';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { assertNoSelectorExtends, EXTENDS_KEY, resolveExtends } from './extends-config.js';
import { finalizeConfig, mergeConfig, PREVIOUS_VALUE } from './merge-config.js';

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
   * Which ecosystem this package belongs to - `'node'` for one read by `rman-node`, empty when no
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
export interface InterpolateOptions {
  /** Config paths to leave entirely untouched - `DEFERRED_PATHS`, when the whole config is walked. */
  skip?: string[];
  /** Where `config` sits in the whole config, for a caller interpolating a fragment. */
  at?: string[];
}

export function interpolateConfig<T>(config: T, scope: ConfigScope, options?: InterpolateOptions): T {
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
      const value = walk((config as Record<string, unknown>)[key], scope, context, [...base, key], skip);
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

/**
 * Paths whose value is a **step** - something to run later - rather than a setting to compute now.
 * `*` matches one path segment (`run.<script>.exec`).
 *
 * This is what tells a step function from a value function, and the two live side by side in one
 * config:
 *
 * ```js
 * '[ws:*]': {
 *   clean: { include: ({ vars, value }) => [...value, vars.buildDir] },   // a value: called here
 *   run: { build: { after: ({ pkg }) => copyDocs(pkg) } },                // a step: called by `run`
 * }
 * ```
 *
 * **The key decides, and it already did.** `run.build.exec: 'tsc -b'` is a shell command and
 * `publish.directory: 'build'` is a path - not because of anything about the strings, but because of
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
 * compute. `plugins` is the only one, and it has to be here: an entry may be the plugin *object*
 * itself, and an `RmanPlugin` is almost entirely functions - `manifest.read`, `workspace.resolve`,
 * `versionPlanner`, `binPaths`, and every command's `builder` and `handler`.
 *
 * Measured, and it is why this exists: with `plugins` walked like any other key, resolving the
 * config of a repository that named a plugin called that plugin's yargs builder with the config
 * scope - `Config function in "plugins[0].commands[0].builder" failed: cmd.option is not a
 * function`. A `plugins` entry is loaded by `loadPlugins`, never read as a setting.
 */
export const CODE_SUBTREES = ['plugins'];

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
    return callValueFn(value as (arg: unknown) => unknown, scope, context, at, skip);
  }
  if (typeof value === 'string') return interpolateString(value, context, at);
  if (Array.isArray(value)) return value.map((item, i) => walk(item, scope, context, [...at, i], skip));
  if (value && typeof value === 'object') {
    return withScopedVars(value as Record<string, unknown>, scope, context, at, skip, () => {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = walk(item, scope, context, [...at, key], skip);
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
 * Whether a function at `at` is **code** - a step to run later, or part of a plugin - rather than a
 * value to compute now.
 *
 * Array indices are dropped before matching, so a function inside a *list* of steps is still a
 * step; `*` in a `STEP_PATHS` entry matches any one segment (`run.<script>.exec`).
 */
function isCodePath(at: (string | number)[]): boolean {
  const segments = at.filter((p): p is string => typeof p === 'string');
  if (CODE_SUBTREES.includes(segments[0])) return true;
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
function callValueFn(
  fn: (arg: unknown) => unknown,
  scope: ConfigScope,
  context: vm.Context,
  at: (string | number)[],
  skip: string[],
): unknown {
  const previous = (fn as unknown as Record<symbol, unknown>)[PREVIOUS_VALUE];
  const arg = Object.create(context);
  /** Resolved the same way any other value is, so an inherited `${{ }}` string or a function under
   *  it is already finished by the time this one is handed it. */
  const resolvedPrevious = previous === undefined ? undefined : walk(previous, scope, context, at, skip);
  /**
   * A getter only so the catch below can tell whether the function **actually read `value`**.
   *
   * Without that, the "value is undefined" hint went out with *every* failure of a first-layer
   * function - a frozen-object `TypeError` from `read()` arrived wearing advice about spreading an
   * inherited list, which is precisely the send-the-reader-to-the-wrong-place mistake the hint
   * exists to prevent. Recorded rather than inferred from the message, because matching on V8's
   * wording is the other way to get this wrong.
   */
  let valueRead = false;
  Object.defineProperty(arg, 'value', {
    enumerable: true,
    get: () => {
      valueRead = true;
      return resolvedPrevious;
    },
  });
  try {
    return fn(arg);
  } catch (e: any) {
    const where = at.length ? formatPath(at) : 'the config root';
    /**
     * **`value` is `undefined` when no layer underneath set this key.** A function written to extend
     * an inherited list (`[...value, x]`) is also the *first* layer in a repository that inherits
     * nothing, and V8's report for that is `value is not iterable` - which names neither the key nor
     * the reason, and sends the reader looking at their spread instead of at what is missing.
     *
     * Told rather than papered over: defaulting `value` to `[]` would be a guess about the key's
     * type, and wrong for every key that is not a list.
     */
    const hint =
      valueRead && resolvedPrevious === undefined
        ? `\n  \`value\` is undefined here - nothing below this layer sets "${where}".` +
          `\n  Write \`value ?? []\` (or \`?? ''\`) if the function has to work as the first layer too.`
        : '';
    throw new Error(`Config function in "${where}" failed: ${e?.message}${hint}`, { cause: e });
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
