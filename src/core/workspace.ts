import {Package} from './package';
import {Config} from './config';
import {resolveRoot} from './utils/resolve-root';
import {resolvePackages} from './utils/resolve-packages';
import {compare} from 'semver';

export class Workspace {

    constructor(readonly dirname: string,
                private _config: Config,
                private _packages: Package[]) {
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

    static create(root?: string, options?: { deep?: number }): Workspace {
        const inf = resolveRoot(root, options?.deep);
        const config = Config.resolve(inf.dirname);
        const packages = resolvePackages(inf.dirname, inf.packages);
        return new Workspace(inf.dirname, config, packages);
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
