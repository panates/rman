import yargs from 'yargs';
import {Repository} from '../core/repository';
import {ListCommand} from './list.command';
import {Package} from '../core/package';

export class ChangedCommand extends ListCommand {

    commandName = 'changed';

    constructor(readonly repository: Repository, public options: ChangedCommand.Options = {}) {
        super(repository, {...options});
    }

    protected _filter(pkg: Package, inf: { isDirty?: boolean; isCommitted?: boolean }): boolean {
        if (!super._filter(pkg, inf))
            return false;
        return !!(inf.isDirty || inf.isCommitted);
    }

}

export namespace ChangedCommand {

    export interface Options extends Omit<ListCommand.Options, 'filter'> {
    }

    export function initCli(repository: Repository, program: yargs.Argv) {
        program.command({
            command: 'changed [options...]',
            describe: 'List local packages that have changed since the last tagged release',
            builder: (cmd) => {
                return cmd
                    .example("$0 changed", "# List changed packages")
                    .example('$0 changed --json', '# List changed packages in JSON format')
                    .option(ListCommand.cliCommandOptions);
            },
            handler: async (options) => {
                await new ChangedCommand(repository, options as Options)
                    .execute();
            }
        })
    }
}
