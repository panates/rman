import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fastGlob from 'fast-glob';
import * as yaml from 'js-yaml';
import { presetNames, PRESETS_DIR } from '../../builtins/presets/index.js';
import type { RmanConfig } from '../../interfaces/rman-config.interface.js';
import type { Package } from '../classes/package.js';
import type { Repository } from '../classes/repository.js';
import { declaredKind, isDeclared, isPlatform, type Platform, type Plugin } from '../interfaces/plugin.js';
import { CODE_SUBTREES } from './config-paths.js';
import { mergeConfig } from './merge-config.js';

const requireConfigModule = createRequire(import.meta.url);
const IDENTITY_KEYS = ['platform', 'name'] as const;
const ROOT_SELECTOR_INNER = '/';
const EXTEND_EXTENSIONS = ['', '.yml', '.yaml', '.json', '.cjs', '.mjs', '.js'];
const EXTENDS_KEY = 'extends';
const PLUGINS_KEY = 'plugins';
const PLATFORMS_KEY = 'platforms';

/** What marks an `extends` target as one of rman's own presets: `extends: "rman:node"`. */
const PRESET_PREFIX = 'rman:';

/** `.js` is the published layout; `.ts` is the source tree a spec runs in. */
const PRESET_EXTENSIONS = ['.js', '.ts'];

/** What an error about a default preset names itself as - there is no config key to quote, since
 *  these are laid down by the caller rather than written by anybody. */
const PRESETS_LABEL = 'presets';

/** Free-form by contract - see `_assertSelectorKeys`. */
const VARS_KEY = 'vars';

/** Keys that only an rman **config** has, for telling one from a contribution once it has already
 *  been refused - see `_assertLoaded`. `name` is not among them: a plugin has one too. */
const CONFIG_SHAPED = ['extends', PLUGINS_KEY, PLATFORMS_KEY, 'commands', 'publishTargets'] as const;

export class ConfigReader {
  /**
   *
   * @protected
   */
  protected readonly configFiles: readonly string[] = [
    '.rmanrc',
    '.rmanrc.yml',
    '.rmanrc.cjs',
    '.rmanrc.mjs',
    '.rmanrc.js',
  ];

  /**
   * Whether a config key names **packages** rather than a setting: `"[*]"`, `"[/]"`, `"[pkg-a]"`.
   */
  /* The brackets are what keep this space from colliding with real config keys - no setting starts
   * with one - and in YAML they also mean the key always needs quoting (`"[*]":`), since a bare
   * `[*]` parses as a flow sequence and `*` is an alias indicator. */
  static isSelectorKey(key: string): boolean {
    return key.length > 2 && key.startsWith('[') && key.endsWith(']');
  }

  /**
   * **Which packages a selector key speaks for.** Three audiences, and what each is matched
   * against:
   *
   * | | matches | `test` is given |
   * | --- | --- | --- |
   * | `"[/]"` | the **root package** alone, structurally | - |
   * | `"[platform:node]"`, `"[platform:node,cargo]"` | packages of those **technologies** | `pkg.platform.name` |
   * | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | the packages **below** this directory the glob matches | `pkg.selector` |
   *
   * The glob is anchored at both ends, so `"[*-dialect]"` matches `mysql-dialect` but not
   * `my-dialect-helper`. `"[ws:*]"` and `"[workspace:*]"` are accepted and mean exactly `"[*]"`.
   */
  /* `/` for the root because that is what a repository root is called everywhere else, and it
   * cannot collide with a package name.
   *
   * **The root is never selected by name, and that one rule removes two traps.** A glob matches
   * package names, and the root is nobody's child - so `"[my-*]"` cannot quietly pick up a
   * repository whose root package happens to be called `my-repo`, and `"[*]"` cannot hand a
   * package-shaped setting to a root that has no build directory to apply it to.
   *
   * The `ws:`/`workspace:` qualifier existed to say "not the root" back when a bare glob included
   * it; the shape of the set says that now, so it has nothing left to add. Accepted rather than
   * rejected because the two spellings resolve to the same packages - an error would be friction
   * with no reader to protect.
   *
   * Glob rather than regex, to match every other pattern in rman (`allowBranch`,
   * `changelog.tagPattern`, `clean.include`). */
  static parseSelector(key: string): ConfigReader.ParsedSelector {
    const inner = key.slice(1, -1);
    if (inner === ROOT_SELECTOR_INNER) return { scope: 'root', test: () => true };
    if (inner.startsWith(PLATFORM_PREFIX)) {
      const names = inner
        .slice(PLATFORM_PREFIX.length)
        .split(',')
        .map(n => n.trim())
        .filter(Boolean);
      return { scope: 'platform', test: (name: string) => !!name && names.includes(name), names };
    }
    const re = globToRegExp(stripWorkspacePrefix(inner));
    return { scope: 'package', test: (name: string) => re.test(name) };
  }

  /**
   *
   */
  async resolve(dirname: string, options?: ConfigReader.Options): Promise<ConfigReader.ResolveResult> {
    const context: ConfigReader.Context = {
      dirname,
      plugins: [],
      platforms: [...(options?.platforms || [])],
    };
    /** Seeded through `_addPlugin` rather than copied, so a plugin handed in carries its
     *  technologies into `context.platforms` exactly as one a config names does - the caller's
     *  plugins are the *first* thing in play, and a list they were missing from would have a
     *  preset's platform claiming a directory theirs recognizes. */
    for (const plugin of options?.plugins || []) this._addPlugin(plugin, context);
    const config = await this._resolve(context, options);
    return { config, plugins: context.plugins, platforms: context.platforms };
  }

