import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRESETS } from '../../builtins/presets/index.js';
import type { RmanConfig } from '../../interfaces/rman-config.interface.js';
import type { RmanApplication } from '../application.js';
import { ConfigReader } from '../config/config-reader.js';
import { mergeConfig, ORIGINS } from '../config/merge-config.js';
import { basePlatform, type Platform, type Plugin } from '../interfaces/plugin.js';
import { Package } from './package.js';

/**
 * A repository's layout, resolved: which directories hold packages, which technology claims each of
 * them, what each one answers to, and the **raw** config each one ends up with.
 *
 * Built with {@link Workspace.create}, which runs the whole resolution; the constructor is
 * protected, so there is no such thing as a half-built workspace.
 *
 * The configs it produces are **raw** - every `${{ }}` and every value function is still
 * unevaluated. Resolving one needs `pkg`, `repository` and `git`, which belong to the repository
 * rather than to its layout; `ConfigInterpolator` is the step after this.
 */
/* The three steps live together because they depend on each other in one direction only: the root's
 * config names the plugins, the plugins decide which directories are packages, and a package's
 * config is the directory chain above it layered together. None of it can be done out of order, and
 * each step is useless on its own.
 *
 * Every step is an overridable `protected` method, so a technology or a spec can replace one and
 * keep the rest. */
export class Workspace {
  /** The repository root - where the walk starts and what every directory chain is relative to. */
  readonly rootDir: string;

  /** Every plugin in play, in load order: the ones passed in first, then each level's own. */
  readonly plugins: Plugin[] = [];

  /** Every technology in play, in contribution order - which is what decides who claims a
   *  directory, since the first that recognizes it wins. */
  readonly platforms: Platform[] = [];

  /** The root directory's own package. Not one of `packages`, which holds the members. */
  rootPackage!: Package;

  /** Every package below the root, depth-first. */
  readonly packages: Package[] = [];

  /** Each directory's own config, read once - see `_readLevel`. */
  private _levels = new Map<string, ConfigReader.ResolveResult>();

  /** The packages whose selector came from a `"name"` declaration rather than from their platform,
   *  for the clash message alone. */
  private _declaredSelectors = new Set<Package>();

  /** Built on first use, unless `options.reader` supplied one. */
  private _configReader?: ConfigReader;

  /**
   * Builds a workspace and resolves it: discovery, selectors, and every package's raw config.
   *
   * A subclass inherits this and gets an instance of itself. Its declared return type stays
   * `Workspace`, so a subclass wanting its own declares a one-line `create` that calls this.
   *
   * @param rootDir the repository root
   */
  /* **`new this()`, not `new Workspace()`.** In a static method `this` is the class the call was
   * made on, so a subclass inheriting this factory builds itself; hard-coding the name would let
   * someone override `_init` and never see it run. The spec for it asserts `instanceof` on the
   * subclass.
   *
   * **The return type is a TypeScript limit rather than a choice.** The polymorphic form
   * (`this: new (...) => T`) requires a *publicly* constructible class, and the constructor here is
   * protected on purpose. The two cannot both be had, and the guard is worth more than the inferred
   * type. */
  static async create(rootDir: string, options: Workspace.Options): Promise<Workspace> {
    const workspace = new (this as typeof Workspace)(rootDir, options);
    await workspace._init();
    return workspace;
  }

  /** Use {@link Workspace.create}. */
  /* Protected because an un-initialized workspace is a half-built object - no packages, no configs,
   * and nothing saying so. */
  protected constructor(
    rootDir: string,
    protected readonly options: Workspace.Options,
  ) {
    this.rootDir = path.resolve(rootDir);
    this.plugins = [...(options.plugins ?? [])];
    this.platforms = [...(options.platforms ?? [])];
  }

  /** The package at a directory, root included, or `undefined` for one that holds none. */
  packageAt(dirname: string): Package | undefined {
    const resolved = path.resolve(dirname);
    if (this.rootPackage && this.rootPackage.dirname === resolved) return this.rootPackage;
    return this.packages.find(pkg => pkg.dirname === resolved);
  }

