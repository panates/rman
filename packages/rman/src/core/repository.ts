import { execFileSync } from 'node:child_process';
import colors from 'ansi-colors';
import path from 'path';
import semver from 'semver';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { detectBuiltin, type DetectedBuiltin } from '../plugins/detect.js';
import { GitHelper } from '../utils/git.js';
import { RmanApplication } from './application.js';
import {
  type CachedFile,
  type ConfigScope,
  createFileScope,
  createReadScope,
  DEFERRED_PATHS,
  type GitScope,
  interpolateConfig,
  type PackageScope,
  readDirConfig,
  type RepositoryScope,
  resolveConfig,
} from './config.js';
import { Manifest } from './manifest.js';
import { ORIGINS } from './merge-config.js';
import { Package } from './package.js';
import type { Platform } from './plugin.js';
import { loadPlugins, registerPlugin } from './plugin-loader.js';
import { Workspace } from './workspace.js';

export class Repository extends Package {
  readonly rootPackage: Package;
  /** See the `defineProperty` in the constructor - what detection supplied, when it did. */
  readonly detectedBuiltin?: DetectedBuiltin;
  /** Commands the repository's plugins contributed, loaded during `create` because the workspace
   *  providers they bring are needed before any package can be found. `cli.ts` registers them. */
  /**
   * Cached repository scope - see `_repositoryScope`.
   *
   * **Non-enumerable**, and for the same reason `targetVersion` itself is: this cache holds a
   * `PackageScope` per package, each carrying that throwing getter, and it hangs off a `Repository`
   * which every `Package` points back at. Left enumerable, *any* deep walk of a package reached it
   * and threw - measured through a test's own `toEqual` diff, but a `JSON.stringify` or a debugger
   * would do it too, with an error about `version` that has nothing to do with what the caller did.
   * An internal cache has no business being walked anyway.
   */
  private _repoScope?: RepositoryScope;
  /** Cached `${{ git.* }}` facts - see `_gitScope`. Non-enumerable for the same reason as above,
   *  and because reading it is a subprocess: a deep walk of a package must not spawn one. */
  private _git?: GitScope;
  /**
   * Files `${{ read(...) }}` has parsed, shared by every package's scope and keyed by the identity
   * of the bytes - see `readStructuredFile`.
   *
   * **On the repository rather than per scope, and that is the whole point of it**: `configScope`
   * is built once per package, so a cache living there would re-read a repository-level file once
   * for every package that mentions it.
   */
  private readonly _readCache = new Map<string, CachedFile>();

  /**
   * The application this repository belongs to - its services, its technologies, its logger.
   *
   * **Non-enumerable**, like `_repoScope` and `_git` beside it: the two things that walk a
   * repository are `{...pkg}` spreads and the config scope, and an enumerable back-reference to the
   * whole application would be dragged into both. A `Package` deliberately has no such field at
   * all; a repository is never spread or serialized, which is what makes this one safe - measured,
   * rather than assumed.
   */
  readonly app!: RmanApplication;

  protected constructor(
    app: RmanApplication,
    readonly dirname: string,
    readonly monorepo: boolean,
    readonly packages: Package[],
    /** The directory `Repository.create()` was actually invoked from - unlike `dirname` (the
     *  resolved repository root, possibly several levels up), this is where the user's shell
     *  really was. Used by `currentPackage` to scope commands to "the package I'm standing in". */
    readonly cwd: string = dirname,
    /** The root directory's own technology, from the same walk that found the packages - so the
     *  repository and its `rootPackage` agree without either searching the registry again. */
    platform?: Platform,
  ) {
    super(dirname, app, platform);
    Object.defineProperty(this, 'app', { value: app, enumerable: false, writable: false });
    /**
     * What detection decided for this repository, or `undefined` when it declared its own
     * technology (or when there was nothing to detect). Carried here because `_resolveConfigs` runs
     * later and every read of the root's config has to agree with the one decision `create` made.
     *
     * Non-enumerable, like `app` and for the same reason: `{...repository}` and `toEqual` both walk
     * a repository, and bookkeeping that shows up there turns spec failures into diffs about it.
     */
    Object.defineProperty(this, 'detectedBuiltin', { value: undefined, enumerable: false, writable: true });
    this.rootPackage = new Package(dirname, app, platform);
    if (!monorepo) this.packages = [this.rootPackage];
    // Config resolution can load a `.rmanrc.cjs`/`.mjs`/`.js` module (dynamic `import()`, always
    // async) - a constructor can't `await`, so `create()` finishes this instance off via `_init()`
    // once construction itself (synchronous) completes.
  }

