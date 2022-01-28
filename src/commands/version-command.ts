import path from 'path';
import fs from 'fs';
import yargs from 'yargs';
import chalk from 'chalk';
import semver from 'semver';
import logger from 'npmlog';
import stripColor from 'strip-color';
import figures from 'figures';
import {Repository} from '../core/repository';
import {RunCommand} from './run-command';
import {MultiTaskCommand} from './multi-task-command';
import {ExecuteCommandResult} from '../utils/execute';
import {GitHelper} from '../utils/git-utils';
import {Package} from '../core/package';

export class VersionCommand extends RunCommand<VersionCommand.Options> {

    static commandName = 'version';

    constructor(readonly repository: Repository,
                public bump: string,
                options?: VersionCommand.Options) {
        super(repository, 'version', options);
    }

    protected _readOptions(keys: string[], options?: any) {
        super._readOptions([...keys,
            'unified', 'all', 'ignoreDirty', 'forceDirty'], options);
    }

    protected async _prepareTasks(): Promise<void> {
        const {repository} = this;
        const git = new GitHelper({cwd: repository.dirname});

        const dirtyFiles = await git.listDirtyFiles();
        const committedFiles = await git.listCommittedFiles();

        const packages = repository.getPackages({toposort: true});
        const newVersions: Record<string, string> = {};
        let errorCount = 0;
        const selectedPackages: Package[] = [];
        for (const p of packages) {
            const relDir = path.relative(repository.dirname, p.dirname);
            let status = '';
            let message = '';
            let newVer: any = '';
            const logPkgName = chalk.yellow(p.name);

            if (!this.options.forceDirty) {
                const isDirty = dirtyFiles.find(f => !path.relative(relDir, f).startsWith('..'));
                if (isDirty) {
                    if (!this.options.ignoreDirty)
                        errorCount++;
                    status = this.options.ignoreDirty ?
                        chalk.cyan.bold('skip') : chalk.redBright.bold('error');
                    message = 'Git directory is not clean';
                }
            }

            if (!status) {
                const isChanged = committedFiles.find(f => !path.relative(relDir, f).startsWith('..'));
                newVer = (isChanged || this.options.all || this.options.unified) ?
                    semver.inc(p.version, this.bump as semver.ReleaseType) : undefined;
                if (newVer)
                    newVersions[p.name] = newVer;
                else {
                    status = chalk.cyanBright.bold('no-change');
                    message = 'No change detected';
                }
            }

            if (status) {
                if (this.options.json)
                    logger.info(this.commandName, '%j', {
                        package: p.name,
                        version: p.version,
                        newVersion: newVer,
                        status: stripColor(status),
                        message: stripColor(message),
                    });
                else logger.log(this.options.ignoreDirty ? 'info' : 'error',
                    this.commandName,
                    logPkgName,
                    chalk.gray(figures.lineVerticalDashed0),
                    chalk.whiteBright(p.version),
                    chalk.gray(figures.lineVerticalDashed0),
                    status,
                    chalk.gray(figures.lineVerticalDashed0),
                    message);
                continue;
            }
            selectedPackages.push(p);
        }

        if (errorCount)
            throw new Error('Unable to bump version due to error(s)');

        for (const p of selectedPackages) {
            const j = {...p.json};
            j.scripts.version = j.scripts.version || '#version';
            this._prepareTasksFromScripts(p, j);
        }

        if (this.options.unified) {
            const maxVer = Object.values(newVersions).reduce((m, v) => {
                return semver.gt(m, v) ? m : v;
            }, '0.0.0');
            Object.keys(newVersions).forEach(k => newVersions[k] = maxVer);
        }

        for (const task of this._tasks) {
            for (const step of task.steps) {
                if (step.cmd === '#version') {
                    step.waitDependencies = false;
                    step.subName = 'bumpVersion';
                    step.cmd = async (atask: MultiTaskCommand.Task): Promise<ExecuteCommandResult> => {
                        const oldVer = atask.package.version;
                        const newVer = newVersions[atask.package.name];

                        const p = atask.package;
                        p.json.version = newVer;
                        const f = path.join(p.dirname, 'package.json');
                        const data = JSON.stringify(p.json, undefined, -2);
                        fs.writeFileSync(f, data, 'utf-8');
                        step.resultMessage = 'Version changed from ' +
                            chalk.cyan(oldVer) + ' to ' + chalk.cyan(newVer);
                        return {code: 0};
                    }
                }
            }
        }
    }

    protected _taskStatusChange(task: MultiTaskCommand.Task) {
        super._taskStatusChange(task);
    }
}

export namespace VersionCommand {
    export interface Options extends RunCommand.Options {
        unified?: boolean;
        all?: boolean;
        ignoreDirty?: boolean;
        forceDirty?: boolean;
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        'unified': {
            alias: 'u',
            describe: '# Keep all package versions same',
            type: 'boolean'
        },
        'all': {
            alias: 'a',
            describe: '# Bump version for all packages even no commits',
            type: 'boolean'
        },
        'ignore-dirty': {
            alias: 'i',
            describe: '# Ignore dirty packages',
            type: 'boolean'
        },
        'force-dirty': {
            alias: 'f',
            describe: '# Force bump version for dirty packages',
            type: 'boolean'
        }
    }

    export function initCli(workspace: Repository, program: yargs.Argv) {
        program.command({
            command: 'version [bump] [...options]',
            describe: 'Bump version of packages',
            builder: (cmd) => {
                return cmd
                    .example("$0 version patch", "# semver keyword")
                    .example('$0 version 1.0.1', '# explicit')
                    .conflicts('ignore-dirty', ['force-dirty', 'unified'])
                    .option(cliCommandOptions);
            },
            handler: async (options) => {
                const bump = options.bump as string;
                await new VersionCommand(workspace, bump, options as Options).execute();
            }
        })
    }
}