  /** The whole resolution, in the one order the steps admit. */
  /* Each line is a `protected` method rather than inline code precisely so this reads as the order
   * and nothing else - and so a subclass replacing one step does not have to restate the rest. */
  protected async _init(): Promise<void> {
    await this._discover();
    await this._resolveSelectors();
    this._assertUniqueSelectors();
    await this._resolveConfigs();
  }

  /**
   * Descends from the root, asking each directory's own technology where its children are, and
   * fills `rootPackage` and `packages`.
   *
   * One step, repeated: read the directory's config (which loads whatever plugins it names and
   * decides its platform), then ask *that* platform's `getWorkspace` for the directories below it
   * holding packages. A directory is visited once, and `options.deep` bounds the descent.
   */
  /* **First visit wins.** A provider may legitimately name a directory another one already claimed
   * (two overlapping globs, a symlinked package), and one naming an ancestor would otherwise
   * recurse forever.
   *
   * `deep` bounds the descent for the same reason `findRoot` bounds its climb: a provider computing
   * paths rather than reading them can produce a chain that never ends, and a guessed depth beats a
   * hang with nothing printed. */
  protected async _discover(): Promise<void> {
    const visited = new Set<string>();
    const descend = async (dir: string, parent: Package | undefined, remaining: number) => {
      const dirname = path.resolve(dir);
      visited.add(dirname);
      const level = await this._readLevel(dirname);
      const platform = this._platformFor(dirname, level.config);
      /** The platform is handed over rather than searched for: the walk that found this directory
       *  is what established it, and `Package` re-guessing would be a second answer that can
       *  disagree with the first. */
      const pkg = this._createPackage(dirname, platform);
      if (dirname === this.rootDir) this.rootPackage = pkg;
      else this.packages.push(pkg);
      if (parent) {
        /** `children` is enumerable and `parent` is not: one edge, and only one direction can be
         *  the one a walk follows - a `Package` that can be serialized needs the back-reference
         *  hidden. */
        parent.children.push(pkg);
        Object.defineProperty(pkg, 'parent', { value: parent, enumerable: false, configurable: true });
      }
      if (remaining <= 0) return;

      /** **Its own platform is asked, and nobody else.** A platform that did not claim the
       *  directory has no standing to say what is under it. A directory no technology claimed has
       *  no `getWorkspace`, hence no children - which is a single-package repository arrived at
       *  rather than guessed. */
      for (const child of platform.getWorkspace?.(dirname) ?? []) {
        const childDir = path.resolve(child);
        if (visited.has(childDir)) continue;
        await descend(childDir, pkg, remaining - 1);
      }
    };
    await descend(this.rootDir, undefined, this.options.deep ?? 10);
  }

  /**
   * Gives every package the selector it answers to - its `.rmanrc "name"` when it declares one, and
   * what its platform says otherwise.
   *
   * `"[glob]"` and `--scope` match this, never the package's name: a name is an *ecosystem's*
   * promise rather than rman's.
   */
  /* **Resolved from a cascade run with no selector at all**, and that is the step whose absence is
   * silent: a `"[pkg-a]"` block is applied on the strength of the selector, and the selector comes
   * from `name`, which is inside the very config being resolved. Reading `name` while applying
   * selector blocks would need the answer in order to find it. So the chain is walked twice -
   * unmarked only, then for real - over one directory cache, which is what keeps the second pass
   * free.
   *
   * `name` is refused inside a glob block for exactly this reason (`_assertSelectorBlocks`), so
   * nothing is lost by the first pass ignoring them. */
  protected async _resolveSelectors(): Promise<void> {
    for (const pkg of [this.rootPackage, ...this.packages]) {
      const config = await this._cascade(pkg, undefined);
      const declared = config.name;
      if (declared !== undefined && (typeof declared !== 'string' || !declared.trim())) {
        throw new Error(
          `"name" takes the selector this package answers to - "${pkg.dirname}" gave ${typeof declared}.`,
        );
      }
      if (declared !== undefined) this._declaredSelectors.add(pkg);
      /** `platformSelector()` is the package's own - the manifest's name, or whatever its platform
       *  says addresses it. `Package` already computed it in its constructor; this only replaces it
       *  when the config declared one. */
      pkg.selector = declared?.trim() || pkg.platformSelector();
    }
  }