  /**
   * The package whose own directory contains `cwd` (the deepest match, so a package nested
   * inside another's directory resolves to the innermost one) - or `undefined` when `cwd` *is*
   * the repository root itself, or isn't inside any known package (e.g. a non-monorepo checkout,
   * or a stray directory the workspace glob doesn't cover).
   */
  get currentPackage(): Package | undefined {
    if (path.resolve(this.cwd) === path.resolve(this.dirname)) return undefined;
    let best: Package | undefined;
    for (const pkg of this.packages) {
      const rel = path.relative(pkg.dirname, this.cwd);
      const isSelfOrDescendant = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (isSelfOrDescendant && (!best || pkg.dirname.length > best.dirname.length)) best = pkg;
    }
    return best;
  }

  getPackages(options?: { scope?: string | string[]; toposort?: boolean }): Package[] {
    let result = [...this.packages];
    if (options?.scope) {
      const scopes = Array.isArray(options.scope) ? options.scope : [options.scope];
      result = result.filter(p => scopes.includes(p.name));
    }
    if (options?.toposort) this._topoSortPackages(result);
    return result;
  }

  getPackage(name: string): Package | undefined {
    return this.packages.find(p => p.name === name);
  }

  /**
   * Reports each package's git change status. `dirty` (uncommitted local
   * changes) is always checked first, regardless of `hash` - a file can be
   * dirty no matter what it's being compared against. Once a package isn't
   * dirty, the reference point decides the rest: without `hash`, `committed`
   * means committed but not yet in the upstream branch; with `hash`, `changed`
   * means it differs from that commit. Otherwise a package is `clean`.
   *
   * **Keyed by `Package.selector`**, which is what addresses a package - it was `name`, and the two
   * coincide wherever a technology names its packages. A repository whose does not had every such
   * package answering to `""`, so one entry stood for all of them.
   *
   * **`includeRoot` is opt-in, and the reason is that the root's answer means something different.**
   * Its directory contains every other package, so the same rule - "does a changed file fall under
   * this directory" - reports `dirty` for the root whenever *anything* in the repository is dirty.
   * That is the honest reading of the rule rather than a bug, and it is not what `run --changed`
   * wants, so only a caller that asked for the root gets it (`rman list`'s table, which shows the
   * root as the tree's own row).
   */
  async listStatus(options?: {
    hash?: string;
    includeRoot?: boolean;
  }): Promise<Record<string, Repository.PackageStatus>> {
    const hash = options?.hash;
    const git = new GitHelper({ cwd: this.dirname });
    const packages = options?.includeRoot ? [this.rootPackage, ...this.getPackages()] : this.getPackages();
    const belongsTo = (p: Package, files: string[]) => files.some(f => !path.relative(p.dirname, f).startsWith('..'));

    const [dirtyFiles, referenceFiles] = await Promise.all([
      git.listDirtyFiles({ absolute: true }),
      hash ? git.listChangedSince(hash, { absolute: true }) : git.listCommittedFiles({ absolute: true }),
    ]);

    const result: Record<string, Repository.PackageStatus> = {};
    for (const p of packages) {
      if (belongsTo(p, dirtyFiles)) result[p.selector] = 'dirty';
      else if (belongsTo(p, referenceFiles)) result[p.selector] = hash ? 'changed' : 'committed';
      else result[p.selector] = 'clean';
    }
    return result;
  }