  /**
   *
   * @protected
   */
  protected async _resolve(context: ConfigReader.Context, options?: ConfigReader.Options): Promise<RmanConfig> {
    const source = this._findConfigSource(context.dirname);
    const raw = source ? await this._readConfigFile(source) : {};
    let resolved: RmanConfig = {};

    /* Read config file */
    if (source) {
      this._assertSelectorBlocks(raw, source);
      /**
       * `extends` names the base this file sits on, so it is resolved on its own and the file's own
       * keys land on top of the answer.
       */
      const declared = (raw as Record<string, unknown>)[EXTENDS_KEY];
      /**
       * **Only the key it reads is handed over, never the whole config.** `_resolveExtends` merges
       * its argument's own keys onto the bases it resolved, so passing `raw` applied them there and
       * then again below - measured, a value function chained onto its own result and
       * `[...value, 'dist']` answered `['build', 'dist', 'dist']`.
       */
      const base =
        declared === undefined
          ? {}
          : await this._resolveExtends(context, { [EXTENDS_KEY]: declared } as RmanConfig, source);
      const own = { ...(raw as Record<string, unknown>) };
      delete own[EXTENDS_KEY];

      /**
       * **Through `mergeConfig` whether or not there is an `extends`**, and that is not symmetry -
       * it is the only thing that anchors a contribution glob and records an origin.
       *
       * `plugins`, `commands` and `publishTargets` take a glob, and a relative one has to be
       * resolved against **the file that declared it** - which `anchorContributions` does inside
       * `mergeConfig`, at the last moment that is knowable. Skipped for a config with no `extends`,
       * `plugins: './p.js'` reached `fastGlob` unanchored and was looked for relative to the
       * *current working directory*: measured, `"plugins" glob "./p.js" matched no file`, in a
       * repository where the file sat right beside the config naming it.
       *
       * The same call is what records `ORIGINS`, so without it every error about this file named no
       * file at all.
       */
      resolved = mergeConfig(base, own, source) as RmanConfig;
    }

    /* Load the technologies this level names, then the plugins that carry more of them. */
    await this._loadPlatforms(resolved, context);

    /* Load plugins */
    await this._loadPlugins(resolved, context);

    /* Then what rman ships, underneath everything above - see `_applyPresets`. */
    resolved = await this._applyPresets(resolved, context, options);

    /* Which technology claims this directory, when its config has not said. */
    if (!this._getDeclaredPlatform(resolved)) {
      const claimed = context.platforms.find(p => p.manifestProvider.read(context.dirname));
      if (claimed) resolved.platform = claimed.name;
    }
    return resolved;
  }

  protected _getDeclaredPlatform(config: RmanConfig): string | undefined {
    const root = (config as Record<string, any>)[`[${ROOT_SELECTOR_INNER}]`];
    const declared = config.platform ?? (root && typeof root === 'object' ? root.platform : undefined);
    return typeof declared === 'string' && declared.trim() ? declared.trim() : undefined;
  }

  /**
   * The one config file `dirname` declares, or `undefined` for a directory that declares none.
   *
   * **Several is an error**, which is the whole point of reading the directory rather than probing
   * the names in a fixed order: a probe cannot tell "this one" from "this one, and three others I
   * am quietly folding in underneath". The message lists what it found, because the fix is to
   * delete one and the reader has to know which are in play.
   *
   * Public because it answers a question a *reader* has and not only the resolver: `rman config`
   * heads its output with the file you would open to change what it prints.
   */
  findConfigSource(dirname: string): string | undefined {
    return this._findConfigSource(dirname);
  }

  /** @see {@link ConfigReader.findConfigSource} */
  protected _findConfigSource(dirname: string): string | undefined {
    let entries: string[];
    try {
      entries = fs.readdirSync(dirname);
    } catch {
      return undefined;
    }

    const found = entries.filter(name => this.configFiles.includes(name)).map(name => path.join(dirname, name));

    /** The manifest's own `rman` key. Counted here rather than merged later, and only when the key
     *  is actually present - every Node package has a `package.json`, and a `package.json` without
     *  that key is not a config source. */
    if (entries.includes('package.json')) {
      const pkgJsonFile = path.join(dirname, 'package.json');
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
        if (pkgJson && typeof pkgJson.rman === 'object' && pkgJson.rman !== null) found.push(pkgJsonFile);
      } catch {
        /** Not this read's error to raise - a malformed `package.json` is the manifest provider's
         *  report to make, and raising it here would blame the config for a broken manifest. */
      }
    }

