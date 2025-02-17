import colors from 'ansi-colors';
import logger from 'npmlog';
import { Task } from 'power-tasks';
import * as yargs from 'yargs';
import { Command } from '../core/command.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';
import { exec } from '../utils/exec.js';
import { MultiTaskCommand } from './multi-task-command.js';

export class ExecuteCommand extends MultiTaskCommand<ExecuteCommand.Options> {
  static commandName = 'exec';

  constructor(
    readonly repository: Repository,
    public cmd: string,
    public argv?: string[],
    options?: ExecuteCommand.Options,
  ) {
    super(repository, options);
  }

  protected _prepareTasks(packages: Package[]): Task[] {
    const tasks: Task[] = [];
    for (const p of packages) {
      const task = new Task(
        async () => {
          const t = Date.now();
          logger.verbose(
            this.commandName,
            p.name,
            colors.cyanBright.bold('executing'),
            logger.separator,
            this.cmd + ' ' + (this.argv?.join(' ') || ''),
          );
          const r = await exec(this.cmd, {
            cwd: p.dirname,
            argv: this.argv,
            stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe',
          });
          logger.log(
            r.error ? 'error' : 'info',
            this.commandName,
            p.name,
            r.error ? colors.red.bold('failed') : colors.green.bold('success'),
            logger.separator,
            this.cmd,
            colors.yellow(' (' + (Date.now() - t) + ' ms') + ')',
          );
        },
        {
          name: p.name,
          dependencies: this.options.parallel ? undefined : p.dependencies,
          bail: this.options.bail,
          concurrency: this.options.concurrency,
        },
      );
      tasks.push(task);
    }
    return tasks;
  }
}

export namespace ExecuteCommand {
  export interface Options extends MultiTaskCommand.Options {}

  export const cliCommandOptions: Record<string, yargs.Options> = {
    ...MultiTaskCommand.cliCommandOptions,
  };

  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'exec [cmd] [args..]',
      describe: 'Execute an arbitrary command in each package',
      builder: cmd =>
        cmd
          .example('$0 exec -- ls', '')
          .example('$0 exec -- rm -rf ./node_modules', '')
          .parserConfiguration({
            'populate--': true,
          })
          .positional('cmd', {
            describe: 'The command to execute. Any command flags must be passed after --',
            type: 'string',
          })
          .positional('args', {
            describe: 'Positional arguments to send to command',
            type: 'string',
          })
          .option(cliCommandOptions),
      handler: async args => {
        const argv: string[] = (args['--'] as string[]) || [];
        const options = Command.composeOptions(ExecuteCommand.commandName, args, repository.config);
        await new ExecuteCommand(repository, '' + argv.shift(), argv, options).execute();
      },
    });
  }
}
