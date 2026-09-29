import { execFileSync } from 'node:child_process';
import path from 'path';
import semver from 'semver';
import {
  type ConfigScope,
  type GitScope,
  type PackageScope,
  type RepositoryScope,
} from '../../interfaces/config-scope.interface.js';
import type { ResolvedConfig } from '../../interfaces/rman-config.interface.js';
import { GitHelper } from '../../utils/git.js';
import { RmanApplication } from '../application.js';
import { ConfigFileScope } from '../config/config-file-scope.js';
import { ConfigInterpolator } from '../config/config-interpolator.js';
import { DEFERRED_PATHS } from '../config/config-paths.js';
import { Manifest } from '../interfaces/manifest.js';
import type { Platform } from '../interfaces/plugin.js';
import type { PublishTarget } from '../interfaces/publish-target.js';
import { Package } from './package.js';
import { Workspace } from './workspace.js';

export class Repository extends Package {
  readonly rootPackage: Package;
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
   * What `${{ file... }}` and `${{ read(...) }}` answer from, for every package.
   *
   * **One per repository rather than one per scope, and that is the whole point of it**:
   * `configScope` is built once per package, so a parse cache living there would re-read a
   * repository-level file once for every package that mentions it. The cache inside is keyed by the
   * identity of the bytes (`mtimeNs:size`), because rman writes JSON while it runs - `version`
   * rewrites every bumped manifest and then re-interpolates its deferred hooks.
   */
  private readonly _files = new ConfigFileScope();

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
      file: this._files.fileScope(pkg.dirname),
      /** Same base directory as `file`, so one `"[*]"` declaration reads each package's own copy -
       *  and the cache is the repository's, so a file they *share* is parsed once. */
      read: this._files.readScope(pkg.dirname),
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
   * Bakes every package's config: the raw one the workspace cascaded, with every `${{ }}` and value
   * function resolved against that package's scope.
   */
  /* **The one step the workspace deliberately stops short of.** Resolving an expression needs
   * `pkg`, `repository`, `file` and `git` - which belong to a repository rather than to its layout,
   * and `configScope` is where the measured subtleties of building that scope live.
   *
   * `DEFERRED_PATHS` are left raw, so the resolved config is the only copy anyone needs - `version`
   * reads its own hooks straight off it and interpolates them once `pkg.targetVersion` exists. */
  protected async _resolveConfigs(): Promise<void> {
    const interpolator = new ConfigInterpolator();
    const bake = (pkg: Package): ResolvedConfig =>
      interpolator.interpolate({
        config: pkg.rawConfig,
        scope: this.configScope(pkg),
        skip: DEFERRED_PATHS,
      }) as ResolvedConfig;

    this.config = bake(this.rootPackage);
    for (const pkg of this.packages) pkg.config = bake(pkg);
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
   * **A repository no technology recognizes has no packages beyond itself**, and that is the
   * boundary working rather than failing: `workspaces` in a `package.json` is npm's idea, so it
   * takes a platform that reads one for the directory to be a workspace at all. rman's own presets
   * are laid under every root (see `DEFAULT_PRESETS`), so a plain Node repository needs no config
   * file to say so; anything else arrives through `extends` or `platforms`.
   */
  /* **`presets` is an opt-out, and it exists for the specs that must not have one.** rman's own
   * presets are laid under every root, so a caller that brought its own ecosystem would otherwise
   * get the `node` technology, `clean`, `ci` and the npm publish target beside it. That is right
   * for a repository and wrong for a synthetic one: measured, the core's `publish` specs ran a
   * **real `npm publish` against registry.npmjs.org**, and only a 404 stopped it - the failure
   * `useLocalBin`'s doc already records for `docker`, arriving by a new route. `test/_fixture.ts`
   * passes `[]`. */
  static async create(
    root?: string,
    options?: { deep?: number; app?: RmanApplication; presets?: readonly string[] },
  ): Promise<Repository> {
    const from = root || process.cwd();
    const rootDir = Workspace.findRoot(from, options?.deep ?? 10);
    const app = options?.app ?? new RmanApplication();

    /**
     * **The whole of discovery and config reading is the workspace's.** It reads each level's
     * config, loads whatever that level names, decides which technology claims each directory,
     * assigns the selectors and cascades every package's **raw** config.
     *
     * Technologies already on the application are handed over: a programmatic caller - and every
     * spec in this suite - registers one without writing a config, and the walk has to see it.
     */
    const workspace = await Workspace.create(rootDir, {
      app,
      deep: options?.deep,
      platforms: [...app.platforms],
      presets: options?.presets,
    });

    /** What the configs named, onto the application the commands read from. */
    for (const platform of workspace.platforms) app.platforms.add(platform);
    for (const plugin of workspace.plugins) {
      app.plugins.add(plugin);
      await plugin.afterInitApplication?.({ app });
    }
    /** One loop, because `workspace.platforms` already holds every technology in play whatever
     *  route it arrived by. There used to be a second one over each plugin's own `platforms`, and
     *  by the end it was pure duplication of this. */
    for (const platform of workspace.platforms) {
      if (platform.versionPlanner) app.versionPlanner = platform.versionPlanner;
    }

    /** **Publish targets the root config declared.** `publish` builds its `--target` choices from
     *  `app.publishTargets` when its factory runs, so they have to be there before the commands
     *  are. Read off the root's own level rather than a package's: a target is the repository's. */
    for (const target of toList(workspace.rootPackage.rawConfig.publishTargets)) {
      if (!target || typeof target !== 'object' || typeof (target as PublishTarget).name !== 'string') {
        throw new Error(
          `"publishTargets" takes a target or a glob naming modules that export one - got ` +
            `${target === null ? 'null' : typeof target}.`,
        );
      }
      app.publishTargets.add(target as PublishTarget);
    }

    const packages = workspace.packages;
    /** `workspace.monorepo`, not `packages.length > 0` again: the workspace already had to answer
     *  this during the cascade - it is what decides whether a `"[glob]"` speaks for the root - and
     *  two copies of the derivation could disagree silently, resolving a config under one answer
     *  and building the package list under the other. */
    const repo = new Repository(app, rootDir, workspace.monorepo, packages, from, workspace.rootPackage.platform);
    repo._adopt(workspace);
    app.attachRepository(repo);
    return Repository._init(repo);
  }

  /**
   * Takes the workspace's packages as this repository's own - the back-references a `Package` needs
   * and the parent/child edges the walk established.
   */
  /* `Repository extends Package` while the workspace built its own root package for the same
   * directory, so both are, truthfully, the root. This keeps the workspace's - it is the one the
   * walk handed a platform and a selector - and leaves `Repository` itself pointing at the same
   * children. */
  protected _adopt(workspace: Workspace): void {
    const link = (pkg: Package): void =>
      void Object.defineProperty(pkg, 'repository', {
        value: this,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    link(this);
    (this as { rootPackage: Package }).rootPackage = workspace.rootPackage;
    link(this.rootPackage);
    for (const pkg of this.packages) link(pkg);
    if (!this.monorepo) (this as { packages: Package[] }).packages = [this.rootPackage];
    Object.defineProperty(this, 'children', { value: this.rootPackage.children, enumerable: true });
  }

  private static async _init(repo: Repository): Promise<Repository> {
    await repo._resolveConfigs();
    repo._updateDependencies();
    /** **Last, and that is the whole point of the second stage.** Every package is found, every
     *  config is baked and the dependency graph is linked - so a plugin handed this repository can
     *  read it rather than being told to wait for a command it may not contribute. */
    for (const plugin of repo.app.plugins) await plugin.afterInitRepository?.({ app: repo.app, repository: repo });
    return repo;
  }
}

export namespace Repository {
  export type PackageStatus = 'dirty' | 'committed' | 'changed' | 'clean';
}

/** A key that takes one value or a list of them, as a list. */
function toList<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