  /**
   * Refuses two packages answering to one selector. The root is exempt - a glob never matches it and
   * `"[/]"` needs no name, so it shares an address with nobody.
   */
  /* Two packages answering to one selector make `"[that]"` and `--scope that` ambiguous *silently* -
   * the config reaches both and a lookup returns the first.
   *
   * `name` cascades like every unmarked key, so one declaration above two packages is the usual way
   * in - and the message says so when that is what happened, since the fix is different. */
  protected _assertUniqueSelectors(): void {
    const bySelector = new Map<string, Package>();
    for (const pkg of this.packages) {
      const clash = bySelector.get(pkg.selector);
      if (clash) {
        const cascaded = this._declaredSelectors.has(pkg) && this._declaredSelectors.has(clash);
        throw new Error(
          `Two packages answer to the selector "${pkg.selector}":\n  ${clash.dirname}\n  ${pkg.dirname}\n` +
            `  A selector has to be unique - "[${pkg.selector}]" and \`--scope ${pkg.selector}\` ` +
            `cannot mean two packages.` +
            (cascaded
              ? `\n  Both got it from one cascading "name" declaration above them; declare it in ` +
                `each package's own ".rmanrc" instead.`
              : ''),
        );
      }
      bySelector.set(pkg.selector, pkg);
    }
  }

  /** Cascades every package's config into `Package.rawConfig`, now that the selectors are known.
   *  Still raw - `Repository` is what interpolates it into `Package.config`. */
  protected async _resolveConfigs(): Promise<void> {
    for (const pkg of [this.rootPackage, ...this.packages]) {
      pkg.rawConfig = await this._cascade(pkg, pkg.selector);
    }
  }

  /**
   * Every directory from the root down to `pkg`, layered into one config.
   *
   * Two layers per level: the level's unmarked keys first, then the `"[selector]"` blocks that
   * speak for this package, in the order they were written - later wins, as `overrides` does in
   * eslint and prettier.
   *
   * @param selector what the blocks are matched against; `undefined` skips them, except `"[/]"` for
   *   the root, which is structural and needs no selector.
   */
  /* **Unmarked first because it is the widest thing the level says** - it configures that directory
   * *and every package under it*, so it is the level's floor. A selector block written *above* the
   * plain keys still beats them: unmarked is not a fourth selector, it is the layer that also feeds
   * the directories below, and making that depend on key order in the file would be absurd. */
  protected async _cascade(pkg: Package, selector: string | undefined): Promise<RmanConfig> {
    const result: RmanConfig = {};
    const audience: Workspace.Audience = {
      isRoot: pkg.dirname === this.rootDir,
      selector,
      platform: pkg.platform.name,
    };
    for (const dir of this._dirChain(pkg.dirname)) {
      const level = await this._readLevel(dir);
      mergeConfig(result, this._stripSelectors(level.config));
      for (const block of this._matchingSelectors(level.config, audience)) {
        mergeConfig(result, block);
      }
    }
    return result;
  }

  /** One directory's own config, read once and cached. Plugins the level names are loaded here and
   *  accumulated into `plugins`. */
  /* The cache is what makes the two cascade passes affordable - twenty packages sharing a root
   * means that root is read once rather than forty times. It is also what keeps a level's plugins
   * from being loaded a second time. */
  protected async _readLevel(dirname: string): Promise<ConfigReader.ResolveResult> {
    const resolved = path.resolve(dirname);
    const hit = this._levels.get(resolved);
    if (hit) return hit;
    const result = await this._reader().resolve(resolved, {
      plugins: this.plugins,
      platforms: this.platforms,
      /** **The root alone**, because that is the level they belong to: everything below it inherits
       *  whatever the root settled on, and laying them down again there would put a preset's
       *  technology ahead of one an intermediate directory declared. */
      presets: resolved === this.rootDir ? (this.options.presets ?? DEFAULT_PRESETS) : undefined,
    });
    /** Whatever this level added, in the order it was loaded - `plugins` appends, never replaces,
     *  so a level naming one never means "and drop the ones above me". The technologies a plugin
     *  carries are already in `result.platforms`; the reader puts them there, so this walk and the
     *  reader cannot end up with two orders. */
    for (const plugin of result.plugins) {
      if (!this.plugins.some(p => p.name === plugin.name)) this.plugins.push(plugin);
    }
    for (const platform of result.platforms) this._addPlatform(platform);
    this._levels.set(resolved, result);
    return result;
  }

