import * as yargs from 'yargs';
import { Command } from '../core/command.js';
import { Repository } from '../core/repository.js';
import { RunCommand } from './run-command.js';

export class BuildCommand extends RunCommand<any> {
  static commandName = 'build';

  constructor(
    readonly repository: Repository,
    options?: RunCommand.Options,
  ) {
    super(repository, 'build', options);
  }
}

export namespace BuildCommand {
  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'build [options...]',
      describe: 'Alias for "run build"',
      builder: cmd => cmd.example('$0 build', '# Builds packages').option(BuildCommand.cliCommandOptions),
      handler: async args => {
        const options = Command.composeOptions(BuildCommand.commandName, args, repository.config);
        await new BuildCommand(repository, options).execute();
      },
    });
  }
}
