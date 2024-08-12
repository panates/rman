import * as yargs from 'yargs';
import { Command } from '../core/command.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';
import { ListCommand } from './list-command.js';

export class ChangedCommand extends ListCommand {
  static commandName = 'changed';

  constructor(
    readonly repository: Repository,
    options?: ListCommand.Options,
  ) {
    super(repository, options);
  }

  protected _filter(pkg: Package, inf: { isDirty?: boolean; isCommitted?: boolean }): boolean {
    if (!super._filter(pkg, inf)) return false;
    return !!(inf.isDirty || inf.isCommitted);
  }
}

export namespace ChangedCommand {
  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'changed [options...]',
      describe: 'List local packages that have changed since the last tagged release',
      builder: cmd =>
        cmd
          .example('$0 changed', '# List changed packages')
          .example('$0 changed --json', '# List changed packages in JSON format')
          .option(ListCommand.cliCommandOptions),
      handler: async args => {
        const options = Command.composeOptions(ChangedCommand.commandName, args, repository.config);
        await new ChangedCommand(repository, options).execute();
      },
    });
  }
}