    if (found.length > 1) {
      const names = found.map(f => (path.basename(f) === 'package.json' ? 'package.json ("rman")' : path.basename(f)));
      throw new Error(
        `"${dirname}" declares ${found.length} rman configs - ${names.join(', ')}. A directory may ` +
          `declare one. Merging them would produce a config that is in none of the files, under a ` +
          `precedence order nothing states; delete or rename the ones that are not in use.`,
      );
    }
    return found[0];
  }

  /** Reads one config file into a plain object. Nothing is merged and nothing is checked here
   *  beyond the file being an object at all - a config that is a list or a string is a mistake
   *  worth naming before any key of it is read. */
  protected async _readConfigFile(file: string): Promise<RmanConfig> {
    const name = path.basename(file);
    const ext = path.extname(file);
    if (name === 'package.json') {
      return JSON.parse(fs.readFileSync(file, 'utf-8')).rman as RmanConfig;
    }
    /**
     * **A bare `.rmanrc` is JSON, and it has to be named rather than derived.** `path.extname` on a
     * dotfile answers `''` - a leading dot makes a name, not an extension - so without this clause
     * the plain `.rmanrc` fell through to the module loader and was `require()`d as JavaScript.
     * Measured: `{"[/]":{"platform":"declared"}}` came back as `SyntaxError: Unexpected token ':'`,
     * pointing at the config file, from a loader nobody asked for.
     */
    const value =
      ext === '.json' || name === '.rmanrc'
        ? JSON.parse(fs.readFileSync(file, 'utf-8'))
        : ext === '.yaml' || ext === '.yml'
          ? yaml.load(fs.readFileSync(file, 'utf-8'))
          : await this._loadConfigModule(file);

    /**
     * **A module may export a factory instead of the object**, and the config is then whatever it
     * returns. This is how a preset stays inert until a repository names it.
     */
    /* `presets/node` has to run `augmentSystemInfo()` before handing its config over, and that
     * mutates the core's own `SystemInfo` in place - at import time it would have `rman info` report
     * npm's tooling in a Cargo repository that never named the preset. A factory moves the side
     * effect from "this module was loaded" to "this repository asked".
     *
     * No ambiguity with a value function: those are *keys* of a config, and this is the module's
     * default export, which is the config itself. */
    const resolved = typeof value === 'function' ? await (value as () => unknown)() : value;
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new Error(`"${file}" does not hold an rman config object`);
    }
    return resolved as RmanConfig;
  }

  /**
   * Loads a config module - a `.rmanrc.cjs`/`.mjs`/`.js`, or an `extends` target that is one. The
   * default export when there is one, the module's own exports object otherwise.
   */
  /* **`require()` first, and that is not an optimization.** A CommonJS module's `module.exports` is
   * more reliably observed this way than through dynamic `import()`'s CJS-interop synthesis, which
   * some ESM loader hooks - ts-node/swc-node-style transpilers registered via `--import` - can
   * short-circuit into an **empty object**. `require()` throws `ERR_REQUIRE_ESM` for a genuinely-ESM
   * file (`.mjs`, or `.js` under `"type": "module"`), and only then does this fall back to
   * `import()`, the one case that actually needs it.
   *
   * Either path can hand back an ES module namespace rather than a plain object - Node's
   * `require(esm)` support does this too, not just `import()` - so `.default` is preferred whenever
   * present.
   *
   * **One loader for a directory's own config and for an `extends` target, which it was not.** The
   * old `extends-config.ts` used a bare `await import()` while a directory's own `.rmanrc.cjs` went
   * through this, so the *same file* loaded correctly as a directory's config and came back empty
   * when another config named it - and an empty object is a valid config, so nothing was reported.
   * Measured under mocha: a base declaring `"[*]": { version: { stamp: ['build'] } }`, reached by
   * `extends: './base.cjs'`, contributed nothing; the identical fixture with `base.json`
   * contributed normally, and the same `.cjs` worked from the CLI, where no loader hook is
   * registered. Both routes are this one method now, so they cannot part again.
   *
   * `createRequire` is based on **this module's** own URL rather than on the config file. That is
   * right here and *not* right for resolving a bare specifier - see `_resolveTarget`, which is
   * based on the config file so a package name resolves through the repository's `node_modules`
   * rather than rman's own. By the time a file reaches here it is already an absolute path. */
  protected async _loadConfigModule(file: string): Promise<any> {
    let mod: any;
    try {
      mod = requireConfigModule(file);
    } catch (e: any) {
      if (e?.code !== 'ERR_REQUIRE_ESM') throw e;
      mod = await import(pathToFileURL(file).href);
    }
    return mod?.default ?? mod;
  }

  /**
   * Checks every `"[...]"` key in a config: where it sits, what it carries, and - for a nested one -
   * whether the pair could ever match a package.
   */
  protected _assertSelectorBlocks(config: RmanConfig, file: string): void {
    this._assertSelectorKeys(config, file, [], []);
  }

  /**
   * One walk, refusing a selector key under a *setting* and checking each legal one's contents.
   *
   * @param at the key path to `node`.
   * @param enclosing the selector keys `node` sits inside, outermost first.
   */
  /* **A selector key is legal at the top level of a config and directly inside another selector
   * key, and nowhere else** - which is the whole of the placement rule, and `at.length >
   * enclosing.length` is the whole of the test: the two arrays stay equal for as long as every
   * ancestor is a selector, and `at` runs ahead the moment one is not.
   *
   * ```yaml
   * "[platform:node]":
   *   "[pkg-*]": { group: x }     # an intersection
   *   run:
   *     "[pkg-*]": { ... }        # refused - a setting is not an audience
   * ```
   *
   * **The nested form used to be refused outright and that was the wrong call**, on a reason that
   * does not survive being written out: "selectors do not intersect, because specificity ranking was
   * dropped". Ranking answers which of two *siblings* wins, and nesting asks nothing of the sort -
   * a nested block is resolved depth-first in declaration order, which is the rule already in force
   * one level up (`Workspace._matchingSelectors`). What the refusal cost was the only way to say
   * "these packages, but only the ones that are also X" for a whole block: `if:` is per key and
   * reaches neither `vars` nor any key that is not a run step.
   *
   * What the refusal *did* get right was that silence is unacceptable - before it, the inner block
   * reached every package the outer one did, as a literal `'[pkg-*]'` key sitting in the resolved
   * config where `rman config` showed it looking as though it had worked. Both halves are answered
   * now: the shape works, and the shapes that could never work are refused here rather than
   * quietly matching nothing.
   *
   * **`vars` and the contribution keys are skipped**, and both for the same reason: their contents
   * are not config keys. `vars` is free-form by contract and `CODE_SUBTREES` hold plugins, commands
   * and publish targets - arbitrary objects whose key space rman does not own. A bracketed name in
   * either is data. */
  protected _assertSelectorKeys(node: unknown, file: string, at: string[], enclosing: string[]): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (ConfigReader.isSelectorKey(key)) {
        if (at.length > enclosing.length) {
          throw new Error(
            `"${key}" in "${file}" is nested under "${at.join('.')}", which is a setting rather ` +
              `than an audience - a selector is read at the top level of a config and inside ` +
              `another selector, so this one would never be applied. Move it out, or use an ` +
              `expression where the value itself depends on the package.`,
          );
        }
        this._assertSelectorBlock(key, value, file, enclosing.at(-1));
        this._assertSelectorKeys(value, file, [...at, key], [...enclosing, key]);
        continue;
      }
      if (key === VARS_KEY || CODE_SUBTREES.includes(key as (typeof CODE_SUBTREES)[number])) continue;
      this._assertSelectorKeys(value, file, [...at, key], enclosing);
    }
  }

  /** What one selector block may carry, and - given `outer` - whether it can match anything. */
  protected _assertSelectorBlock(key: string, value: unknown, file: string, outer: string | undefined): void {
    if (!value || typeof value !== 'object') return;
    if (outer !== undefined) this._assertNestable(outer, key, file);
    if (EXTENDS_KEY in (value as Record<string, unknown>)) {
      throw new Error(
        `"${key}" in "${file}" cannot use "extends" - it belongs at the top level, where it is a ` +
          `statement about this config rather than about the packages the selector names.`,
      );
    }
    /**
     * **The two keys a selector cannot carry, because the selector is downstream of them.**
     *
     * A `"[glob]"` matches `Package.selector`, which comes from `name` - and which package a
     * directory even holds comes from `platform`. Both are read from the *unmarked* cascade, while
     * the packages are still being found, so a glob block setting either would need its own answer
     * in order to be matched at all. Typed as a whole `RmanConfig`, both look valid there and both
     * would simply never be read.
     *
     * `"[/]"` is exempt and keeps working: the root is addressed structurally - its directory *is*
     * the repository root - so a root block needs no selector and is applied during the walk.
     */
    if (ConfigReader.parseSelector(key).scope === 'root') return;
    for (const identity of IDENTITY_KEYS) {
      if (identity in (value as Record<string, unknown>)) {
        throw new Error(
          `"${key}" in "${file}" cannot set "${identity}" - a glob matches a package's selector, ` +
            `and "${identity}" is what the selector is derived from, so the block could never be ` +
            `matched in order to apply it. Write it unmarked, in the package's own ".rmanrc", or ` +
            `under "[/]" for the root package.`,
        );
      }
    }
  }

  /**
   * Refuses a nested pair that could never match a package together.
   *
   * @param outer the enclosing selector key.
   * @param inner the key written inside it.
   */
  /* **Nesting is an AND, so a pair naming disjoint sets is a block that runs for nobody** - which is
   * the silence the old blanket refusal was really about, and the only part of it worth keeping.
   * Two pairs are decidable here and both are refused:
   *
   * - **`"[/]"` on either side.** The root is addressed structurally and every other selector
   *   deliberately never reaches it, so `"[/]"` inside a glob is empty and a glob inside `"[/]"` is
   *   empty. `"[/]"` inside `"[/]"` is merely redundant, and one rule covering all three beats an
   *   exemption nobody would remember.
   * - **Two platform blocks naming nothing in common.** A package carries one `platform.name`, so
   *   `"[platform:node]" > "[platform:cargo]"` is empty; `"[platform:node,cargo]" > "[platform:node]"`
   *   narrows and is fine.
   *
   * **A glob pair is deliberately not checked**, and the asymmetry is the point rather than an
   * omission: whether two globs intersect is a real computation with a wrong answer available in
   * both directions, while a platform set is `includes`. `"[pkg-*]" > "[lib-*]"` therefore loads and
   * matches nothing - the same thing a top-level `"[lib-*]"` does in a repository with no such
   * package, which nothing reports either. */
  protected _assertNestable(outer: string, inner: string, file: string): void {
    const a = ConfigReader.parseSelector(outer);
    const b = ConfigReader.parseSelector(inner);
    if (a.scope === 'root' || b.scope === 'root') {
      throw new Error(
        `"${inner}" in "${file}" is nested inside "${outer}", and "[/]" takes part in no nesting - ` +
          `the root is addressed structurally and every other selector deliberately never reaches ` +
          `it, so one side of this pair always refuses the other and the block could never be ` +
          `applied. Write the root's settings under a top-level "[/]".`,
      );
    }
    if (a.scope === 'platform' && b.scope === 'platform' && !b.names?.some(name => a.test(name))) {
      throw new Error(
        `"${inner}" in "${file}" is nested inside "${outer}", which names no technology in common ` +
          `with it - a package carries one platform, so this block could never be applied. Nesting ` +
          `narrows: name a technology the outer block already speaks for.`,
      );
    }
  }

  protected async _resolveExtends(
    context: ConfigReader.Context,
    config: RmanConfig,
    from: string,
    seen: string[] = [],
  ): Promise<RmanConfig> {
    const declared = (config as Record<string, unknown>)[EXTENDS_KEY];
    if (declared === undefined) return config;

    const targets = Array.isArray(declared) ? declared : [declared];
    for (const target of targets) {
      if (typeof target !== 'string' || !target.trim()) {
        throw new Error(`"extends" in "${from}" must be a config name or path, or an array of them`);
      }
    }

    const base: RmanConfig = {};
    for (const target of targets as string[]) {
      const file = this._resolveExtendTarget(target, from, EXTENDS_KEY);
      if (seen.includes(file)) {
        throw new Error(`"extends" forms a cycle: ${[...seen, file].map(f => path.basename(f)).join(' -> ')}`);
      }
      const loaded = await this._readConfigFile(file);
      this._assertSelectorBlocks(loaded, file);
      // Recursive: a shared config may itself be built on another.
      mergeConfig(base, await this._resolveExtends(context, loaded, file, [...seen, file]), file);
    }

    const own = { ...(config as Record<string, unknown>) };
    delete own[EXTENDS_KEY];
    return mergeConfig(base, own) as RmanConfig;
  }

  /**
   * Lays `options.presets` underneath this level's own config, exactly as an `extends` naming them
   * would - so a repository that declares nothing still has rman's own technologies, commands and
   * publish targets, and one that declares something still wins every key.
   *
   * Nothing happens without `options.presets`, which is how a level that is not the root - and a
   * caller wanting a bare core - says so.
   */
  /* **Loaded last, and that is the one thing here that is not obvious.** `platformFor` takes the
   * first technology that recognizes a directory, so whatever is registered first decides which
   * directories are packages at all. A repository writing `extends: 'rman:cargo'` has said what it
   * is; its platform is loaded in the two steps above and therefore sits ahead of node in
   * `context.platforms`, so a root holding both a `Cargo.toml` and a tooling `package.json`
   * resolves to what the repository declared rather than to what rman happens to ship.
   *
   * **The config's own `platforms` array runs the other way round** - `[node, ...declared]`, because
   * the presets merge underneath like any base - and nothing reads it: `context.platforms` is the
   * order-bearing list, and the array is the record of what was contributed. Worth knowing before
   * reading one off `rman config` and expecting it to say who claims what.
   *
   * **One combined layer rather than one merge per preset**, so several presets keep their
   * declaration order instead of the last one landing deepest. */
  protected async _applyPresets(
    config: RmanConfig,
    context: ConfigReader.Context,
    options?: ConfigReader.Options,
  ): Promise<RmanConfig> {
    if (!options?.presets?.length) return config;
    const base: RmanConfig = {};
    for (const name of options.presets) {
      const preset = await this._readConfigFile(this._resolvePreset(name, PRESETS_LABEL));
      mergeConfig(base, preset as Record<string, unknown>);
    }
    await this._loadPlatforms(base, context);
    await this._loadPlugins(base, context);
    return mergeConfig(base, config as Record<string, unknown>) as RmanConfig;
  }

  /**
   * Loads the technologies a level's `platforms` names, into `context.platforms`.
   *
   * An entry is a `Platform`, or a glob naming `.js` modules that `export default` one. Already
   * present by name, it is skipped - two layers naming one technology is ordinary rather than a
   * mistake, and registering it twice would have two objects answering for one name.
   */
  /* The sibling of `_loadPlugins`, and deliberately not folded into it: `plugins` and `platforms`
   * are different keys with different contents, and a single loader would have to guess which it
   * was holding - the `Plugin | Platform` two-shapes problem that having separate keys removes. */
  protected async _loadPlatforms(config: RmanConfig, context: ConfigReader.Context): Promise<void> {
    if (!config.platforms) return;
    for (const entry of Array.isArray(config.platforms) ? config.platforms : [config.platforms]) {
      if (typeof entry === 'string') {
        for (const { value, file } of await this._loadByGlob(entry, PLATFORMS_KEY)) {
          this._assertLoaded(value, file, 'platform');
          this._addPlatform(value as Platform, context);
        }
      } else if (entry && typeof entry === 'object' && isPlatform(entry)) {
        this._addPlatform(entry, context);
      } else {
        throw new Error(
          `"${PLATFORMS_KEY}" takes a platform, or a glob naming modules that export one - got ` +
            `${describeEntry(entry)}. A platform is declared with definePlatform({ name, ` +
            `manifestProvider, ... }); anything broader is a plugin and belongs in "${PLUGINS_KEY}".`,
        );
      }
    }
  }

  /** Appends a technology unless one already answers to its name. */
  protected _addPlatform(platform: Platform, context: ConfigReader.Context): void {
    if (!context.platforms.some(p => p.name === platform.name)) context.platforms.push(platform);
  }

  /** Appends a plugin unless one already answers to that name. */
  /* A plugin carries no technologies any more - `platforms` is a config key, so a package shipping
   * one declares it in its own config and the reader loads it through `_loadPlatforms` like any
   * other. What is left of a plugin is a name and two stages. */
  protected _addPlugin(plugin: Plugin, context: ConfigReader.Context): void {
    if (!context.plugins.some(p => p.name === plugin.name)) context.plugins.push(plugin);
  }

  protected async _loadPlugins(config: RmanConfig, context: ConfigReader.Context) {
    if (!config.plugins) return;
    const pluginsToLoad = Array.isArray(config.plugins) ? config.plugins : [config.plugins];
    for (const entry of pluginsToLoad) {
      if (entry && typeof entry == 'object' && entry.name) {
        this._assertDeclaredPlugin(entry, `"${PLUGINS_KEY}"`);
        this._addPlugin(entry, context);
      } else if (typeof entry == 'string') {
        const plugins = await this._loadPluginsByEntry(entry);
        for (const plugin of plugins) this._addPlugin(plugin, context);
      } else {
        /**
         * **Anything else is refused rather than skipped**, and the asymmetry it removes is the
         * point: a glob matching no file already throws (`_loadPluginsByEntry`), so ignoring a
         * malformed instance reported the same outcome - a plugin that did not load - one way
         * loudly and the other in silence. Silence is the worse half. Losing a plugin removes the
         * commands and seams a repository is built around, and the symptom surfaces far away as
         * `Unknown argument: clean`, which sends the reader to look at the command rather than at
         * the entry that never loaded.
         *
         * **A nameless entry could not be complained about later even if it were kept.** `name` is
         * the de-duplication key and what every message about a plugin is keyed by, so there would
         * be nothing to call it in the error it eventually causes.
         */
        const got =
          entry === null
            ? 'null'
            : Array.isArray(entry)
              ? 'an array'
              : typeof entry === 'object'
                ? 'an object with no "name"'
                : `a ${typeof entry}`;
        throw new Error(
          `"${PLUGINS_KEY}" takes a plugin, or a glob naming modules that export one - got ${got}. ` +
            `Every message about a plugin is keyed by its \`name\`, so an entry without one could ` +
            `not be reported on even where it did load.`,
        );
      }
    }
  }

  /**
   * Refuses a plugin that did not come through `definePlatform`/`definePlugin`.
   *
   * @param from where the entry came from, for the message - the config key for one written into
   *   the config, and the file for one a glob loaded.
   */
  /* No structural check could replace this: an rman **1.x plugin was `{ name, init }`**, and under
   * the 2.x split a plugin that contributes nothing but an `init` is *also* `{ name, init }`.
   * Identical objects, identical types - so the declaration has to be explicit, and the factories
   * stamp a non-enumerable `Symbol.for` mark that `isDeclared` is the only reader of.
   *
   * Without it the 1.x plugin loads cleanly, registers, and dies later **inside its own `init`**
   * with `TypeError: ctx.addCommand is not a function`. Measured while converting
   * `@panates/rman-node`: fifteen failures, naming neither the plugin nor the version it was
   * written against.
   *
   * The file is the half of `from` worth having - a glob matching four modules gives the reader
   * nothing to open otherwise. */
  protected _assertDeclaredPlugin(value: Plugin, from: string): void {
    if (isDeclared(value)) return;
    throw new Error(
      `Plugin "${value.name}" (${from}) was not declared with definePlatform() or definePlugin(). ` +
        `A plain object is how an rman 1.x plugin looks, and a 1.x plugin has nothing left to do: ` +
        `commands, publish targets and other plugins are "commands", "publishTargets" and ` +
        `"${PLUGINS_KEY}" keys of a config now. Wrap a technology in definePlatform({ name, ` +
        `manifestProvider, ... }), anything else in definePlugin({ ... }).`,
    );
  }

  /**
   * Loads the plugins a **string** `plugins` entry names.
   *
   * The string is a glob - never a package name, and already absolute by the time it arrives - so
   * it may match several modules and this returns a list. An entry written as an instance does not
   * come through here; it is already the plugin.
   *
   * Each match must `export default` a plugin declared through `definePlatform`/`definePlugin`.
   * A glob matching nothing is an error.
   */
  /* **The glob is anchored by `mergeConfig`**, to the file that declared it, while the config is
   * read (`anchorContributions`) - the last moment that is knowable, since `plugins` always appends
   * and one resolved list holds entries from this directory's config, every `extends` base and
   * every level above, while `ORIGINS` records one file per *key* rather than per element. Nothing
   * here resolves a path, and adding a resolution step would make a shared config's `'./x.js'` look
   * in the consumer's directory.
   *
   * **`.js` only.** These are imported into rman's own process with no loader registered, so a
   * `.ts` module cannot be one - a TypeScript repository compiles first or writes `.mjs`. Stated
   * rather than attempted: a `.ts` that loads under a test runner's loader and not under the CLI is
   * the worst of both.
   *
   * **The declaration check happens here rather than in the caller** only because this is where the
   * file is still in hand. Nothing else about the result is checked; `name` and the shape are the
   * caller's. */
  protected async _loadPluginsByEntry(entry: string): Promise<Plugin[]> {
    const out: Plugin[] = [];
    for (const { value, file } of await this._loadByGlob(entry, PLUGINS_KEY)) {
      this._assertLoaded(value, file, 'plugin');
      out.push(value as Plugin);
    }
    return out;
  }

  /**
   * Refuses whatever a glob matched when it is not the kind the key takes, naming what it *is*.
   *
   * @param want which key is being loaded, so the message can point at the other one.
   */
  /* **Two of the three answers are facts now, and that is what the declaration kind bought.** The
   * mark used to be a bare `true`, so the only question that could be asked was "declared at all?"
   * - and the answer to everything else was one message about rman 1.x plugins. Measured on two
   * exports: a module returning a *config* (`{ plugins: [] }`) and one returning the string
   * `'oops'` both came back as `Plugin "undefined" … was not declared`, which names a type the
   * value is not and quotes a name it does not have.
   *
   * The remaining guess is the last branch, and it is only about *which sentence* to write - the
   * refusal is already decided, so a wrong guess costs a less helpful message rather than a plugin
   * that loads as the wrong thing. That is the line `plugins` draws elsewhere too: never guess what
   * something *is*, and it is fine to guess what the author meant once you have refused it. */
  protected _assertLoaded(value: unknown, file: string, want: Plugin.DeclaredKind): void {
    const kind = declaredKind(value);
    if (kind === want) return;

    /** Declared, but as the other one - the commonest mistake, and the only message that can just
     *  say so. */
    if (kind) {
      const key = kind === 'platform' ? PLATFORMS_KEY : PLUGINS_KEY;
      throw new Error(
        `"${want === 'plugin' ? PLUGINS_KEY : PLATFORMS_KEY}" matched "${file}", whose default ` +
          `export is a ${kind}, not a ${want}. Move it to "${key}".`,
      );
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `"${want === 'plugin' ? PLUGINS_KEY : PLATFORMS_KEY}" takes a ${want} or a glob naming ` +
          `modules that export one - "${file}" exports ${describeEntry(value)}.`,
      );
    }

    /** A config is the near miss worth naming: a package's config reaches a repository through
     *  `extends`, which is the key that means "merge this underneath mine" - and reading one out of
     *  a `plugins` entry is exactly what 1.x did and what the split removed. */
    if (CONFIG_SHAPED.some(key => key in (value as object))) {
      throw new Error(
        `"${want === 'plugin' ? PLUGINS_KEY : PLATFORMS_KEY}" matched "${file}", whose default ` +
          `export looks like an rman config rather than a ${want}. A config reaches a repository ` +
          `through "extends", which merges everything it declares underneath your own.`,
      );
    }

    this._assertDeclaredPlugin(value as Plugin, file);
  }

  /**
   * Every default export a **glob** entry names, with the file each came from.
   *
   * Shared by `plugins` and `platforms`, which take the same two forms and differ only in what they
   * accept back - so the caller checks the shape and this one only finds and imports.
   *
   * The glob is absolute by the time it arrives: `mergeConfig` anchors a contribution glob to the
   * file that declared it (`anchorContributions`). Nothing here resolves a path, and a resolution
   * step would make a preset's `'./x.js'` look in the consumer's directory. `.js` only - these are
   * imported into rman's own process with no loader registered, so a `.ts` module cannot be one.
   */
  protected async _loadByGlob(entry: string, key: string): Promise<{ value: unknown; file: string }[]> {
    if (!entry.trim()) throw new Error(`"${key}" has an empty glob.`);

    /** fast-glob speaks forward slashes on every platform, so a Windows path separator has to be
     *  translated rather than passed through as an escape. */
    const files = await fastGlob(entry.split(path.sep).join('/'), { absolute: true, onlyFiles: true });

    /**
     * **A glob matching nothing is an error**, unlike in `commands`, and the asymmetry is the
     * point: losing a plugin silently removes the commands and seams a repository is built around,
     * and "not a known command" sends the reader looking in the wrong place. `commands` can match
     * nothing legitimately - `.rman/*.js` is its default and most repositories have no such
     * directory.
     */
    if (!files.length) {
      /**
       * **A package name gets the answer it is actually asking for.** A bare `rman-node` here is a
       * glob matching nothing, and "matched no file" sends the reader off to check their paths -
       * when what they wrote is a *package*, whose config reaches a repository through `extends`.
       * Measured before this branch existed: `plugins: ['rman-node']` exited 1 saying only that a
       * glob matched nothing, while two documents promised a message naming the fix.
       *
       * It survives to here only because `anchorContributions` leaves a package-shaped entry alone
       * rather than turning it into `<dir>/rman-node`, which would erase the evidence.
       */
      const isPackageName = /^(?:@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*$/i.test(entry) && !/\.[cm]?js$/i.test(entry);
      if (isPackageName) {
        /** **A name rman itself ships gets pointed at the preset, not at a package.** `node` is
         *  also a real package on npm, so the general message would send the reader to install
         *  something that has no rman config in it - and the thing they meant is one prefix away. */
        const preset = presetNames().includes(entry) ? `${PRESET_PREFIX}${entry}` : entry;
        throw new Error(
          `"${key}" entry "${entry}" looks like a name, and this key does not take one - it takes ` +
            `an instance, or a glob naming modules that export one. Write ` +
            `\`extends: "${preset}"\` instead, which merges everything that config declares ` +
            `underneath your own.`,
        );
      }
      throw new Error(`"${key}" glob "${entry}" matched no file. A contribution that does not load is not one.`);
    }

    const out: { value: unknown; file: string }[] = [];
    /** Sorted and de-duplicated so two globs naming one file load it once, and so the order a
     *  repository gets does not depend on the filesystem's. Order decides which platform claims a
     *  directory, so it must not vary between machines. */
    for (const file of [...new Set(files.map(f => path.resolve(f)))].sort()) {
      const mod: any = await import(pathToFileURL(file).href);
      /** `default` only, never the module object: a module's named exports are its API, and taking
       *  the whole namespace would accept a file that exports a plugin *among other things* as
       *  though the file were one. */
      const exported = mod?.default;
      if (exported === undefined) {
        throw new Error(`"${key}" matched "${file}", which has no default export.`);
      }
      out.push({ value: exported, file });
    }
    return out;
  }

  /**
   *
   * @protected
   */
  protected _resolveExtendTarget(target: string, from: string, label: string): string {
    const dir = path.dirname(path.resolve(from));
    if (target.startsWith(PRESET_PREFIX)) return this._resolvePreset(target.slice(PRESET_PREFIX.length), label);
    if (target.startsWith('.') || path.isAbsolute(target)) {
      const candidate = path.resolve(dir, target);
      const found = EXTEND_EXTENSIONS.map(ext => candidate + ext).find(
        f => fs.existsSync(f) && fs.statSync(f).isFile(),
      );
      if (!found) throw new Error(`"${label}" target "${target}" was not found, resolved from "${from}"`);
      return found;
    }
    try {
      return createRequire(pathToFileURL(path.join(dir, 'noop.js'))).resolve(target);
    } catch {
      try {
        return createRequire(import.meta.url).resolve(target);
      } catch {
        throw new Error(
          `"${label}" target "${target}" could not be resolved from "${from}" - is it installed in this repository?`,
        );
      }
    }
  }

  /**
   * Where one of rman's own presets lives - `extends: "rman:node"`.
   *
   * A preset is an ordinary config that happens to ship with rman: it contributes a technology, the
   * commands that belong to it and its publish target, and it reaches a repository the same way any
   * other config does.
   */
  /* **A `rman:` prefix rather than a bare name**, and the reason is what a bare name would cost
   * *later*. `node` is a real package on npm, so `extends: "node"` is already ambiguous - but the
   * durable problem is that adding a preset called `docker` next year would silently change what
   * `extends: "docker"` means for a repository that meant the package. A prefixed namespace is
   * closed: nothing rman adds can ever shadow something a repository already names. The same shape
   * eslint uses for its own (`eslint:recommended`).
   *
   * Resolved against this module rather than the repository - a preset is rman's, wherever rman is
   * installed. */
  protected _resolvePreset(name: string, label: string): string {
    if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
      throw new Error(`"${label}" preset name "${name}" is not a name - write \`${PRESET_PREFIX}node\`.`);
    }
    /** Resolved against the presets directory's own location, by extension: `.js` is the published
     *  layout and `.ts` is the source tree a spec runs in. A built package never holds the second,
     *  so trying it costs one `existsSync` and keeps one code path for both. The directory says
     *  where it is (`PRESETS_DIR`) - a path computed here breaks silently when either file moves,
     *  which is exactly what happened. */
    const base = path.resolve(PRESETS_DIR, name);
    const found = PRESET_EXTENSIONS.map(ext => base + ext).find(f => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!found) throw new Error(`"${label}" has no preset "${name}". rman ships: ${presetNames().join(', ')}.`);
    return found;
  }
}