  /** Appends a technology unless one already answers to its name. */
  protected _addPlatform(platform: Platform): void {
    if (!this.platforms.some(p => p.name === platform.name)) this.platforms.push(platform);
  }

  /** The reader levels are read with - `options.reader`, or a default one. */
  protected _reader(): ConfigReader {
    return (this._configReader ??= this.options.reader ?? new ConfigReader());
  }

  /** Root, then every directory down to `targetDir`, inclusive. A target outside the root is the
   *  root alone. */
  protected _dirChain(targetDir: string): string[] {
    const rel = path.relative(this.rootDir, targetDir);
    if (!rel || rel === '.' || rel.startsWith('..')) return [this.rootDir];
    const dirs = [this.rootDir];
    let dir = this.rootDir;
    for (const segment of rel.split(path.sep)) {
      dir = path.join(dir, segment);
      dirs.push(dir);
    }
    return dirs;
  }

  /** One config object's own settings - everything that is not a `"[...]"` block. Shallow: a block
   *  is dropped whole, and what is inside it is the caller's business. */
  /* **The symbols travel with it, and leaving them behind was a measured loss.** `mergeConfig` reads
   * a key's origin and its `value` chain off the *source* object under `ORIGINS` / `PREVIOUS_VALUES`,
   * so a copy that carries only string keys arrives with neither. Measured on one repository before
   * this line existed: a bad expression in an unmarked key reported `Invalid expression in "group"`
   * with no file, while the identical expression inside a `"[*]"` block reported
   * `... ("group" (.rmanrc.yml))` - because a selector block was merged as itself and only the
   * unmarked layer came through here. Nesting would have spread that to the blocks too. */
  protected _stripSelectors(config: RmanConfig): RmanConfig {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) if (!ConfigReader.isSelectorKey(key)) result[key] = value;
    for (const symbol of Object.getOwnPropertySymbols(config)) {
      Object.defineProperty(result, symbol, Object.getOwnPropertyDescriptor(config, symbol)!);
    }
    return result as RmanConfig;
  }

  /**
   * The layers in `config` that speak for this package, in the order they are merged.
   *
   * `"[/]"` matches the root and nothing else; a glob matches a package's selector and never the
   * root. **A block may hold further selector blocks**, which narrow it: a nested one applies only
   * where its own audience and every audience it sits inside all match.
   */
  /* **A glob never matching the root removes two traps at once**: `"[my-*]"` cannot quietly pick up
   * a repository whose root package is called `my-repo`, and `"[*]"` cannot hand a package-shaped
   * setting to a root with no build directory to apply it to. A root block needs no selector, which
   * is what makes `/` structural.
   *
   * **Nesting is depth-first pre-order, which is the level's own rule applied again rather than a
   * new one**: a block's own keys are its floor, then the blocks written inside it in declaration
   * order, then the next block beside it. So the layer order for
   * `"[platform:node]" { a, "[pkg-*]" { b } }, "[*]" { c }` is `a, b, c` - and the last word is
   * still whatever was written last, *not* whatever is most specific. That is the same cost the
   * dropped specificity ranking already documents (a catch-all written below a narrower block
   * overrides it), and nesting neither adds to it nor asks the tiebreak question again: two blocks
   * that both match are siblings whatever depth they sit at, and declaration order answers them.
   *
   * **A matching block is contributed *stripped*, not whole.** Merging it as it stands put its
   * nested keys into the resolved config as literal `'[pkg-*]'` entries, which is precisely how the
   * old no-op showed up in `rman config` looking as though it had worked.
   *
   * **A platform block speaks for the root too, and only a glob is held off it.** `"[platform:node]"`
   * asks `pkg.platform.name` and the root is a package with a platform, so
   * `"[platform:node]" > "[/]"` is *the root, when the root is a node package* and
   * `"[platform:node]" > "[*]"` is *its packages* - which is the whole of a technology's shared
   * config in one block, `vars` included.
   *
   * A narrower rule was tried first and measured wrong: let a chain reach the root only where it
   * *names* `"[/]"`, keeping a plain `"[platform:node]"` off the root as before. It answers the pair
   * correctly and still breaks the case it was written for - the nested `"[/]"` could not read the
   * `vars` its parent declared (`vars is not defined`), because those are the parent's own keys.
   * Narrowing an audience and hiding the enclosing block's settings from it are different things,
   * and only the first is what nesting means.
   *
   * The cost, stated rather than hidden: a package-shaped setting written **directly** under a
   * platform block now reaches the root as well - the trap that keeps globs off it. It is not the
   * same trap, because neither half of that one applies here: `platform:node` is not a name and
   * cannot match by accident, and it is not a catch-all. And with nesting the spelling for
   * package-shaped settings is `"[platform:node]" > "[*]"`, which says so. */
  protected _matchingSelectors(config: RmanConfig, audience: Workspace.Audience): RmanConfig[] {
    const matches: RmanConfig[] = [];
    for (const [key, value] of Object.entries(config)) {
      if (!ConfigReader.isSelectorKey(key) || !value || typeof value !== 'object') continue;
      const { scope, test } = ConfigReader.parseSelector(key);
      if (!this._speaksFor(scope, test, audience)) continue;
      const block = value as RmanConfig;
      matches.push(this._stripSelectors(block));
      matches.push(...this._matchingSelectors(block, audience));
    }
    return matches;
  }

  /**
   * Whether one selector block speaks for this package.
   *
   * `"[/]"` asks only whether this *is* the root. Everything else matches packages **below** the
   * root and never the root itself, which is addressed structurally or not at all.
   */
  /* **A glob never matching the root removes two traps at once**: `"[my-*]"` cannot quietly pick up
   * a repository whose root package is called `my-repo`, and `"[*]"` cannot hand a package-shaped
   * setting to a root with no build directory to apply it to. Neither trap exists for a platform
   * block - `platform:node` is not a name and cannot match by accident, and it is not a catch-all -
   * so **a platform link answers about the root like any other package**, and what keeps a plain
   * `"[platform:node]"` off the root is `_matchingSelectors`' chain rule rather than a refusal here.
   * Asking `isRoot` first was what made `"[platform:node]" > "[/]"` unanswerable: the pair says *the
   * root, when it is a node package*, and the short-circuit never let the platform question be put.
   *
   * A package no technology claimed carries `basePlatform`, whose name is `''`, so it matches no
   * platform block at all - `parseSelector`'s test refuses an empty name rather than letting an
   * empty selector quietly match it. */
  protected _speaksFor(
    scope: ConfigReader.ParsedSelector['scope'],
    test: (value: string) => boolean,
    audience: Workspace.Audience,
  ): boolean {
    if (scope === 'root') return audience.isRoot;
    if (scope === 'platform') return test(audience.platform);
    return !audience.isRoot && audience.selector !== undefined && test(audience.selector);
  }

  /**
   * The platform that claims a directory - the one its config names, or the first loaded platform
   * whose manifest provider recognizes it. `basePlatform` when none does, so a caller needs no
   * guard; a *declared* platform no plugin provides is an error.
   */
  /* `ConfigReader` already decided the name, from a declaration or by asking the loaded plugins, so
   * this only has to find the platform that answers to it. */
  protected _platformFor(dirname: string, config: RmanConfig): Platform {
    const declared = this._declaredPlatformName(config);
    if (declared === undefined) {
      return this.platforms.find(p => p.manifestProvider.read(dirname)) ?? basePlatform;
    }

    const named = this.platforms.find(p => p.name === declared);
    if (!named) {
      const have = this.platforms.map(p => p.name).filter(Boolean);
      throw new Error(
        `"platform" names "${declared}" (${this._originOf(config, 'platform')}), which is not a ` +
          `platform this repository has. ` +
          `${have.length ? `Registered: ${have.join(', ')}. ` : 'None is registered. '}` +
          `Contribute it with "platforms", or inherit it with "extends".`,
      );
    }

    /** **A declaration is held to the directory it names.** The failure it replaces is invisible:
     *  the manifest reads as nothing, so the package is named after its directory at `0.0.0` and
     *  the repository looks fine. The message names the file the platform looked for, because that
     *  is the thing to go and check. */
    if (!named.manifestProvider.read(dirname)) {
      throw new Error(
        `"${dirname}" declares \`platform: '${declared}'\` (${this._originOf(config, 'platform')}), ` +
          `and "${declared}" does not recognize it - it looks for "${named.manifestProvider.fileName}".`,
      );
    }
    return named;
  }

  /** A platform named unmarked or under `"[/]"` - both are the directory saying what it is. */
  /* **An expression is refused rather than read as a literal.** `platform` is consulted before any
   * package exists - it is what decides what a package *is* - so there is no `pkg` for an
   * expression to be about, and interpolation runs long afterwards. Passed through, a `${{ }}` here
   * reached the lookup as its raw text and failed as an unknown platform name, which sends the
   * reader to check their `platforms` instead of the line they wrote.
   *
   * A value that is not a usable string is refused too, rather than read as "declared nothing": the
   * two are opposite answers, and the silent one leaves a directory claimed by whichever technology
   * happened to recognize it. */
  protected _declaredPlatformName(config: RmanConfig): string | undefined {
    const root = (config as Record<string, any>)['[/]'];
    const declared = config.platform ?? (root && typeof root === 'object' ? root.platform : undefined);
    if (declared === undefined) return undefined;
    const where = this._originOf(config, 'platform');
    if (typeof declared !== 'string' || !declared.trim()) {
      throw new Error(`"platform" takes a platform's name - ${where} gave ${typeof declared}.`);
    }
    if (declared.includes('${{')) {
      throw new Error(
        `"platform" cannot be an expression (${where}) - it is read while the packages are still ` +
          `being found, so there is no package for one to be about. Write the name, and use a ` +
          `package's own ".rmanrc" where the answer differs.`,
      );
    }
    return declared.trim();
  }

  /** Which file a key came from, for an error that can be acted on. */
  /* A config is merged from a directory's own forms, an `extends` base, every `"[selector]"` block
   * and one layer per directory before anything reads it, so the key alone leaves the reader
   * searching all of them. `mergeConfig` records one file per key under `ORIGINS`. */
  protected _originOf(config: RmanConfig, key: string): string {
    const origins = (config as Record<symbol, unknown>)[ORIGINS] as Record<string, string> | undefined;
    return origins?.[key] ? `in "${origins[key]}"` : `the "${key}" key`;
  }

  /** Where a `Package` is made, and the only place - override it to build a subclass of `Package`
   *  and keep the rest of the walk. */
  protected _createPackage(dirname: string, platform: Platform): Package {
    return new Package(dirname, this.options.app, platform);
  }
}

