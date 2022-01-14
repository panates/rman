import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import EasyTable from 'easy-table';
import {Command, CommandOptions} from '../core/command';
import {Repository} from '../core/repository';
import {Package} from '../core/package';
import {GitHelper} from '../utils/git-utils';
import PrintRowData = ListCommand.PackageOutput;

export class ListCommand extends Command {

    onPrepare?(pkg: Package, data: PrintRowData): PrintRowData;

    onPrintTable?(pkg: Package, data: PrintRowData, table: EasyTable): PrintRowData;

    constructor(readonly repository: Repository, public options: ListCommand.Options = {}) {
        super(repository, options);
    }

    protected _filter(pkg: Package, inf: { isDirty?: boolean, isCommitted?: boolean }): boolean {
        return !this.options?.filter || this.options.filter(pkg);
    }

    protected async _execute(): Promise<any> {
        const {repository, options} = this;
        const packages = repository.getPackages({toposort: options.toposort});

        const git = new GitHelper({cwd: repository.dirname});
        const dirtyFiles = await git.listDirtyFiles({absolute: true});
        const committedFiles = await git.listCommittedFiles({absolute: true});

        const table = new EasyTable();
        const arr: any[] = [];
        const obj: any = {};
        for (const p of packages) {
            const isDirty = !!dirtyFiles.find(f => !path.relative(p.dirname, f).startsWith('..'));
            const isCommitted = !!committedFiles.find(f => !path.relative(p.dirname, f).startsWith('..'));
            if (!this._filter(p, {isDirty, isCommitted}))
                continue;
            if (options.graph) {
                obj[p.name] = [...p.dependencies];
                continue;
            }
            const location = path.relative(repository.dirname, p.dirname);
            let o: PrintRowData = {
                name: p.name,
                version: p.version,
                location,
                private: p.isPrivate,
                isDirty,
                isCommitted
            }
            o = this.onPrepare ? this.onPrepare(p, o) : o;
            if (!o)
                continue;

            arr.push(o);
            if (!options.json) {
                if (options.parseable) {
                    const a: string[] = [location, p.name, p.version,
                        (p.isPrivate ? 'PRIVATE' : ''),
                        (isDirty ? 'DIRTY' : (isCommitted ? ':COMMITTED' : ''))
                    ];
                    this.log(a.join('::'));
                } else if (options.long) {
                    if (this.onPrintTable)
                        this.onPrintTable(p, o, table);
                    else {
                        table.cell('Package', chalk.yellowBright(p.name));
                        table.cell('Version', chalk.yellow(p.version));
                        table.cell('Private', p.isPrivate ? chalk.magentaBright('yes') : '');
                        table.cell('Changed', isDirty ? chalk.magenta('dirty') :
                            (isCommitted ? chalk.yellow('committed') : ''));
                        table.cell('Path', path.relative(repository.dirname, p.dirname));
                        table.newRow();
                    }
                } else
                    this.log(p.name);
            }
        }
        if (options.graph) {
            this.log(obj);
            return obj;
        } else if (options.json) {
            this.log(arr);
        } else if (options?.long)
            this.log(table.toString());
        return arr;
    }


}

export namespace ListCommand {

    export interface Options extends CommandOptions {
        json?: boolean;
        parseable?: boolean;
        long?: boolean;
        toposort?: boolean;
        graph?: boolean;
        changed?: boolean;
        filter?: (pkg: Package) => boolean;
    }

    export interface PackageOutput {
        name: string;
        version?: string;
        location?: string;
        private?: boolean;
        isDirty?: boolean;
        isCommitted?: boolean;
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        'j': {
            alias: 'json',
            describe: '# Stream output as json'
        },
        'l': {
            alias: 'long',
            describe: '# Show extended information'
        },
        'p': {
            alias: 'parseable',
            describe: '# Show parseable output'
        },
        't': {
            alias: 'toposort',
            describe: '# Sort packages in topological order (dependencies before dependents) instead of lexical by directory'
        },
        'g': {
            alias: 'graph',
            describe: '# Show dependency graph as a JSON-formatted adjacency list'
        }
    }

    export function initCli(workspace: Repository, program: yargs.Argv) {
        program.command({
            command: 'list [options...]',
            describe: 'Lists packages in repository',
            aliases: ['ls'],
            builder: (cmd) => {
                return cmd
                    .example("$0 list", "# List all packages")
                    .example('$0 list --json', '# List all packages in JSON format')
                    .conflicts('graph', ['parseable', 'json'])
                    .conflicts('long', ['parseable', 'json'])
                    .option(cliCommandOptions);
            },
            handler: async (options) => {
                await new ListCommand(workspace, {...options, logger: console.log})
                    .execute();
            }
        })
    }
}