  /**
   * The scope a `${{ ... }}` expression is evaluated against for `pkg`, optionally with the version
   * a run is about to write bound into it.
   *
   * `version` is the only caller that passes one, and it has to: the config was resolved before its
   * plan existed, so `pkg.targetVersion` had nothing to be. Re-evaluating that raw value against
   * this is how that one binding gets filled in, without every other command paying for it - or
   * seeing a value that means nothing to them.
   */
  configScope(pkg: Package, options?: { targetVersion?: string }): ConfigScope {
    const _this = this;
    return {
      pkg: this._packageScope(pkg, options?.targetVersion),
      repository: this._repositoryScope(),
      /** `pkg.dirname`, not the repository root: a `"[*]"` block asking whether
       *  `tsconfig-build.json` exists has to be answered per package. */
      file: createFileScope(pkg.dirname),
      /** Same base directory as `file`, so one `"[*]"` declaration reads each package's own copy -
       *  and the cache is the repository's, so a file they *share* is parsed once. */
      read: createReadScope(pkg.dirname, this._readCache),
      env: { ...process.env },
      semver,
      path,
      /**
       * A getter, and cached on the **repository** rather than in this closure: `configScope` is
       * called once per package, so a per-scope cache would still shell out once per package in a
       * monorepo that mentions git at all.
       *
       * Enumerable, unlike `pkg.targetVersion` - it has a real answer everywhere, so nothing needs
       * hiding. What keeps it lazy is `interpolateConfig` building its context from property
       * descriptors instead of spreading; see the note there.
       */
      get git(): GitScope {
        return _this._gitScope();
      },
    };
  }

  /** `${{ git.* }}`, read at most once per repository per process. */
  protected _gitScope(): GitScope {
    if (this._git) return this._git;
    const built = this._readGitScope(this.dirname);
    /** Defined rather than assigned, so the cache stays out of every enumeration of the repository
     *  - the same reason `_repoScope` is defined this way. */
    Object.defineProperty(this, '_git', { value: built, enumerable: false, writable: true });
    return built;
  }

  /**
   * Resolves the effective rman config for the repository root and every package, cascading
   * root -> intermediate directories -> package directory, so a `.rmanrc` placed anywhere along
   * that path overrides the levels above it.
   *
   * Each package is resolved *by name* as well as by directory, since that is what a `"[selector]"`
   * block matches against - see `resolveConfig`. The root package is resolved by name too: in a
   * single-package repository it *is* the one package, so `"[*]"` has to reach it; in a monorepo
   * nothing under `getPackages()` is the root, so only its own unmarked config applies.
   */
  /**
   * Gives every package its `repository`, and hangs the `parent`/`children` tree off the walk that
   * found them - before any config is resolved, since a config expression or a provider may already
   * want to navigate from a package outwards.
   *
   * **The containment is read from the tree rather than recomputed from paths.** It used to be an
   * O(n²) sweep comparing every package's directory against every other's and keeping the longest
   * prefix - which is the same question `Workspace.walk` answers on the way down, asked again
   * afterwards with the answer thrown away. Two places deriving one relationship is two places to
   * disagree; there is one now.
   *
   * **`parent` is defined non-enumerably, `children` is a plain field**, which is the one asymmetry
   * here and it is deliberate: a tree is serialized downwards, so `children` has to be walkable and
   * `parent` must not be, or every `JSON.stringify` is a cycle. The same way `Repository.app` and
   * `ORIGINS` travel.
   *
   * A repository's own `repository` is itself, which reads oddly and is the honest answer:
   * `Repository extends Package`, so the repository *is* a package of its own repository.
   */
  protected _linkPackages(tree: Workspace.Node, nodes: Workspace.Node[], packages: Package[]): void {
    /** Non-enumerable everywhere, including on the repository itself - see `Package.repository`.
     *  `writable` because `import` grafts an external repository's packages onto this one. */
    const link = (pkg: Package): void => {
      Object.defineProperty(pkg, 'repository', { value: this, enumerable: false, configurable: true, writable: true });
    };
    link(this);
    link(this.rootPackage);
    for (const pkg of this.packages) link(pkg);

    /** The walk visits a directory once, so one node is one package and this map is a bijection -
     *  which is what lets the edges below be read off the tree instead of guessed from paths. */
    const byNode = new Map<Workspace.Node, Package>(nodes.map((node, i) => [node, packages[i]!]));
    byNode.set(tree, this.rootPackage);
    for (const node of [tree, ...nodes]) {
      const pkg = byNode.get(node)!;
      for (const childNode of node.children) {
        const child = byNode.get(childNode)!;
        pkg.children.push(child);
        Object.defineProperty(child, 'parent', { value: pkg, enumerable: false, configurable: true });
      }
    }
    /** `Repository extends Package` while holding a separate `rootPackage` for the same directory,
     *  so both are truthfully the root - they share the one array rather than each getting a copy
     *  that could drift. */
    Object.defineProperty(this, 'children', { value: this.rootPackage.children, enumerable: true });
  }