/**
 * How a repository is laid out, and who decides.
 *
 * A namespace for the same reason `Manifest` is one: it is what a plugin can *augment*
 * (`declare module 'rman' { namespace Workspace { ... } }`), so whatever this seam grows later
 * arrives as a member here rather than as another top-level export. It merges with the class above,
 * so `Workspace.walk` and `Workspace.create` are reached the same way.
 */
export namespace Workspace {
  /** Who a selector block is being matched against - one package, as the three questions a block
   *  can ask about it. */
  export interface Audience {
    /** Whether this is the root package, which `"[/]"` asks and every other block refuses. */
    isRoot: boolean;
    /** What a glob matches. `undefined` on the first cascade pass, where the selector is still
     *  being worked out - see `_resolveSelectors` - so glob blocks are skipped. */
    selector: string | undefined;
    /** What `"[platform:...]"` matches. `''` for a package no technology claimed. */
    platform: string;
  }

  export interface Options {
    /** The application every `Package` is constructed against. */
    /* Required only because `Package` takes one. A package needs it once, to find out which
     * technology claims its directory - and this walk always knows that already, so it is handed
     * over and never consulted. `import type` keeps it off the runtime graph here. */
    app: RmanApplication;
    /** Plugins to start with - typically the built-ins. They come first, so a repository's own
     *  additions are appended after them. */
    /* Handed in rather than imported, so this file never reaches into `plugins/`. */
    plugins?: Plugin[];
    /** Technologies to start with - typically a preset's. They come first, so a repository's own
     *  additions are appended after them. */
    platforms?: Platform[];
    /**
     * rman's own presets, laid under the **root**'s config. Defaults to {@link DEFAULT_PRESETS}; an
     * empty list is a caller asking for a bare core, with nothing but what it registered itself.
     */
    presets?: readonly string[];
    /** How far the walk descends before giving up. Defaults to 10. */
    deep?: number;
    /** The reader levels are read with. Supply one to read from somewhere other than the disk. */
    reader?: ConfigReader;
  }

