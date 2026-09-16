import fs from 'fs';
import * as yaml from 'js-yaml';
import { createRequire } from 'module';
import path from 'path';
import semver from 'semver';
import { pathToFileURL } from 'url';
import vm from 'vm';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
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

  const pkgJsonFile = path.join(dirname, 'package.json');
  if (fs.existsSync(pkgJsonFile)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
    if (pkgJson && typeof pkgJson.rman === 'object') mergeConfig(result, pkgJson.rman);
  }

  const ymlFile = path.join(dirname, '.rmanrc.yml');
  if (fs.existsSync(ymlFile)) {
    const obj = yaml.load(fs.readFileSync(ymlFile, 'utf-8'));
    if (obj && typeof obj === 'object') mergeConfig(result, obj as Record<string, any>);
  }

  const rcFile = path.join(dirname, '.rmanrc');
  if (fs.existsSync(rcFile)) {
    const obj = JSON.parse(fs.readFileSync(rcFile, 'utf-8'));
    if (obj && typeof obj === 'object') mergeConfig(result, obj);
  }

  for (const jsFileName of JS_CONFIG_FILES) {
    const jsFile = path.join(dirname, jsFileName);
    if (fs.existsSync(jsFile)) {
      const obj = await loadJsConfig(jsFile);
      if (obj && typeof obj === 'object') mergeConfig(result, obj);
    }
  }

  return result;
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
 * - **A `"[selector]"` block configures the packages it names** (`"[*]"` for all of them,
 *   `"[*-dialect]"` for a glob over package names). This is the only way a directory speaks about
 *   anything but its own package.
 *
 * Splitting the two matters because the same key means different things to the two audiences. The
 * clearest case is `run.<script>.postScript`: on a package it's that package's build hook, run in
 * its own directory; on the root it's a repo-wide bookend run once at the repository root. A
 * cascade that fed one declaration to both ran a package-relative command (`node
 * ../../support/postbuild.cjs`) at the root, where it cannot resolve.
 *
 * `packageName` is what selectors match against; without it (resolving the root's own config, say)
 * selector blocks contribute nothing at all.
 */
export async function resolveConfig(
  rootDir: string,
  targetDir: string,
  cache: Map<string, RmanConfig> = new Map(),
  packageName?: string,
): Promise<RmanConfig> {
  const result: RmanConfig = {};
  const target = path.resolve(targetDir);
  for (const dir of dirChain(rootDir, targetDir)) {
    let local = cache.get(dir);
    if (!local) {
      local = await readDirConfig(dir);
      cache.set(dir, local);
    }
    // Selectors first, so a directory's own unmarked config still wins over a selector declared
    // alongside it - "this package" is a more specific statement than "packages matching a glob".
    if (packageName) {
      for (const block of matchingSelectors(local, packageName)) mergeConfig(result, block);
    }
    // A directory holding a package speaks for that package only - which is what keeps the root's
    // own config off every package under it. A directory that holds none (an intermediate
    // `packages/`, say) has no package to speak for, so its unmarked config can only mean
    // "everything below" and still cascades.
    const ownsAPackage = fs.existsSync(path.join(dir, 'package.json'));
    if (!ownsAPackage || path.resolve(dir) === target) mergeConfig(result, stripSelectors(local));
  }
  /** Every layer has had its turn, so an append still outstanding has nothing left to attach to
   *  and becomes the value itself. Done here rather than per layer: until the chain is finished,
   *  the key it appends to may still be coming. */
  return finalizeConfig(result);
}

/** A config key naming packages rather than settings: `"[*]"`, `"[*-dialect]"`, `"[pkg-a]"`. The
 *  brackets are what keep this space from colliding with real config keys - no setting starts with
 *  one - and in YAML they also mean the key always needs quoting (`"[*]":`), since a bare `[*]`
 *  parses as a flow sequence. */
export function isSelectorKey(key: string): boolean {
  return key.length > 2 && key.startsWith('[') && key.endsWith(']');
}

/** The glob inside a selector key, as a `RegExp` anchored at both ends - so `"[*-dialect]"` matches
 *  `mysql-dialect` but not `my-dialect-helper`. Glob rather than regex, to match every other
 *  pattern in rman (`allowBranch`, `changelog.tagPattern`, `clean.include`). */
export function selectorToRegExp(key: string): RegExp {
  const glob = key.slice(1, -1);
  const source = glob
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Every selector block in `config` matching `packageName`, in increasing precedence: `"[*]"` first
 *  and the rest in declaration order - so a specific glob overrides the catch-all, and two equally
 *  specific ones resolve by the order they were written in. */
function matchingSelectors(config: RmanConfig, packageName: string): RmanConfig[] {
  const matches: [string, RmanConfig][] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!isSelectorKey(key) || !value || typeof value !== 'object') continue;
    if (selectorToRegExp(key).test(packageName)) matches.push([key, value as RmanConfig]);
  }
  return matches.sort((a, b) => Number(b[0] === CATCH_ALL) - Number(a[0] === CATCH_ALL)).map(([, block]) => block);
}

function stripSelectors(config: RmanConfig): RmanConfig {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) if (!isSelectorKey(key)) result[key] = value;
  return result as RmanConfig;
}

const CATCH_ALL = '[*]';

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
  /** The whole `package.json`, as a copy - so an expression can reach a field rman itself has no
   *  opinion about (`pkg.json.engines.node`). */
  json: Record<string, unknown>;
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

/** What a `${{ ... }}` expression can see - the bindings of the fresh global it is evaluated in.
 *  Namespaced rather than a flat bag of loose names: one obvious place per fact, and room to add
 *  helpers to `pkg`/`repository` later without crowding the global. */
export interface ConfigScope {
  /** The package the config was resolved for - which is what lets one declaration at the root
   *  still say something package-specific. */
  pkg: PackageScope;
  repository: RepositoryScope;
  env: Record<string, string | undefined>;
  /** rman's own `semver`, for the arithmetic every release config eventually wants
   *  (`semver.major(pkg.version)`). */
  semver: typeof semver;
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
 *     docker:
 *       image: "panates/${{ pkg.basename }}:${{ semver.major(pkg.version) }}"
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
  const context = vm.createContext({ ...scope });
  return walk(config, scope, context, [], options?.skip ?? []);
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