export namespace ConfigReader {
  /** What a `"[...]"` key resolves to - see {@link ConfigReader.parseSelector}. */
  export interface ParsedSelector {
    /**
     * What `test` is asked about:
     *
     * - `'root'` - nothing; the root is matched by *being* the root.
     * - `'platform'` - the package's `platform.name`.
     * - `'package'` - the package's `selector`.
     *
     * A glob and a platform block both match packages below the root, never the root itself - its
     * address is `"[/]"`.
     */
    scope: 'root' | 'package' | 'platform';
    /** Whether a package's selector is one this key speaks for. Always `true` for a root key, which
     *  is matched by *being* the root rather than by name. */
    test(name: string): boolean;
    /** The technologies a `"[platform:...]"` key names, and nothing for the other two scopes. */
    /* Exposed because `test` alone answers only "does this one match", and nesting has to ask
     * whether an inner block *can* match at all - which for two platform blocks is set
     * intersection, and needs the inner key's names to intersect with. */
    names?: readonly string[];
  }

  export interface Options {
    /** Plugins to start with - the application's. Optional like `platforms`, which it was not: a
     *  plugin used to be how a technology arrived, so a caller always had one. */
    plugins?: Plugin[];
    /**
     * rman's own presets to lay **underneath** this level's config - `['node']`, the bare names
     * `extends: "rman:node"` would have spelled. Omitted or empty, none are applied, which is what
     * every level below the root passes and what a caller wanting a bare core passes too.
     *
     * They are loaded **after** whatever the config declared, so a repository's own technology is
     * asked about a directory first.
     */
    presets?: readonly string[];
    /** Technologies to start with - typically the application's. They come first, so a repository's
     *  own additions are appended after them. */
    platforms?: Platform[];
  }

