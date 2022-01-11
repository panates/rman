import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import {Command, CommandOptions} from '../core/command';
import {Workspace} from '../core/workspace';

export class ListCommand extends Command {

    constructor(readonly workspace: Workspace, public options: ListCommand.Options = {}) {
        super(workspace, options);
    }

    protected async _execute(): Promise<any> {
        const {workspace, options} = this;
        if (options.graph && (options.parseable || options.json))
            throw new Error('Can\'t mix "graph" option with other options');

        const packages = this.workspace.getPackages({toposort: options.toposort});

        this.log(chalk.whiteBright('Workspace: ') + chalk.cyanBright(workspace.dirname));
        this.log(chalk.whiteBright('Package list: '), '\n');

        const maxName = packages.reduce((l, p) => l = Math.max(l, p.name.length), 0);
        const arr: any[] = [];
        const obj: any = {};
        for (const p of packages) {
            const location = path.relative(workspace.dirname, p.dirname);
            if (options.graph) {
                obj[p.name] = [...p.dependencies];
                continue;
            }
            const o: any = {
                name: p.name,
                version: p.version,
                location
            }
            if (p.def.private)
                o.private = true;
            arr.push(o);
            if (!options.json) {
                if (options.parseable) {
                    this.log(location + ':' + p.name + ':' + p.version +
                        (!p.def.private ? ':PRIVATE' : ''));
                } else {
                    this.log(p.name + ' '.repeat(maxName - p.name.length + 1),
                        chalk.yellow(p.version),
                        (p.def.private ? chalk.magenta(' (private) ') : chalk.green(' (public) ')),
                        chalk.yellow(path.relative(workspace.dirname, p.dirname))
                    );
                }
            }
        }
        if (options.graph) {
            this.log(obj);
            return obj;
        } else if (options.json) {
            this.log(arr);
            return arr;
        }
    }

}

export namespace ListCommand {

    export interface Options extends CommandOptions {
        json?: boolean;
        parseable?: boolean;
        toposort?: boolean;
        graph?: boolean;
    }

    export function initCli(workspace: Workspace, program: yargs.Argv) {
        program.command({
            command: 'list [options...]',
            describe: 'Lists packages in repository',
            aliases: ['ls'],
            builder: (cmd) => {
                return cmd
                    .example("$0 list", "# List all packages")
                    .example('$0 list --json', '# List all packages in JSON format')
                    .conflicts('graph', ['parseable', 'json'])
                    .option({
                        'j': {
                            alias: 'json',
                            describe: '# Stream output as json'
                        }
                    });
            },
            handler: async (options) => {
                await new ListCommand(workspace, {...options, logger: console.log})
                    .execute();
            }
        })
    }
}

