import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import semver from 'semver';
import EasyTable from 'easy-table';
import {Command} from '../core/command';
import {Repository} from '../core/repository';
import {GitHelper} from '../utils/git-utils';
import stripColor from 'strip-color';

export class VersionCommand extends Command {

    commandName = 'version';

    constructor(readonly repository: Repository, public options: VersionCommand.Options) {
        super(repository);
    }

    protected async _execute(): Promise<any> {
        const {repository} = this;
        const git = new GitHelper({cwd: repository.dirname});
        const noDirty = this.getOption('noDirty');
        const forceDirty = this.getOption('forceDirty');
        const listAll = this.getOption('all');
        const listUnified = this.getOption('unified');
        const printJson = this.getOption('json');

        const dirtyFiles = await git.listDirtyFiles();
        const committedFiles = await git.listCommittedFiles();

        const packages = repository.getPackages();
        const rows: any[] = [];
        let error = false;
        for (const p of packages) {
            const row: any = {
                package: p
            }
            rows.push(row);

            const relDir = path.relative(repository.dirname, p.dirname);
            const isDirty = dirtyFiles.find(f => !path.relative(relDir, f).startsWith('..'));
            if (isDirty) {
                if (noDirty) {
                    row.status = chalk.yellow('ignored');
                    row.desc = chalk.magenta('Git directory is not clean')
                    continue;
                }
                if (!forceDirty) {
                    error = true;
                    row.status = chalk.red('error');
                    row.desc = chalk.yellow('Git directory is not clean')
                    continue;
                }
            }

            const isChanged = committedFiles.find(f => !path.relative(relDir, f).startsWith('..'));
            if (isChanged || listAll || listUnified) {
                const newVer = semver.inc(p.version, this.options.bump as semver.ReleaseType);
                row.status = chalk.greenBright('updated');
                row.newVersion = newVer;
            } else {
                row.status = chalk.yellow('no-change');
                row.desc = chalk.yellow('No change detected')
            }
        }
        if (listUnified) {
            const maxVer = rows.reduce((v, row) => {
                if (!row.newVersion)
                    return v;
                return semver.gt(row.newVersion, v) ? row.newVersion : v;
            }, '0.0.0');
            rows.forEach(row => {
                if (row.newVersion)
                    row.newVersion = maxVer;
            });
        }

        if (printJson) {
            const output: any[] = [];
            for (const row of rows) {
                const p = row.package;
                output.push({
                    name: p.name,
                    version: p.version,
                    newVersion: row.newVersion && stripColor(row.newVersion),
                    status: row.status && stripColor(row.status),
                    description: row.desc && stripColor(row.desc)
                })
            }
            this.log(output);
        } else {
            const table = new EasyTable();
            for (const row of rows) {
                const p = row.package;
                table.cell('Package', chalk.yellowBright(p.name));
                table.cell('Version', p.version);
                table.cell('New Version', row.newVersion);
                table.cell('Status', row.status);
                table.cell('Description', row.desc);
                table.newRow();
            }
            this.log(table.toString());
        }
        rows.forEach(row => {
            if (row.newVersion) {
                const p = row.package;
                p.json.version = row.newVersion;
                const f = path.join(p.dirname, 'package.json');
                const data = JSON.stringify(p.json, undefined, -2);
                fs.writeFileSync(f, data, 'utf-8');
            }
        });
        if (error)
            throw new Error('Operation cancelled due to error. No chance made.');
    }
}

export namespace VersionCommand {
    export interface Options {
        bump: string;
        json?: boolean;
        unified?: boolean;
        all?: boolean;
        noDirty?: boolean;
        forceDirty?: boolean;
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        'j': {
            alias: 'json',
            describe: '# Stream output as json'
        },
        'u': {
            alias: 'unified',
            describe: '# Keep all package versions same',
            type: 'boolean'
        },
        'a': {
            alias: 'all',
            describe: '# Bump version for all packages even no commits',
            type: 'boolean'
        },
        'no-dirty': {
            describe: '# Ignore dirty packages',
            type: 'boolean'
        },
        'force-dirty': {
            describe: '# Force bump version for dirty packages',
            type: 'boolean'
        }
    }

    export function initCli(workspace: Repository, program: yargs.Argv) {
        program.command({
            command: 'version [bump]',
            describe: 'Bump version of packages',
            builder: (cmd) => {
                return cmd
                    .example("$0 version patch", "# semver keyword")
                    .example('$0 version 1.0.1', '# explicit')
                    .conflicts('no-dirty', ['force-dirty', 'unified'])
                    .option(cliCommandOptions);
            },
            handler: async (options) => {
                const bump = options.bump as string;
                await new VersionCommand(workspace, {
                    ...options,
                    bump,
                    noDirty: !options.dirty
                }).execute();
            }
        })
    }
}
