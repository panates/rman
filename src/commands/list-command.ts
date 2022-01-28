import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import EasyTable from 'easy-table';
import logger from 'npmlog';
import {Command} from '../core/command';
import {Repository} from '../core/repository';
import {Package} from '../core/package';
import {GitHelper} from '../utils/git-utils';

export class ListCommand<TOptions extends ListCommand.Options = ListCommand.Options> extends Command<TOptions> {
    static commandName = 'list';

    onPrepare?(pkg: Package, data: ListCommand.PackageOutput): ListCommand.PackageOutput;

    onPrintTable?(pkg: Package, data: ListCommand.PackageOutput, table: EasyTable): ListCommand.PackageOutput;

    constructor(readonly repository: Repository, options?: TOptions) {
        super(repository, options);
    }

    protected _readOptions(keys: string[], options?: any) {
        super._readOptions([...keys,
            'parseable', 'short', 'toposort', 'graph', 'changed', 'filter'], options);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected _filter(pkg: Package, inf: { isDirty?: boolean, isCommitted?: boolean }): boolean {
        return true;
    }

    protected async _execute(): Promise<any> {
        const {repository} = this;
        const packages = repository.getPackages({toposort: this.options.toposort});

        const git = new GitHelper({cwd: repository.dirname});
        const dirtyFiles = await git.listDirtyFiles({absolute: true});
        const committedFiles = await git.listCommittedFiles({absolute: true});

        const table = new EasyTable();
        const arr: any[] = [];
        const obj: any = {};
        let count = 0;
        for (const p of packages) {
            const isDirty = !!dirtyFiles.find(f => !path.relative(p.dirname, f).startsWith('..'));
            const isCommitted = !!committedFiles.find(f => !path.relative(p.dirname, f).startsWith('..'));
            if (!this._filter(p, {isDirty, isCommitted}))
                continue;
            if (this.options.graph) {
                count++;
                obj[p.name] = [...p.dependencies];
                continue;
            }
            const location = path.relative(repository.dirname, p.dirname);
            let o: ListCommand.PackageOutput = {
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
            count++;
            if (!this.options.json) {
                if (this.options.parseable) {
                    const a: string[] = [location, p.name, p.version,
                        (p.isPrivate ? 'PRIVATE' : ''),
                        (isDirty ? 'DIRTY' : (isCommitted ? ':COMMITTED' : ''))
                    ];
                    logger.output('', a.join('::'));
                } else if (this.options.short) {
                    logger.output('', p.name);
                } else {
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
                }

            }
        }

        if (this.options.graph) {
            logger.output('', '%j', obj);
            return obj;
        } else if (this.options.json) {
            logger.output('', '%j', arr);
            return arr;
        } else if ((table as any).rows.length) {
            logger.output('', '%s', table.toString().trim());
            console.log('');
            logger.info('list', '%i Package(s) found', count);
            return arr;
        }
        return arr;
    }

}

export namespace ListCommand {

    export interface Options {
        json?: boolean;
        parseable?: boolean;
        short?: boolean;
        toposort?: boolean;
        graph?: boolean;
        changed?: boolean;
        filter?: string | ((pkg: Package) => boolean);
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
        'short': {
            alias: 's',
            describe: '# Do not show extended information'
        },
        'parseable': {
            alias: 'p',
            describe: '# Show parseable output'
        },
        'toposort': {
            alias: 't',
            describe: '# Sort packages in topological order (dependencies before dependents) instead of lexical by directory'
        },
        'graph': {
            alias: 'g',
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
                    .conflicts('short', ['parseable', 'json'])
                    .option(cliCommandOptions);
            },
            handler: async (options) => {
                await new ListCommand(workspace, options as Options)
                    .execute();
            }
        })
    }
}

