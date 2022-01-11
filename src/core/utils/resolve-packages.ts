import glob from 'fast-glob';
import {Package} from '../package';
import {getPackageJson} from '../../utils';

export function resolvePackages(root: string, patterns: string[]): Package[] {
    const packages: Package[] = [];
    for (const pattern of patterns) {
        const dirs = glob.sync(pattern, {
            cwd: root,
            absolute: true,
            deep: 0,
            onlyDirectories: true
        });
        for (const dir of dirs) {
            const p = detectPackage(dir);
            if (p && !packages.find(x => x.name === p.name))
                packages.push(p);
        }
    }
    determineDependencies(packages);
    return packages;
}


function detectPackage(dirname: string): Package | undefined {
    const pkgJson = getPackageJson(dirname);
    if (pkgJson && pkgJson.name) {
        return new Package(dirname, pkgJson);
    }
}

function determineDependencies(packages: Package[]) {
    const  getPackage = (name: string): Package | undefined => {
        return packages.find(p => p.name === name);
    }
    const deps = {};
    for (const pkg of packages) {
        const o = {
            ...pkg.def.dependencies,
            ...pkg.def.devDependencies,
            ...pkg.def.peerDependencies,
            ...pkg.def.optionalDependencies
        }
        const dependencies: string[] = [];
        for (const k of Object.keys(o)) {
            const p = getPackage(k);
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
                const p = getPackage(s);
                if (p) {
                    deepFindDependencies(p, target);
                }
            }
        }
    }

    for (const pkg of packages) {
        circularCheck = [];
        deepFindDependencies(pkg, pkg.dependencies);
    }
}
