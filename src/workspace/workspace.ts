import fs from 'fs';
import glob from 'fast-glob';
import path from 'path';
import chalk from 'chalk';
import {MultiBar, Presets, SingleBar} from 'cli-progress';
import {getPackageJson, setFind} from './utils';
import {executeCommand, IRunScriptOptions} from './executor';
import {CommandResult, Package, RunScriptResult} from './package';
import {IWorkspaceOptions, IWorkspaceProvider} from './types';
import {NpmProvider} from './providers/npm-provider';

const providers: IWorkspaceProvider[] = [
    new NpmProvider()
];

export class Workspace {

    private _options: IWorkspaceOptions;
    private _packages: Package[];

    protected constructor(readonly root: string, packages: Package[], options?: IWorkspaceOptions) {
        this._options = {...options};
        this._packages = packages;
        this._determineDependencies();
        this._sortPackages();
    }

    get packages(): Package[] {
        return this._packages;
    }

    getPackage(name: string): Package | undefined {
        return this.packages.find(p => p.name === name);
    }

    async runScript(script: string, options: IRunScriptOptions = {}): Promise<RunScriptResult> {
        const packages: Record<string, any> = {};
        const result: RunScriptResult = {
            script,
            errorCount: 0,
            commands: []
        };
        options.gauge = options.gauge == null ? true : options.gauge;
        let totalCommands = 0;
        for (const p of this.packages) {
            const commands = p.getScriptCommands(script);
            totalCommands += commands.length;
            packages[p.name] = {
                package: p,
                commands: [...commands]
            }
        }
        if (!totalCommands)
            return result;

        let overallProgress: SingleBar | undefined;
        const progressBars = options.gauge && new MultiBar({
            format: '[' + chalk.cyan('{bar}') + '] {percentage}% | {value}/{total} | ' +
                chalk.yellowBright('{package}') + ' | ' + chalk.yellow('{command}'),
            barsize: 30,
            hideCursor: true,
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
        }, Presets.rect);

        if (progressBars) {
            overallProgress = progressBars.create(totalCommands, 0);
            overallProgress.start(totalCommands, 0, {package: '=== OVERALL ===', command: ''});
            for (const p of Object.values(packages)) {
                if (p.commands.length) {
                    p.progress = progressBars.create(p.commands.length, 0);
                    p.progress.start(p.commands.length, 0,{
                        package: p.name,
                        command: 'Waiting'
                    });
                }
            }
        }

        const t = Date.now();
        return new Promise<RunScriptResult>((resolve) => {
            const remaining = new Set<string>(Object.keys(packages));
            const runScripts = () => {
                for (const pkgName of remaining) {
                    const pkgInfo = packages[pkgName];
                    const pkg = pkgInfo.package;
                    const progress = pkgInfo.progress;

                    for (let k = 0; k < pkgInfo.commands.length; k++) {
                        const cmd = pkgInfo.commands[k];
                        if (cmd.status === 'running')
                            break;
                        if (!cmd.status) {
                            const concurrent = cmd.step.startsWith('pre');
                            if (!concurrent &&
                                pkg.dependencies.find(dep => setFind(remaining, p => p === dep))) {
                                cmd.status = '';
                                if (progress)
                                    progress.update({command: chalk.bgYellow.white('Waiting dependencies')});
                                break;
                            }
                            cmd.status = 'running';
                            if (progress)
                                progress.update({command: cmd.name});
                            else console.log('[' + chalk.whiteBright(pkg.name) + ']  ' +
                                chalk.yellow(cmd.command), (chalk.cyanBright(' +' + (Date.now() - t)))
                            );
                            void executeCommand(cmd.command, {
                                ...options,
                                cwd: pkg.dirname,
                                shell: true
                            }).then(r => {
                                if (overallProgress)
                                    overallProgress.increment(1);
                                if (progress)
                                    progress.increment(1);
                                const cr: CommandResult = {
                                    package: pkg.name,
                                    command: cmd,
                                    code: r.code || 1,
                                    error: r.error,
                                    stdout: r.stdout,
                                    stderr: r.stderr
                                }
                                result.code = result.code || r.code;
                                if (r.error)
                                    result.errorCount++;
                                result.commands.push(cr);

                                cmd.status = 'done';
                                if (r.error || k === pkgInfo.commands.length - 1) {
                                    if (progress) {
                                        if (r.error)
                                            progress.update({command: chalk.yellow(cmd.name) + chalk.red(' Filed!')});
                                        else
                                            progress.update({command: chalk.green(' Completed!')});
                                    }
                                    remaining.delete(pkg.name);
                                }
                                if (!remaining.size) {
                                    if (progressBars)
                                        progressBars.stop();
                                    return resolve(result);
                                }
                                if (!result.errorCount)
                                    setTimeout(runScripts, 1);
                            });
                            if (!concurrent)
                                break;
                        }
                    }
                }
            };
            runScripts();
        });
    }

    static create(root?: string, options?: { deep?: number }): Workspace {
        root = root || process.cwd();
        let deep = options?.deep || 0;
        while (deep-- >= 0 && fs.existsSync(root)) {
            for (let i = providers.length - 1; i >= 0; i--) {
                const provider = providers[i];
                const inf = provider.parse(root);
                if (!inf)
                    continue
                const pkgJson = getPackageJson(inf.root);
                if (!pkgJson)
                    continue;
                const packages: Package[] = [];
                for (const pattern of inf.packages) {
                    const dirs = glob.sync(pattern, {
                        cwd: inf.root,
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
                return new Workspace(inf.root, packages, pkgJson.rman);
            }
            root = path.resolve(root, '..');
        }
        throw new Error('No project workspace detected');
    }

    private _determineDependencies() {
        const deps = {};
        for (const pkg of this.packages) {
            const o = {
                ...pkg.def.dependencies,
                ...pkg.def.devDependencies,
                ...pkg.def.peerDependencies,
                ...pkg.def.optionalDependencies
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

        for (const pkg of this.packages) {
            circularCheck = [];
            deepFindDependencies(pkg, pkg.dependencies);
        }
    }

    private _sortPackages() {
        const packages = [...this.packages];
        const packageOrder = this._options.packageOrder;
        packages.sort((a, b) => {
            if (packageOrder) {
                const a1 = packageOrder.indexOf(a.name);
                const b1 = packageOrder.indexOf(b.name);
                const i = (a1 >= 0 ? a1 : Number.MAX_SAFE_INTEGER) - (b1 >= 0 ? b1 : Number.MAX_SAFE_INTEGER);
                if (i !== 0)
                    return i;
            }
            if (b.dependencies.includes(a.name))
                return -1;
            if (a.dependencies.includes(b.name))
                return 1;
            return 0;
        })
        this._packages = packages;
    }

}


function detectPackage(dirname: string): Package | undefined {
    const pkgJson = getPackageJson(dirname);
    if (pkgJson && pkgJson.name) {
        return new Package(dirname, pkgJson);
    }
}
