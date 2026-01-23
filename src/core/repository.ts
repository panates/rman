import glob from 'fast-glob';
import fs from 'fs';
import * as yaml from 'js-yaml';
import path from 'path';
import merge from 'putil-merge';
import { Package } from './package.js';

export class Repository extends Package {
  readonly rootPackage: Package;

  protected constructor(
    readonly dirname: string,
    readonly config: any,
    readonly monorepo: boolean,
    readonly packages: Package[],
  ) {
    super(dirname);
    this.rootPackage = new Package(dirname);
    if (!monorepo) this.packages = [this.rootPackage];
  }

  getPackages(options?: { scope?: string | string[]; toposort?: boolean }): Package[] {
    const result = [...this.packages];
    if (options?.toposort) topoSortPackages(result);
    return result;
  }

  getPackage(name: string): Package | undefined {
    return this.packages.find(p => p.name === name);
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
      const configDeps = this.config.packages?.[pkg.name]?.dependencies;
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
        if (!target.includes(s)) {
          target.push(s);
          const p = this.getPackage(s);
          if (p) {
            deepFindDependencies(p, target);
          }
        }
      }
    };

    for (const pkg of this.packages) {
      circularCheck = [];
      deepFindDependencies(pkg, pkg.dependencies);
    }
  }

  static create(root?: string, options?: { deep?: number }): Repository {
    const dirname = root || process.cwd();
    let deep = options?.deep ?? 10;
    let pkgDirname = dirname;
    while (deep-- >= 0 && fs.existsSync(pkgDirname)) {
      const f = path.join(pkgDirname, 'package.json');
      if (fs.existsSync(f)) {
        const pkgJson = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(pkgJson.workspaces)) {
          const packages = this._resolvePackages(pkgDirname, pkgJson.workspaces);
          const config = this._readConfig(pkgDirname);
          const repo = new Repository(pkgDirname, config, true, packages);
          repo._updateDependencies();
          return repo;
        }
      }
      pkgDirname = path.resolve(dirname, '..');
    }
    const config = this._readConfig(dirname);
    const repo = new Repository(dirname, config, false, []);
    repo._updateDependencies();
    return repo;
    // throw new Error('No monorepo project detected');
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

  protected static _readConfig(dirname: string): any {
    const result = {};
    const f = path.resolve(dirname, 'package.json');
    let pkgJson;
    if (fs.existsSync(f)) {
      pkgJson = JSON.parse(fs.readFileSync(f, 'utf-8'));
    }
    if (pkgJson && typeof pkgJson.rman === 'object') merge(result, pkgJson.rman, { deep: true });
    let filename = path.resolve(dirname, '.rman.yml');
    if (fs.existsSync(filename)) {
      const obj = yaml.load(fs.readFileSync(filename, 'utf-8'));
      if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
    }
    filename = path.resolve(dirname, '.rmanrc');
    if (fs.existsSync(filename)) {
      const obj = JSON.parse(fs.readFileSync(filename, 'utf-8'));
      if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
    }
    return result;
  }
}

function topoSortPackages(packages: Package[]): void {
  packages.sort((a, b) => {
    if (b.dependencies.includes(a.name)) return -1;
    if (a.dependencies.includes(b.name)) return 1;
    return 0;
  });
}
