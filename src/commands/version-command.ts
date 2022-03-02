import path from 'path';
import fs from 'fs';
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

        if (this.options.unified) {
            const maxVer = Object.values(newVersions).reduce((m, v) => {
                return semver.gt(m, v) ? m : v;
            }, '0.0.0');
            Object.keys(newVersions).forEach(k => newVersions[k] = maxVer);
        }

        return super._prepareTasks(selectedPackages, {newVersions});
    }

    protected async _exec(args: {
        name: string;
        json: any;
        dirname: string;
        dependencies?: string[];
        command: string;
    }, ctx?: any): Promise<ExecuteCommandResult> {
        if (args.name === 'root')
            return {code: 0};
        if (args.command === '#') {
            const {newVersions} = ctx;
            const oldVer = args.json.version;
            const newVer = newVersions[args.name];
            args.json.version = newVer;
            delete args.json.scripts.version;
            const f = path.join(args.dirname, 'package.json');
            const data = JSON.stringify(args.json, undefined, 2);
            fs.writeFileSync(f, data, 'utf-8');
            logger.info(
                this.commandName,
                args.name,
                logger.separator,
                'Version changed from ' + chalk.cyan(oldVer) + ' to ' + chalk.cyan(newVer)
            );
            return {code: 0};
        }
        return super._exec(args, ctx);
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
