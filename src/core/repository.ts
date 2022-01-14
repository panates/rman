import fs from 'fs';
import path from 'path';
import glob from 'fast-glob';
import {Package} from './package';
import {Config} from './config';

export class Repository extends Package {

    protected constructor(readonly dirname: string,
                          private _config: Config,
                          private _packages: Package[]) {
        super(dirname);
    }

    get config(): Config {
        return this._config;
    }

    get packages(): Package[] {
        return this._packages;
    }

    getPackages(options?: { scope?: string | string[], toposort?: boolean }): Package[] {
        const result = [...this._packages];
        if (options?.toposort)
            topoSortPackages(result);
        return result;
    }

    getPackage(name: string): Package | undefined {
        return this.packages.find(p => p.name === name);
    }

    static create(root?: string, options?: { deep?: number }): Repository {
        let dirname = root || process.cwd();
        let deep = options?.deep ?? 10;
        while (deep-- >= 0 && fs.existsSync(dirname)) {
            const f = path.join(dirname, 'package.json');
            if (fs.existsSync(f)) {
                const pkgJson = JSON.parse(fs.readFileSync(f, 'utf-8'));
                if (Array.isArray(pkgJson.workspaces)) {
                    const packages = this._resolvePackages(dirname, pkgJson.workspaces);
                    const config = Config.resolve(dirname);
                    const repo = new Repository(dirname, config, packages);
                    repo._updateDependencies();
                    return repo;
                }
            }
            dirname = path.resolve(dirname, '..');
        }
        throw new Error('No monorepo project detected');
    }

    protected static _resolvePackages(dirname: string, patterns: string[]): Package[] {
        const packages: Package[] = [];
        for (const pattern of patterns) {
            const dirs = glob.sync(pattern, {
                cwd: dirname,
                absolute: true,
                deep: 0,
                onlyDirectories: true
            });
            for (const dir of dirs) {
                const f = path.join(dir, 'package.json');
                if (fs.existsSync(f))
                    packages.push(new Package(dir));
            }
        }
        return packages;
    }

    protected _updateDependencies() {
        const deps = {};
        for (const pkg of this._packages) {
            const o = {
                ...pkg.json.dependencies,
                ...pkg.json.devDependencies,
                ...pkg.json.peerDependencies,
                ...pkg.json.optionalDependencies
            }
            const dependencies: string[] = [];
            for (const k of Object.keys(o)) {
                const p = this.getPackage(k);
                if (p)
                    dependencies.push(k);
            }
            deps[pkg.name] = dependencies;
            pkg.dependencies = dependencies;
        }

        let circularCheck: string[];
        const deepFindDependencies = (pkg: Package, target: string[]) => {
            if (circularCheck.includes(pkg.name))
                return;
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
        }

        for (const pkg of this._packages) {
            circularCheck = [];
            deepFindDependencies(pkg, pkg.dependencies);
        }
    }

}

function topoSortPackages(packages: Package[]): void {
    packages.sort((a, b) => {
        if (b.dependencies.includes(a.name))
            return -1;
        if (a.dependencies.includes(b.name))
            return 1;
        return 0;
    })
}
