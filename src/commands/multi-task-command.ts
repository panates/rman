import os from 'os';
import { Task } from 'power-tasks';
import { toNumber } from 'putil-varhelpers';
import * as yargs from 'yargs';
import { Command } from '../core/command.js';
import { isTTY } from '../core/constants.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';

export abstract class MultiTaskCommand<
  TOptions extends MultiTaskCommand.Options = MultiTaskCommand.Options,
> extends Command<TOptions> {
  protected _task?: Task;

  protected constructor(
    readonly repository: Repository,
    options?: TOptions,
  ) {
    super(options);
    if (this.options.ci || !isTTY) this.options.progress = false;
    // noinspection SuspiciousTypeOfGuard
    this.options.concurrency = toNumber(options?.concurrency);
    if (this.options.bail == null) this.options.bail = true;
  }

  protected async _execute(): Promise<any> {
    const packages = await this._getPackages();
    const childTasks = await this._prepareTasks(packages);
    if (!(childTasks && childTasks.length)) {
      return;
    }
    // this.enableProgress();
    this._task = new Task(childTasks, {
      name: '$project-root',
      concurrency: this.options.concurrency || os.cpus().length,
      bail: this.options.bail,
    });
    await this._task.toPromise();
  }

  protected async _getPackages(): Promise<Package[]> {
    return this.repository.getPackages({ toposort: !this.options.parallel });
  }

  protected abstract _prepareTasks(packages: Package[]): Task[] | Promise<Task[]> | void;
}

export namespace MultiTaskCommand {
  export interface Options extends Command.GlobalOptions {
    concurrency?: number;
    parallel?: boolean;
    bail?: boolean;
    progress?: boolean;
  }

  export const cliCommandOptions: Record<string, yargs.Options> = {
    concurrency: {
      describe: '# Set processes count to parallelize tasks. (CPU count if not defined)',
      type: 'number',
    },
    parallel: {
      describe: '# Disregards dependency checking and runs the command for every package at same time.',
      type: 'boolean',
    },
    'no-bail': {
      describe: '# Continue execution even one fails.',
      type: 'boolean',
    },
    bail: {
      hidden: true,
      type: 'boolean',
    },
    'no-progress': {
      describe: 'Disable progress bars',
      type: 'boolean',
    },
    progress: {
      hidden: true,
      type: 'boolean',
      default: true,
    },
  };
}