  /**
   * **Where one directory's own child packages are** - the directories immediately below it that
   * hold a package, as absolute paths. `undefined` for "this is not a directory I recognize".
   *
   * **A provider answers for one directory, not for the repository**, and that is the whole
   * correction. It used to be `(root) => { root, packageDirs }`: asked once, at the top, by the
   * first platform that recognized it - so in a polyglot repository the technology listed first in
   * `plugins` decided which directories were packages *at all*. Measured, and documented as a known
   * limitation for a year: a `Cargo.toml`-only package was simply not found until a provider that
   * looks for both was listed first.
   *
   * Asked per directory, each platform only ever answers about its own packages - which is all a
   * platform knows - and the recursion is the core's (see `walk`). A Cargo workspace nested inside
   * a Node monorepo is then just a node in the tree whose children came from a different platform.
   *
   * **Children, not descendants.** A provider returning the whole subtree would have to know what
   * the platforms below it consider a package; returning one level means it never has to. npm's
   * `workspaces` globs are already one level by construction (`deep: 0`).
   *
   * Still directories rather than `Package` objects, for the reason it always was: discovery runs
   * before any package exists, so a provider returning packages would make discovery the owner of
   * identity too. A path is also unique by construction, where a name is only unique if the
   * ecosystem says so.
   */
  export type Provider = (dir: string) => string[] | undefined;

