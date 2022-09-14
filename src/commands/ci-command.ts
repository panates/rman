import chalk from 'chalk';
import logger from 'npmlog';
import path from 'path';
import { Task } from 'power-tasks';
import yargs from 'yargs';
import { Command } from '../core/command.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';
import { ExecuteCommandResult } from '../utils/exec.js';
import { fsDelete, fsExists } from '../utils/file-utils.js';
import { RunCommand } from './run-command.js';

export class CleanInstallCommand extends RunCommand<CleanInstallCommand.Options> {

  static commandName = 'ci';

  constructor(readonly repository: Repository,
              options?: CleanInstallCommand.Options) {
    super(repository, 'clean_', options);
  }

  protected async _prepareTasks(packages: Package[]): Promise<Task[]> {
    const tasks = await super._prepareTasks(packages);
    const client = this.repository.config.client || 'npm';
    if (!(client === 'npm' || client === 'yargs'))
      throw new Error(`Invalid npm client "${client}"`);
    tasks.push(new Task(async () => {
          const dirname = this.repository.dirname;
          await this._fsDelete(path.join(dirname, 'node_modules'));
          await this._fsDelete(path.join(dirname, 'package-lock.json'));
          await this._fsDelete(path.join(dirname, 'yarn-lock.json'));
          logger.info(this.commandName, chalk.yellow('installing'),
              'Running ' + client + ' install');
          return super._exec({
            name: 'root',
            cwd: this.repository.dirname,
            json: {...this.repository.json},
            command: client + ' install',
            stdio: 'inherit'
          });
        }, {exclusive: true})
    );
    return tasks;
  }

  protected async _exec(args: {
    name: string;
    json: any;
    cwd: string;
    dependencies?: string[];
    command: string;
  }, ctx?: any): Promise<ExecuteCommandResult> {
    if (args.command === '#') {
      if (args.name === 'root')
        return {code: 0};
      const {cwd} = args;
      await this._fsDelete(path.join(cwd, 'node_modules'));
      await this._fsDelete(path.join(cwd, 'package-lock.json'));
      await this._fsDelete(path.join(cwd, 'yarn-lock.json'));
      return {code: 0};
    }
    return super._exec(args, ctx);
  }

  protected async _fsDelete(fileOrDir: string): Promise<void> {
    if (await fsExists(fileOrDir)) {
      logger.info(this.commandName, chalk.yellow('clean'),
          'Deleting ' + path.relative(this.repository.dirname, fileOrDir));
      await fsDelete(fileOrDir);
    }
  }

}

export namespace CleanInstallCommand {
  export interface Options extends RunCommand.Options {
  }

  export const cliCommandOptions: Record<string, yargs.Options> = {
    ...RunCommand.cliCommandOptions
  };

  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'ci [...options]',
      describe: 'Deletes all dependency modules and re-installs',
      builder: (cmd) => {
        return cmd
            .example("$0 ci", '')
            .option(CleanInstallCommand.cliCommandOptions);
      },
      handler: async (args) => {
        const options = Command.composeOptions(CleanInstallCommand.commandName, args, repository.config);
        await new CleanInstallCommand(repository, options).execute();
      }
    })
  }
}
