import { execFileSync } from 'node:child_process';
import glob from 'fast-glob';
import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { GitHelper } from '../utils/git.js';
import { type GitScope, interpolateConfig, type PackageScope, type RepositoryScope, resolveConfig } from './config.js';
import { Package } from './package.js';

export class Repository extends Package {
  readonly rootPackage: Package;

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
    if (options?.toposort) topoSortPackages(result);
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
   * Resolves the effective rman config for the repository root and every package, cascading
   * root -> intermediate directories -> package directory, so a `.rmanrc` placed anywhere along
   * that path overrides the levels above it.
   *
   * Each package is resolved *by name* as well as by directory, since that is what a `"[selector]"`
   * block matches against - see `resolveConfig`. The root package is resolved by name too: in a
   * single-package repository it *is* the one package, so `"[*]"` has to reach it; in a monorepo
   * nothing under `getPackages()` is the root, so only its own unmarked config applies.
   */
  protected async _resolveConfigs(): Promise<void> {
    const cache = new Map<string, any>();
    const repoDir = this.dirname;
    const scopeOf = (pkg: Package): PackageScope => {
      // A package.json without a "name" is unusual but legal, and `info` prints such a package
      // rather than refusing it - so the scope has to survive one too.
      const name = pkg.name ?? '';
      const at = name.lastIndexOf('/');
      return {
        name,
        scope: at > 0 ? name.slice(0, at) : undefined,
        unscopedName: at > 0 ? name.slice(at + 1) : name,
        version: pkg.version ?? '',
        basename: path.basename(pkg.dirname),
        dirname: pkg.dirname,
        relativeDir: path.relative(this.dirname, pkg.dirname),
        // A copy: an expression has no business mutating the package rman is about to act on.
        json: { ...pkg.json },
      };
    };
    const packageScopes = this.packages.map(scopeOf);
    let gitScope: GitScope | undefined;
    const repository: RepositoryScope = {
      ...scopeOf(this.rootPackage),
      monorepo: this.monorepo,
      packages: packageScopes,
      package: (name: string) => packageScopes.find(p => p.name === name),
      // A getter, so a repository whose config never mentions git spawns no git at all - and every
      // command resolves config, not just the ones that care.
      get git(): GitScope {
        return (gitScope ??= readGitScope(repoDir));
      },
    };
    const withVars = (pkg: Package, config: any) =>
      interpolateConfig(config, { pkg: scopeOf(pkg), repository, env: { ...process.env }, semver });
    this.config = withVars(this.rootPackage, await resolveConfig(this.dirname, this.dirname, cache));
    for (const pkg of this.packages) {
      pkg.config = withVars(pkg, await resolveConfig(this.dirname, pkg.dirname, cache, pkg.name));
    }
    if (this.monorepo) this.rootPackage.config = this.config;
  }

  protected _updateDependencies() {
    const deps = {};
    for (const pkg of this.packages) {
      const o = {
        ...pkg.json.dependencies,
        ...pkg.json.devDependencies,
        ...pkg.json.peerDependencies,
        ...pkg.json.optionalDependencies,
      };
      const configDeps = pkg.config.dependencies;
      if (configDeps) {
        if (Array.isArray(configDeps)) configDeps.forEach(x => (o[x] = o[x] || '*'));
        else Object.assign(o, configDeps);
      }
      const dependencies: string[] = [];
      for (const k of Object.keys(o)) {
        const p = this.getPackage(k);
        if (p) dependencies.push(k);
      }
      deps[pkg.name] = dependencies;
      pkg.dependencies = dependencies;
    }

    let circularCheck: string[];
    const deepFindDependencies = (pkg: Package, target: string[]) => {
      if (circularCheck.includes(pkg.name)) return;
      circularCheck.push(pkg.name);
      for (const s of pkg.dependencies) {
        /** `target` starts out *as* the top-level package's own `dependencies` array, so its
         *  direct entries are trivially "already in target" - recursing only when newly-added
         *  would mean a direct dependency's own transitive deps never get pulled in. Recurse
         *  unconditionally (guarded by circularCheck); only skip re-adding an existing entry,
         *  and never let the top-level package end up depending on itself via a cycle. */
        if (s !== circularCheck[0] && !target.includes(s)) target.push(s);
        const p = this.getPackage(s);
        if (p) deepFindDependencies(p, target);
      }
    };

    for (const pkg of this.packages) {
      circularCheck = [];
      deepFindDependencies(pkg, pkg.dependencies);
    }
  }

  static async create(root?: string, options?: { deep?: number }): Promise<Repository> {
    const dirname = root || process.cwd();
    let deep = options?.deep ?? 10;
    let pkgDirname = dirname;
    while (deep-- >= 0 && fs.existsSync(pkgDirname)) {
      const f = path.join(pkgDirname, 'package.json');
      if (fs.existsSync(f)) {
        const pkgJson = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(pkgJson.workspaces)) {
          const packages = this._resolvePackages(pkgDirname, pkgJson.workspaces);
          return Repository._init(new Repository(pkgDirname, true, packages, dirname));
        }
        /** If we reach to the root of the project */
        if (fs.existsSync(path.join(pkgDirname, '.git'))) break;
      }
      pkgDirname = path.resolve(pkgDirname, '..');
    }
    return Repository._init(new Repository(dirname, false, [], dirname));
  }

  /** Finishes constructing `repo` with the async work a constructor can't do itself - resolving
   *  `.rmanrc`/`.rmanrc.yml`/`.rmanrc.cjs`/`.mjs`/`.js` config (which may need a dynamic `import()`)
   *  before the dependency graph is built from it. */
  private static async _init(repo: Repository): Promise<Repository> {
    await repo._resolveConfigs();
    repo._updateDependencies();
    return repo;
  }

  protected static _resolvePackages(dirname: string, patterns: string[]): Package[] {
    const packages: Package[] = [];
    for (const pattern of patterns) {
      const dirs = glob.sync(pattern, {
        cwd: dirname,
        absolute: true,
        deep: 0,
        onlyDirectories: true,
      });
      for (const dir of dirs) {
        const f = path.join(dir, 'package.json');
        if (fs.existsSync(f)) packages.push(new Package(dir));
      }
    }
    return packages;
  }
}

export namespace Repository {
  export type PackageStatus = 'dirty' | 'committed' | 'changed' | 'clean';
}

function topoSortPackages(packages: Package[]): void {
  packages.sort((a, b) => {
    if (b.dependencies.includes(a.name)) return -1;
    if (a.dependencies.includes(b.name)) return 1;
    return 0;
  });
}

/** `git` facts for a `${{ repository.git.* }}` expression. Synchronous on purpose: it backs a lazy
 *  getter, and a getter cannot await. Everything is `undefined` outside a git checkout - not an
 *  error, just a repository without one. */
function readGitScope(dirname: string): GitScope {
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
