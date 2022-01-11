import chalk from 'chalk';
import envinfo from 'envinfo';
import semver from 'semver';
import yargs from 'yargs';
import {Command, CommandOptions} from '../core/command';
import {Workspace} from '../core/workspace';
import path from 'path';

export class ChangedCommand extends Command {

    constructor(readonly workspace: Workspace, public options: ChangedCommand.Options = {}) {
        super(workspace, options);
    }

    protected async _execute(): Promise<any> {
        const {workspace, options} = this;

        const packages = this.workspace.getPackages({toposort: false});

        this.log(chalk.whiteBright('Workspace: ') + chalk.cyanBright(workspace.dirname));
        this.log(chalk.whiteBright('Package list: '), '\n');

        const maxName = packages.reduce((l, p) => l = Math.max(l, p.name.length), 0);
        const arr: any[] = [];
        const obj: any = {};
        for (const p of packages) {
            const location = path.relative(workspace.dirname, p.dirname);
            const o: any = {
                name: p.name,
                version: p.version,
                location
            }
            if (p.def.private)
                o.private = true;
            arr.push(o);
            if (!options.json) {
                this.log(p.name + ' '.repeat(maxName - p.name.length + 1),
                    chalk.yellow(p.version),
                    (p.def.private ? chalk.magenta(' (private) ') : chalk.green(' (public) ')),
                    chalk.yellow(path.relative(workspace.dirname, p.dirname))
                );
            }
        }
        if (options.json) {
            this.log(arr);
            return arr;
        }
    }

}

export namespace ChangedCommand {
    export interface Options extends CommandOptions {
        json?: boolean;
        includeMergedTags?: boolean;
    }

    export function initCli(workspace: Workspace, program: yargs.Argv) {
        program.command({
            command: 'changed [options...]',
            describe: 'List local packages that have changed since the last tagged release',
            builder: (cmd) => {
                return cmd
                    .example("$0 changed", "# Prints information")
                    .example('$0 changed --json', '# Prints information in JSON format')
                    .option({
                        'j': {
                            alias: 'json',
                            describe: '# Stream output as json'
                        },
                        'include-merged-tags': {
                            describe: '# Include tags from merged branches when detecting changed packages',
                            type: 'boolean'
                        }
                    });
            },
            handler: async (options) => {
                await new ChangedCommand(workspace, {...options, logger: console.log})
                    .execute();
            }
        })
    }
}