  /**
   * One directory in the walk's result: which technology claimed it, and what sits below it.
   *
   * A plain tree rather than `Package`s, keeping the line `Provider` draws: `Repository.create`
   * turns this into packages, so identity stays with the manifest provider and discovery stays
   * with this one.
   */
  export interface Node {
    /** Absolute path to the directory. */
    dirname: string;
    /** The technology that claimed it - `basePlatform` when none did, so a reader needs no guard. */
    platform: Platform;
    /** The nodes for the package directories directly below it, in the order the platform gave
     *  them. Empty for a leaf. */
    children: Node[];
  }

  /**
   * What a directory's `.rmanrc "platform"` resolves to, when it declares one - `undefined` when
   * it says nothing, so the walk falls back to the guess.
   *
   * **A callback rather than config knowledge in here**, which keeps this namespace answering one
   * question. Reading a directory's cascaded config, deciding that a declared name has to be
   * loaded, and refusing one that cannot be, are all the repository's business; where the packages
   * are is this one's. `Repository.create` supplies it - and it is also the seam a spec uses to
   * drive the declaration path without writing a config file.
   */
  export type DeclaredPlatform = (dir: string) => Promise<Platform | undefined>;

  /**
   * **The walk**: descend from `rootDir`, asking each directory's own technology where its children
   * are, and repeating for each answer.
   *
   * One step, applied recursively:
   *
   * 1. take the directory's **declared** platform if it has one, and otherwise the first registered
   *    platform whose manifest provider recognizes it (`app.platformFor`, `basePlatform` if none);
   * 2. ask **that** platform's `getWorkspace` for the directories below it holding packages;
   * 3. do the same for each of them.
   *
   * **A declaration wins, and is then held to it.** A platform named for a directory it does not
   * recognize is a statement that is simply untrue, and the failure it would otherwise become is
   * invisible: the manifest reads as nothing, so the package is named after its directory at
   * `0.0.0` and the repository looks like it works. The error names the directory, the platform and
   * the file that platform looked for.
   *
   * The root node always exists - a repository is a package whatever its technology - so this never
   * returns `undefined`. A repository nobody recognizes is a root with no children, which is the
   * single-package answer arrived at rather than guessed.
   *
   * **A directory is visited once.** A provider may legitimately name a directory another one
   * already claimed (two globs overlapping, a symlinked package), and a provider naming an ancestor
   * would otherwise recurse forever. First visit wins, so a package sits where it was first found.
   *
   * `deep` bounds the descent for the same reason `findRoot` bounds its climb: a provider computing
   * paths rather than reading them can produce a chain that never ends, and a guessed depth is
   * better than a hang with nothing printed.
   */
  export async function walk(
    app: RmanApplication,
    rootDir: string,
    options?: { deep?: number; declared?: DeclaredPlatform },
  ): Promise<Node> {
    const visited = new Set<string>();
    const descend = async (dir: string, remaining: number): Promise<Node> => {
      const resolved = path.resolve(dir);
      visited.add(resolved);
      const declared = await options?.declared?.(resolved);
      if (declared && !declared.manifestProvider.read(resolved)) {
        throw new Error(
          `"${resolved}" declares \`platform: '${declared.name}'\`, and that platform does not ` +
            `recognize it - it looks for "${declared.manifestProvider.fileName}". Either the ` +
            `directory is not a ${declared.name} package, or the declaration belongs one level down.`,
        );
      }
      const platform = declared ?? app.platformFor(resolved);
      const node: Node = { dirname: resolved, platform, children: [] };
      if (remaining <= 0) return node;
      /**
       * **Its own platform is asked, and nobody else.** A platform that did not claim the directory
       * has no standing to say what is under it - that was the old first-wins rule, one level up.
       * `basePlatform` has no `getWorkspace`, so a directory no technology claimed has no children,
       * which is the documented behaviour of a repository naming no plugin.
       */
      for (const child of platform.getWorkspace?.(resolved) ?? []) {
        const childDir = path.resolve(child);
        if (visited.has(childDir)) continue;
        node.children.push(await descend(childDir, remaining - 1));
      }
      return node;
    };
    return descend(rootDir, options?.deep ?? 10);
  }