  /**
   * Gives every package the selector a `"[glob]"` block and `--scope` match it by, and refuses two
   * packages that would answer to the same one.
   *
   * **Its own step, before any config is resolved by a selector**, which is the ordering that makes
   * the rest work: `_resolveConfigs` asks `resolveConfig` for each package *by selector*, so an
   * address assigned afterwards would be applied to nothing.
   *
   * **`name` comes from the unmarked cascade only** - the same read `platform` gets, from the same
   * cache, for the same reason. A `"[glob]"` block cannot set it (`assertSelectorBlocks` refuses
   * one) because the glob matches the very thing the block would be setting.
   *
   * **Uniqueness is checked, and the cascade is the mistake it usually catches.** `name` cascades
   * like every unmarked key, so one declaration above two packages gives both the same address -
   * and the failure would otherwise be silent in the worst way: the config reaches both and
   * `getPackage` returns whichever came first. The message names both directories, and says the
   * cascade out loud when the two got it from one declaration.
   */
  protected async _assignSelectors(rootDir: string, cache: Map<string, RmanConfig>): Promise<void> {
    const declaredBy = new Map<Package, boolean>();
    for (const pkg of [this.rootPackage, ...this.packages]) {
      const config = await resolveConfig(rootDir, pkg.dirname, cache, undefined);
      const declared = config.name;
      if (declared !== undefined && (typeof declared !== 'string' || !declared.trim())) {
        throw new Error(
          `"name" takes the selector this package answers to - "${pkg.dirname}" gave ${typeof declared}.`,
        );
      }
      pkg.selector = declared?.trim() || pkg.platformSelector();
      declaredBy.set(pkg, declared !== undefined);
    }
    /** The root is left out: a glob never matches it and `"[/]"` needs no name, so it shares an
     *  address with nobody - see `Package.selector`. */
    const bySelector = new Map<string, Package>();
    for (const pkg of this.packages) {
      const clash = bySelector.get(pkg.selector);
      if (clash) {
        const cascaded = declaredBy.get(pkg) && declaredBy.get(clash);
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

  protected async _resolveConfigs(): Promise<void> {
    const cache = new Map<string, any>();
    /**
     * `DEFERRED_PATHS` are left *raw* in the result (see `interpolateConfig`'s `walk`), so the
     * resolved config is the only copy anyone needs - `version` reads its own hooks straight off
     * `config` and interpolates them itself once `pkg.targetVersion` exists. There used to be a
     * second `rawConfig` copy of every package's config for that one reader; measured identical.
     */
    /**
     * **By selector, not by name** - `"[glob]"` matches `Package.selector`, which is the package's
     * own `.rmanrc "name"` when it assigned one and its platform's answer otherwise. They coincide
     * for every Node repository; they are not the same question, and `name` was the wrong one to
     * ask, since a package having one at all is an ecosystem's promise rather than rman's.
     *
     * The root passes its own too, although no glob can match it: `"[/]"` is applied on the
     * strength of the target *being* the root and needs no selector at all (see `resolveConfig`).
     */
    const rootRaw = await resolveConfig(
      this.dirname,
      this.dirname,
      cache,
      this.rootPackage.selector,
      this.detectedBuiltin,
    );
    this.config = interpolateConfig(rootRaw, this.configScope(this.rootPackage), { skip: DEFERRED_PATHS });
    for (const pkg of this.packages) {
      const raw = await resolveConfig(this.dirname, pkg.dirname, cache, pkg.selector, this.detectedBuiltin);
      pkg.config = interpolateConfig(raw, this.configScope(pkg), { skip: DEFERRED_PATHS });
    }
    if (this.monorepo) this.rootPackage.config = this.config;
  }

  protected _topoSortPackages(packages: Package[]): void {
    packages.sort((a, b) => {
      if (b.dependencies.includes(a)) return -1;
      if (a.dependencies.includes(b)) return 1;
      return 0;
    });
  }

  protected _packageScope(pkg: Package, targetVersion?: string): PackageScope {
    // A manifest without a "name" is unusual but legal, and `info` prints such a package rather
    // than refusing it - so the scope has to survive one too.
    const name = pkg.name ?? '';
    /** Splitting `@scope/name` is npm's convention, not a universal - the provider decides. */
    const { scope: nameScope, unscopedName } = Manifest.splitName(this.app, pkg.dirname, name);
    const scope = {
      name,
      scope: nameScope,
      unscopedName,
      version: pkg.version ?? '',
      basename: path.basename(pkg.dirname),
      dirname: pkg.dirname,
      relativeDir: path.relative(this.dirname, pkg.dirname),
      /** The same `Package.provider`, so a `"[*]"` declaration can say something for one ecosystem
       *  only - `if: "${{ pkg.provider === 'node' }}"` in a polyglot repository. Omitting it would
       *  leave the expression scope and the `Package` disagreeing about what a package is. */
      provider: pkg.provider,
      // A copy: an expression has no business mutating the package rman is about to act on.
      manifest: { ...pkg.manifest.raw },
    } as PackageScope;

    if (targetVersion !== undefined) {
      scope.targetVersion = targetVersion;
      return scope;
    }
    /** Otherwise a getter that *throws*, rather than a missing key handing back `undefined` and
     *  letting a tag come out as "app:undefined". Defined rather than assigned because there is no
     *  value to assign - outside a `version` run there is no target version to name.
     *
     *  Non-enumerable, and that is load-bearing: spreading an object runs its enumerable getters,
     *  so an enumerable one threw the moment `_repositoryScope` spread the root's scope - which is
     *  every `configScope()` call, for every command. Property access still triggers it, which is
     *  the only thing it exists for. */
    Object.defineProperty(scope, 'targetVersion', {
      enumerable: false,
      get(): never {
        throw new Error(
          'pkg.targetVersion is only available while "version" is running - no other command has a target version',
        );
      },
    });
    return scope;
  }

  /** Built once and reused: it is the same for every package, and its `git` getter caches too, so a
   *  repository whose config never mentions git spawns none. */
  protected _repositoryScope(): RepositoryScope {
    if (this._repoScope) return this._repoScope;
    const packageScopes = this.packages.map(p => this._packageScope(p));
    const built: RepositoryScope = {
      ...this._packageScope(this.rootPackage),
      monorepo: this.monorepo,
      packages: packageScopes,
      package: (name: string) => packageScopes.find(p => p.name === name),
    };
    /** Defined rather than assigned, so the cache stays out of every enumeration of this object -
     *  see the field's own doc for what walked into it. */
    Object.defineProperty(this, '_repoScope', { value: built, enumerable: false, writable: true });
    return built;
  }

  /**
   * One `.rmanrc "dependencies"` entry to a package: its **name** first, then a
   * **repository-relative directory**.
   *
   * The path form is what makes the key usable outside npm. A name identifies a package only where
   * the ecosystem guarantees uniqueness - the same reason `Package.dependencies` holds references
   * and `Workspace.Layout` carries paths - so a repository whose names collide, or whose packages
   * have no names rman can read, states the edge by directory instead.
   *
   * Name first because that is what a Node repository writes and there is no ambiguity in practice:
   * a package name that is also an existing directory path in the same repository does not occur.
   * An entry matching neither is ignored, as an unknown name always was - the graph is a statement
   * about packages that exist.
   */
  protected _resolveDeclaredPackage(entry: string): Package | undefined {
    const byName = this.getPackage(entry);
    if (byName) return byName;
    const dir = path.resolve(this.dirname, entry);
    return this.packages.find(p => path.resolve(p.dirname) === dir);
  }

  protected _updateDependencies() {
    const deps = {};
    for (const pkg of this.packages) {
      /** Which manifest fields hold dependencies is the ecosystem's business, so the provider
       *  reads them - npm's four field names used to be spelled out right here. */
      const dependencies = [...Manifest.dependenciesOf(pkg, this.packages)];

      /** `.rmanrc "dependencies"` on top, and it works with no provider at all: a repository rman
       *  cannot read the manifests of can still declare its graph by hand. */
      const declared = pkg.config.dependencies ?? [];
      for (const entry of declared) {
        const p = this._resolveDeclaredPackage(entry);
        if (p && p !== pkg && !dependencies.includes(p)) dependencies.push(p);
      }

      deps[pkg.name] = dependencies.map(d => d.name);
      pkg.dependencies = dependencies;
    }

    let circularCheck: Package[];
    const deepFindDependencies = (pkg: Package, target: Package[]) => {
      if (circularCheck.includes(pkg)) return;
      circularCheck.push(pkg);
      for (const s of pkg.dependencies) {
        /** `target` starts out *as* the top-level package's own `dependencies` array, so its
         *  direct entries are trivially "already in target" - recursing only when newly-added
         *  would mean a direct dependency's own transitive deps never get pulled in. Recurse
         *  unconditionally (guarded by circularCheck); only skip re-adding an existing entry,
         *  and never let the top-level package end up depending on itself via a cycle. */
        if (s !== circularCheck[0] && !target.includes(s)) target.push(s);
        deepFindDependencies(s, target);
      }
    };

    for (const pkg of this.packages) {
      circularCheck = [];
      deepFindDependencies(pkg, pkg.dependencies);
    }
  }

  /** `git` facts for a `${{ git.* }}` expression. Synchronous on purpose: it backs a lazy
   *  getter, and a getter cannot await. Everything is `undefined` outside a git checkout - not an
   *  error, just a repository without one. */
  protected _readGitScope(dirname: string): GitScope {
    const run = (args: string[]): string | undefined => {
      try {
        return execFileSync('git', args, { cwd: dirname, stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      } catch {
        return undefined;
      }
    };
    const sha = run(['rev-parse', 'HEAD']);
    if (sha === undefined) return { branch: undefined, sha: undefined, shortSha: undefined, dirty: undefined };
    const status = run(['status', '--porcelain']);
    return {
      // Empty on a detached HEAD, which is what a CI checkout often is - reported as undefined
      // rather than an empty string, so `?? 'detached'` in an expression works.
      branch: run(['branch', '--show-current']) || undefined,
      sha,
      shortSha: sha.slice(0, 7),
      dirty: status === undefined ? undefined : status.length > 0,
    };
  }

  /**
   * Opens the repository containing `root` (default: the current directory).
   *
   * Three steps, in this order because each needs the one before it:
   *
   * 1. **Find the root** without knowing any ecosystem - see `Workspace.findRoot`. It cannot be
   *    otherwise: the plugins that know what a package is are named in the config file this step
   *    is looking for.
   * 2. **Load the plugins** the root's config names, which registers their workspace providers
   *    (their commands arrive through `.rmanrc "commands"`, which `cli.ts` reads).
   * 3. **Ask the providers** for the layout. None recognizing it means a repository that is itself
   *    the one package.
   *
   * **A repository whose `.rmanrc` names no plugin has no packages beyond itself**, and that is the
   * boundary working rather than failing: `workspaces` in a `package.json` is npm's idea, so it
   * takes `plugins: ['node']` - or detection reading the directory as a Node one - for it to be
   * read as a workspace at all.
   */
  static async create(root?: string, options?: { deep?: number; app?: RmanApplication }): Promise<Repository> {
    const from = root || process.cwd();
    const rootDir = Workspace.findRoot(from, options?.deep ?? 10);

    /**
     * One application per repository, made here unless the caller brought one.
     *
     * `runCli` passes its own so that `--log-level` reaches the logger; a spec that only wants a
     * repository lets this make one, which is also what keeps two repositories in a single process
     * from sharing anything - the thing that used to need five `clear*()` calls before every test.
     */
    const app = options?.app ?? new RmanApplication();

    /** The root's own config, raw: `plugins` is a list of package names, so it needs neither the
     *  package list (which does not exist yet) nor expression interpolation. */
    const declared = await readDirConfig(rootDir);
    /**
     * **What this repository looks like, when nothing said** - the other half of shipping the
     * built-ins in the box. See `detectBuiltin`.
     *
     * **Two conditions, and the second is the one that is easy to miss.** The config declaring no
     * `plugins` is not the same as the *repository* having no technology: a programmatic caller -
     * and every spec in this suite - registers one straight onto the application without writing a
     * config at all. Guessing on top of that registers a second technology, and the first provider
     * that recognizes a directory decides whether it holds a package. Measured with only the config
     * condition: ten specs changed answer, seven of them about config cascading and three about
     * `publish`'s flags.
     *
     * **`platforms`, not `plugins`, and the difference is what detection produces.** What would be
     * added here is a *platform*, so what must not already be there is a platform - a plugin that
     * only registers a command says nothing about which directories hold packages, and letting it
     * suppress the guess would leave a Node repository undetected for having added a command.
     *
     * **A root `platform` counts as having said something**, like `plugins: []` does. Detection
     * exists for a repository that stated nothing; one naming its technology has stated the very
     * thing detection would be guessing at, and guessing anyway would register a *second* platform
     * beside the declared one - which then competes for every directory the declaration did not
     * cover.
     *
     * Decided **once**, here, and handed to every read that has to agree - `readDirConfig` has no
     * business knowing about an application.
     */
    const saidSomething = declared.plugins !== undefined || declared.platform !== undefined;
    const detected = !saidSomething && app.platforms.size === 0 ? await detectBuiltin(rootDir) : undefined;
    const rootConfig = detected ? await readDirConfig(rootDir, { inject: detected }) : declared;
    /**
     * **Said out loud, because a guess the reader cannot see is one they cannot correct.**
     *
     * To **stderr**, not through `app.logger`: that writes with `console.log`, and `rman list
     * --json` has to stay a parseable document on stdout - measured, its output is pure JSON, and
     * one line of prose in front of it breaks every `| jq`. The same reason `--help`'s degradation
     * notice goes to stderr. Not at `silent`, where the caller asked for no narration.
     */
    if (detected && app.logger.level !== 'silent') {
      const line =
        `${detected.name} repository detected (${detected.because}) - ` +
        `write \`plugins: ['${detected.name}']\` in .rmanrc to state it, or \`plugins: []\` for none.`;
      console.error(process.stderr.isTTY ? colors.gray(line) : line);
    }
    await loadPlugins(app, rootConfig);

    /**
     * **Its own cache, deliberately not shared with `_resolveConfigs`'.**
     *
     * Both cache `readDirConfig` per directory, and the two reads of the *root* are not the same
     * read: `_resolveConfigs` passes `detectedBuiltin` as `inject` and this one passes nothing,
     * since a built-in's contribution has no bearing on which platform a directory declares. The
     * cache is keyed by directory alone, so one shared map would hand whichever ran first to the
     * other - and for the root that is a config with or without the whole node built-in merged in.
     *
     * The cost is one extra read per directory in the chain, on a repository that is about to read
     * every one of them again per package anyway.
     */
    const platformCache = new Map<string, RmanConfig>();

    /**
     * **The walk**, which is where the package list comes from now - descending from the root,
     * asking each directory's own technology where its children are. `Workspace.resolve` asked the
     * root once, through whichever platform recognized it first; the tree is the shape discovery
     * actually has, and it is what makes a nested package of another technology findable at all.
     */
    const tree = await Workspace.walk(app, rootDir, {
      deep: options?.deep,
      declared: dir => declaredPlatformAt(app, rootDir, dir, platformCache),
    });
    const nodes = Workspace.flatten(tree);
    const packages = nodes.map(node => new Package(node.dirname, app, node.platform));
    const repo = new Repository(app, tree.dirname, packages.length > 0, packages, from, tree.platform);
    repo._linkPackages(tree, nodes, packages);
    /** Before `_resolveConfigs`, because a `"[glob]"` block is matched against the selector - so
     *  the addresses have to be settled before anything is resolved by them. */
    await repo._assignSelectors(rootDir, platformCache);
    /** The application is what the plugins registered into a moment ago; from here on it can hand
     *  out services, which need the repository to work on. */
    (repo as { detectedBuiltin?: DetectedBuiltin }).detectedBuiltin = detected;
    app.attachRepository(repo);
    return Repository._init(repo);
  }

  /** Finishes constructing `repo` with the async work a constructor can't do itself - resolving
   *  `.rmanrc`/`.rmanrc.yml`/`.rmanrc.cjs`/`.mjs`/`.js` config (which may need a dynamic `import()`)
   *  before the dependency graph is built from it. */
  private static async _init(repo: Repository): Promise<Repository> {
    await repo._resolveConfigs();
    repo._updateDependencies();
    return repo;
  }
}

export namespace Repository {
  export type PackageStatus = 'dirty' | 'committed' | 'changed' | 'clean';
}

/**
 * The platform `dir` declares in its cascaded `.rmanrc "platform"`, loaded if it has to be -
 * `undefined` when the directory declares none, so the walk falls back to its guess.
 *
 * **The unmarked cascade only**, which is what `resolveConfig` gives with no package name: a
 * selector matches a package *name*, and this runs while the packages are still being found - the
 * name is not known yet, and it is read *from* a manifest whose reader this key decides. So
 * `"[/]"` reaches the root (its directory is the repository root, which needs no name) and a glob
 * block contributes nothing here, which is the honest answer rather than a half-applied one.
 */
async function declaredPlatformAt(
  app: RmanApplication,
  rootDir: string,
  dir: string,
  cache: Map<string, RmanConfig>,
): Promise<Platform | undefined> {
  const config = await resolveConfig(rootDir, dir, cache);
  const declared = config.platform;
  if (declared === undefined) return undefined;
  if (typeof declared !== 'string' || !declared.trim()) {
    throw new Error(`"platform" takes a platform's name - ${originOf(config)} gave ${typeof declared}.`);
  }
  /**
   * **An expression is refused rather than read as a literal.** `platform` is consulted before any
   * package exists - it is what decides what a package *is* - so there is no `pkg` for an
   * expression to be about, and `interpolateConfig` runs long afterwards. Passed through, a
   * `${{ }}` here reached the lookup below as the raw text and failed as an unknown platform name,
   * which sends the reader to check their `plugins`.
   */
  if (declared.includes('${{')) {
    throw new Error(
      `"platform" cannot be an expression (${originOf(config)}) - it is read while ` +
        `the packages are still being found, so there is no package for one to be about. Write the ` +
        `name, and use a package's own ".rmanrc" where the answer differs.`,
    );
  }

  const registered = [...app.platforms].find(p => p.name === declared);
  if (registered) return registered;

  /**
   * **A built-in is loaded on the strength of being named**, from any level - `platform: 'node'` is
   * enough, and it is what a repository holding one Node package among others writes.
   *
   * `platform()` and not `contribute()`, and that split is why the two halves exist: what arrives
   * is the technology alone. Commands and publish targets come from root `plugins`, because they
   * are repository-wide - a Node package inside a Cargo repository wants npm's manifest read, not
   * an `rman clean` that would sweep the whole tree.
   */
  const { BUILTIN_PLUGINS, builtinPluginNames } = await import('../plugins/builtins.js');
  const builtin = BUILTIN_PLUGINS[declared];
  if (builtin) {
    const platform = builtin.platform();
    registerPlugin(app, platform);
    return platform;
  }

  const have = [...app.platforms].map(p => p.name).filter(Boolean);
  throw new Error(
    `"platform" names "${declared}" (${originOf(config)}), which is not a platform ` +
      `this repository has. ${have.length ? `Registered: ${have.join(', ')}. ` : 'None is registered. '}` +
      `rman ships ${builtinPluginNames().join(', ')}; anything else arrives through "plugins".`,
  );
}

/** Which file the `platform` key came from, for an error that can be acted on - `mergeConfig`
 *  records one per key under `ORIGINS`, and a config is merged from a directory's own four forms,
 *  an `extends` base and one layer per directory before anything reads it. */
function originOf(config: RmanConfig): string {
  const origins = (config as Record<symbol, unknown>)[ORIGINS] as Record<string, string> | undefined;
  return origins?.platform ? `in "${origins.platform}"` : 'the "platform" key';
}