  export interface Context {
    dirname: string;
    plugins: Plugin[];
    platforms: Platform[];
  }

  export interface ResolveResult {
    config: RmanConfig;
    /** Every plugin in play after this read - the ones passed in, plus whatever the config named. */
    plugins: Plugin[];
    /** Every technology in play, in the order it was contributed. A `platforms` entry comes before
     *  one a plugin carried, since a config naming a technology outright is the more direct
     *  statement. */
    platforms: Platform[];
  }

  export interface InterpolateArgs<T = RmanConfig> {
    config: T;
    repository: Repository;
    pkg: Package;
  }
}

/** What marks a selector as naming technologies rather than packages: `"[platform:node]"`.
 *
 *  A `prefix:` inside the brackets rather than a new bracket shape, because the grammar is already
 *  there - `"[ws:*]"` used it before the qualifier was retired. */
const PLATFORM_PREFIX = 'platform:';

/** Accepted spellings of the retired "not the root" qualifier - see `stripWorkspacePrefix`. */
const WORKSPACE_PREFIXES = ['workspace:', 'ws:'] as const;

/** `"[ws:*]"` and `"[workspace:*]"` are the pre-2.x spelling of "not the root", kept working
 *  because they now name the same set a bare glob does. Stripped here so one code path serves both. */
function stripWorkspacePrefix(inner: string): string {
  for (const prefix of WORKSPACE_PREFIXES) if (inner.startsWith(prefix)) return inner.slice(prefix.length);
  return inner;
}

/** The glob inside a selector key, anchored at both ends. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** What an entry turned out to be, for a message that has to say how far off it was. */
function describeEntry(entry: unknown): string {
  if (entry === null) return 'null';
  if (Array.isArray(entry)) return 'an array';
  if (typeof entry === 'object') return 'an object that is not one';
  return `a ${typeof entry}`;
}