  /** Every node below `node`, depth-first, excluding `node` itself - the flat list `Repository`
   *  reports as its packages, since the root is not one of its own members. */
  export function flatten(node: Node): Node[] {
    return node.children.flatMap(child => [child, ...flatten(child)]);
  }

  /**
   * Where the repository starts, decided **without knowing anything about any ecosystem** - it has
   * to be, because the plugins that do know are named in the config file this walk is looking for.
   *
   * Walking up from `from`, stopping after a directory holding `.git`, the root is:
   *
   * 1. the **outermost** directory in that chain holding an `.rmanrc*` - outermost, because a
   *    *package* may have its own `.rmanrc` (that is a supported thing), and from inside such a
   *    package the nearest one is the package's, not the repository's;
   * 2. otherwise the `.git` directory itself, the ordinary meaning of "repository root";
   * 3. otherwise `from`, which is all that is left to go on.
   *
   * **What "outermost" costs**, since the two cases genuinely conflict and only one can win: a
   * self-contained project nested inside a larger git repository *and sharing its `.git`* resolves
   * to the outer root, not to itself (measured). That is the same repository by any definition git
   * recognizes, so it is the defensible answer - and a nested project with a `.git` of its own is
   * found correctly, because the walk stops there before the outer `.rmanrc` is ever seen (also
   * measured). A per-package `.rmanrc` is the common case and it is the one served.
   */
  export function findRoot(from: string, deep = 10): string {
    const chain: string[] = [];
    let dir = path.resolve(from);
    let remaining = deep;
    while (remaining-- >= 0 && fs.existsSync(dir)) {
      chain.push(dir);
      if (fs.existsSync(path.join(dir, '.git'))) break;
      const parent = path.resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }

    const withConfig = chain.filter(hasRmanConfig);
    if (withConfig.length) return withConfig[withConfig.length - 1];

    const gitRoot = chain.find(d => fs.existsSync(path.join(d, '.git')));
    return gitRoot ?? path.resolve(from);
  }

  /** Every file form a `.rmanrc` comes in - `package.json#rman` is deliberately *not* one of them
   *  here: it would make the root question npm-shaped again. */
  const CONFIG_FILES = ['.rmanrc', '.rmanrc.yml', '.rmanrc.cjs', '.rmanrc.mjs', '.rmanrc.js'];

  function hasRmanConfig(dir: string): boolean {
    return CONFIG_FILES.some(name => fs.existsSync(path.join(dir, name)));
  }
}
