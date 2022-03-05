import path from 'path';
import yargs from 'yargs';
import chalk from 'chalk';
import semver from 'semver';
import logger from 'npmlog';
import stripColor from 'strip-color';
import {Task} from 'power-tasks';
import {Repository} from '../core/repository';
import {RunCommand} from './run-command';
import {GitHelper} from '../utils/git-utils';
import {Package} from '../core/package';
import {Command} from '../core/command';
import {ExecuteCommandResult} from '../utils/exec';
import fs from 'fs/promises';

export class VersionCommand extends RunCommand<VersionCommand.Options> {

    static commandName = 'version';

    constructor(readonly repository: Repository,
                public bump: string,
                options?: VersionCommand.Options) {
        super(repository, 'version', options);
    }

    protected async _prepareTasks(packages: Package[]): Promise<Task[]> {
        const {repository} = this;
        const git = new GitHelper({cwd: repository.dirname});

        const dirtyFiles = await git.listDirtyFiles();
        const committedFiles = await git.listCommittedFiles();

        const newVersions: Record<string, string> = {};
        let errorCount = 0;
        const selectedPackages: Package[] = [];
        for (const p of packages) {
            const relDir = path.relative(repository.dirname, p.dirname);
            let status = '';
            let message = '';
            let newVer: any = '';
            const logPkgName = chalk.yellow(p.name);

            if (!this.options.noTag) {
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
                    chalk.whiteBright(p.version),
                    status,
                    logger.separator,
                    message);
                continue;
            }
            selectedPackages.push(p);
        }

        if (errorCount)
            throw new Error('Unable to bump version due to error(s)');

        const maxVer = Object.values(newVersions).reduce((m, v) => {
            return semver.gt(m, v) ? m : v;
        }, '0.0.0');
        if (this.options.unified) {
            Object.keys(newVersions).forEach(k => newVersions[k] = maxVer);
        }

        const tasks = await super._prepareTasks(selectedPackages, {newVersions});
        tasks.forEach(t => t.options.exclusive = true);
        if (this.options.unified)
            tasks.push(new Task(async () => {
                try {
                    await super._exec({
                        name: 'rman',
                        command: 'git tag -a "v' + maxVer + '" -m "version ' + maxVer + '"',
                        cwd: this.repository.dirname,
                        stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe',
                        logLevel: 'silly'
                    });
                } catch {
                    //
                }
            }, {exclusive: true}));
        return tasks;
    }

    protected async _exec(args: {
        name: string;
        json: any;
        cwd: string;
        dependencies?: string[];
        command: string;
    }, options?: any): Promise<ExecuteCommandResult> {
        if (args.name === 'root')
            return {code: 0};
        if (args.command === '#') {
            const {newVersions} = options;
            const oldVer = args.json.version;
            const newVer = newVersions[args.name];
            args.json.version = newVer;
            delete args.json.scripts.version;
            const f = path.join(args.cwd, 'package.json');
            const data = JSON.stringify(args.json, undefined, 2);
            await fs.writeFile(f, data, 'utf-8');

            if (!this.options.noTag) {
                await super._exec({
                    name: args.name,
                    command: 'git commit -m "' + newVer + '" package.json',
                    cwd: args.cwd,
                    stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe',
                    logLevel: 'silly'
                });
            }
            logger.info(
                this.commandName,
                args.name,
                logger.separator,
                'Version changed from ' + chalk.cyan(oldVer) + ' to ' + chalk.cyan(newVer)
            );
            return {code: 0};
        }
        return super._exec(args, options);
    }
}

export namespace VersionCommand {
    export interface Options extends RunCommand.Options {
        unified?: boolean;
        all?: boolean;
        ignoreDirty?: boolean;
        noTag?: boolean;
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
            describe: '# Do not bump version for dirty packages',
            type: 'boolean'
        },
        'no-tag': {
            alias: 'n',
            describe: '# Do not crate git version tag. (Ignores dirty check)',
            type: 'boolean'
        }
    }

    export function initCli(repository: Repository, program: yargs.Argv) {
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
            handler: async (args) => {
                const bump = args.bump as string;
                const options = Command.composeOptions(VersionCommand.commandName, args, repository.config);
                await new VersionCommand(repository, bump, options).execute();
            }
        })
    }
}
