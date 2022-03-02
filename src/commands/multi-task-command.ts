import os from 'os';
import chalk from 'chalk';
import yargs from 'yargs';
import logger from 'npmlog';
import figures from 'figures';
import {Task} from 'power-tasks';
import {Repository} from '../core/repository';
import {Command} from '../core/command';
import {isTTY} from '../utils/constants';

const logSeparator = chalk.gray(figures.lineVerticalDashed0);

export abstract class MultiTaskCommand<TOptions extends MultiTaskCommand.Options = MultiTaskCommand.Options>
    extends Command<TOptions> {
    protected _task?: Task;

    protected constructor(readonly repository: Repository,
                          options?: TOptions) {
        super(options);
        if (this.options.ci || !isTTY)
            this.options.progress = false;
        // noinspection SuspiciousTypeOfGuard
        this.options.concurrency = typeof options?.concurrency === 'string' ?
            parseInt(options.concurrency, 10) : undefined;
        if (this.options.bail == null)
            this.options.bail = true;
    }

    protected async _execute(): Promise<any> {
        const childTasks = await this._prepareTasks();
        if (!(childTasks && childTasks.length)) {
            logger.info(this.commandName, logSeparator, 'There is no task to process');
            return;
        }
        // this.enableProgress();
        this._task = new Task(childTasks, {
            concurrency: this.options.concurrency || os.cpus().length,
            bail: this.options.bail,

        })
        await this._task.toPromise().catch(() => void (0));
    }

    protected abstract _prepareTasks(): Task[] | Promise<Task[]> | void;

}

export namespace MultiTaskCommand {

    export interface Options extends Command.GlobalOptions {
        concurrency?: number;
        parallel?: boolean;
        bail?: boolean;
        progress?: boolean;
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        'concurrency': {
            describe: '# Set processes count to parallelize tasks. (CPU count if not defined)',
            type: 'number'
        },
        'parallel': {
            describe: '# Disregards dependency checking and runs the command for every package at same time.',
            type: 'boolean'
        },
        'no-bail': {
            describe: '# Continue execution even one fails.',
            type: 'boolean'
        },
        'bail': {
            hidden: true,
            type: 'boolean'
        },
        'no-progress': {
            describe: "Disable progress bars",
            type: 'boolean',
        },
        'progress': {
            hidden: true,
            type: 'boolean',
            default: true
        }
    };

}
