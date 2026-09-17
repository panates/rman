import { execFileSync } from 'node:child_process';
import path from 'path';
import semver from 'semver';
import { GitHelper } from '../utils/git.js';
import {
  type ConfigScope,
  createFileScope,
  DEFERRED_PATHS,
  type GitScope,
  interpolateConfig,
  type PackageScope,
  readDirConfig,
  type RepositoryScope,
  resolveConfig,
} from './config.js';
import type { LoadedCommand } from './custom-command.js';
import { Manifest } from './manifest.js';
import { Package } from './package.js';
import { loadPlugins } from './plugin.js';
import { Workspace } from './workspace.js';

export class Repository extends Package {
  readonly rootPackage: Package;
  /** Commands the repository's plugins contributed, loaded during `create` because the workspace
   *  providers they bring are needed before any package can be found. `cli.ts` registers them. */
  pluginCommands: LoadedCommand[] = [];
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

  protected constructor(
    readonly dirname: string,
    readonly monorepo: boolean,
    readonly packages: Package[],
    /** The directory `Repository.create()` was actually invoked from - unlike `dirname` (the
     *  resolved repository root, possibly several levels up), this is where the user's shell
     *  really was. Used by `currentPackage` to scope commands to "the package I'm standing in". */
    readonly cwd: string = dirname,
  ) {
    super(dirname);
    this.rootPackage = new Package(dirname);
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
   */
  async listStatus(options?: { hash?: string }): Promise<Record<string, Repository.PackageStatus>> {
    const hash = options?.hash;
    const git = new GitHelper({ cwd: this.dirname });
    const packages = this.getPackages();
    const belongsTo = (p: Package, files: string[]) => files.some(f => !path.relative(p.dirname, f).startsWith('..'));

    const [dirtyFiles, referenceFiles] = await Promise.all([
      git.listDirtyFiles({ absolute: true }),
      hash ? git.listChangedSince(hash, { absolute: true }) : git.listCommittedFiles({ absolute: true }),
    ]);

    const result: Record<string, Repository.PackageStatus> = {};
    for (const p of packages) {
      if (belongsTo(p, dirtyFiles)) result[p.name] = 'dirty';
      else if (belongsTo(p, referenceFiles)) result[p.name] = hash ? 'changed' : 'committed';
      else result[p.name] = 'clean';
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
    return {
      pkg: this._packageScope(pkg, options?.targetVersion),
      repository: this._repositoryScope(),
      /** `pkg.dirname`, not the repository root: a `"[*]"` block asking whether
       *  `tsconfig-build.json` exists has to be answered per package. */
      file: createFileScope(pkg.dirname),
      env: { ...process.env },
      semver,
      path,
    };
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
   * Gives every package its `repository` and `parent`, before any config is resolved - a config
   * expression or a provider may already want to navigate from a package outwards.
   *
   * A repository's own `repository` is itself, which reads oddly and is the honest answer:
   * `Repository extends Package`, so the repository *is* a package of its own repository.
   */
  protected _linkPackages(): void {
    this.repository = this;
    this.rootPackage.repository = this;
    for (const pkg of this.packages) {
      pkg.repository = this;
      /** The deepest package that strictly contains it - the root for an ordinary member, an
       *  enclosing package for a nested one. Longest containing path wins, the same rule
       *  `currentPackage` uses to resolve "the package I am standing in". */
      let parent: Package | undefined = this.monorepo ? this.rootPackage : undefined;
      for (const other of this.packages) {
        if (other === pkg) continue;
        const rel = path.relative(other.dirname, pkg.dirname);
        const contains = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (contains && (!parent || other.dirname.length > parent.dirname.length)) parent = other;
      }
      pkg.parent = pkg === this.rootPackage ? undefined : parent;
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
     * The root is resolved **with its name**, like every other package, because selectors now speak
     * to it: `"[/]"` names it and `"[*]"` includes it. It used to be resolved without one, which is
     * what made `"[*]"` quietly mean "the workspace packages" - `"[ws:*]"` is that, spelled.
     */
    const rootRaw = await resolveConfig(this.dirname, this.dirname, cache, this.rootPackage.name);
    this.config = interpolateConfig(rootRaw, this.configScope(this.rootPackage), { skip: DEFERRED_PATHS });
    for (const pkg of this.packages) {
      const raw = await resolveConfig(this.dirname, pkg.dirname, cache, pkg.name);
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
    const { scope: nameScope, unscopedName } = Manifest.splitName(pkg.dirname, name);
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
    const repoDir = this.dirname;
    let gitScope: GitScope | undefined;
    const _this = this;
    const built: RepositoryScope = {
      ...this._packageScope(this.rootPackage),
      monorepo: this.monorepo,
      packages: packageScopes,
      package: (name: string) => packageScopes.find(p => p.name === name),
      get git(): GitScope {
        return (gitScope ??= _this._readGitScope(repoDir));
      },
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

  /** `git` facts for a `${{ repository.git.* }}` expression. Synchronous on purpose: it backs a lazy
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
   *    (and their commands, handed on via `pluginCommands` - `cli.ts` registers those).
   * 3. **Ask the providers** for the layout. None recognizing it means a repository that is itself
   *    the one package.
   *
   * **A repository whose `.rmanrc` names no plugin has no packages beyond itself**, and that is the
   * boundary working rather than failing: `workspaces` in a `package.json` is npm's idea, so it
   * takes `plugins: ['@rman/node']` to be read as one.
   */
  static async create(root?: string, options?: { deep?: number }): Promise<Repository> {
    const from = root || process.cwd();
    const rootDir = Workspace.findRoot(from, options?.deep ?? 10);

    /** The root's own config, raw: `plugins` is a list of package names, so it needs neither the
     *  package list (which does not exist yet) nor expression interpolation. */
    const rootConfig = await readDirConfig(rootDir);
    const pluginCommands = await loadPlugins(rootDir, rootConfig);

    const layout = Workspace.resolve(rootDir);
    const packages = (layout?.packageDirs ?? []).map(dir => new Package(dir));
    const repo = new Repository(layout?.root ?? rootDir, packages.length > 0, packages, from);
    repo.pluginCommands = pluginCommands;
    repo._linkPackages();
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
