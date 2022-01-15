import os from 'os';
import chalk from 'chalk';
import {MultiBar, Presets, SingleBar} from 'cli-progress';
import yargs from 'yargs';
import {Repository} from '../core/repository';
import {Package} from '../core/package';
import {Command} from '../core/command';
import {execute} from '../utils/execute';
import logger from '../core/logger';

export abstract class BaseExecuteCommand extends Command {
    protected _tasks: BaseExecuteCommand.Task[] = [];
    protected _multiBar?: MultiBar;
    protected _overallProgress?: SingleBar;

    protected constructor(readonly repository: Repository,
                          public options: BaseExecuteCommand.Options) {
        super(repository);
        const noProgress = this.getOption('noProgress');

        if (!noProgress) {
            this._multiBar = new MultiBar({
                format: '[' + chalk.cyan('{bar}') + '] {percentage}% | {value}/{total} | ' +
                    chalk.yellowBright('{task}') + ' | ' + chalk.yellow('{details}'),
                barsize: 30,
                hideCursor: true,
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
            }, Presets.rect);
            this._overallProgress = this._multiBar.create(1, 0);
        }
        this._prepareTasks();
        if (this._overallProgress) {
            const totalSteps = this._tasks.reduce(
                (n, t) => n + t.steps.length, 0);
            this._overallProgress.start(totalSteps, 0, {task: '=== OVERALL ===', details: ''});
        }
    }

    protected async _execute(): Promise<any> {
        let concurrency = parseInt(this.getOption('concurrency'), 10);
        if (!(concurrency >= 0)) concurrency = os.cpus().length;
        const noProgress = this.getOption('noProgress');
        const parallel = this.getOption('parallel');
        const noBail = this.getOption('noBail');
        const printJson = this.getOption('json');

        if (!noProgress)
            logger.retain();
        return new Promise<void>((resolve, reject) => {
            let taskIdx = 0;
            let tasksRunning = 0;
            const next = () => {
                // Check all tasks are finished
                if (!this._tasks.find(t => !t.isFinished)) {
                    this._multiBar?.stop();
                    const i = this._tasks.reduce((n, t) =>
                        t.isFailed ? n + 1 : n, 0);
                    if (i)
                        return reject(new Error(i === 1 ? '1 task' : `${i} tasks`) + ' failed');
                    return resolve();
                }

                for (let i = taskIdx; i < this._tasks.length; i++) {
                    taskIdx = i;
                    const task = this._tasks[i];
                    const step = task.currentStep;
                    if (!step || task.isRunning)
                        continue;
                    if (!parallel && step.waitDependencies) {
                        // Check if dependent task failed. If so, we can not continue this task
                        let depTask = !noBail && task.package.dependencies.find(
                            (dep) => this._tasks.find(
                                t => t !== task && t.package.name === dep && t.isFailed))
                        if (depTask) {
                            task.status = 'failed';
                            if (noProgress) {
                                if (printJson)
                                    logger.error({
                                        package: task.package.name,
                                        step: step.name,
                                        cwd: step.cmd,
                                        status: task.status,
                                        message: 'Dependency failed',
                                        dependency: depTask
                                    });
                                else logger.error(
                                    'Package:', chalk.yellow(task.package.name),
                                    '| Status:', chalk.red('Dependency failed'));
                            }
                            task.updateProgress(0, {details: chalk.red('Dependency failed')});
                            if (i === this._tasks.length - 1)
                                setTimeout(next, 1);
                            continue;
                        }
                        // Check if dependent task is already running. If so, we need to wait
                        depTask = task.package.dependencies.find(
                            (dep) => this._tasks.find(t => t !== task && t.package.name === dep && t.isRunning))
                        if (depTask) {
                            task.updateProgress({
                                details: chalk.bgYellow.white('Waiting for dependency')
                            });
                            continue;
                        }
                    }
                    task.status = 'running';
                    if (printJson)
                        logger.trace({
                            package: task.package.name,
                            step: step.name,
                            cwd: step.cmd,
                            status: task.status
                        });
                    else logger.trace(
                        'Package:', chalk.yellow(task.package.name),
                        '| Step:', chalk.yellow(step.name),
                        '| Status:', chalk.yellowBright('executing'),
                        '|', step.cmd,
                    );
                    task.updateProgress({details: 'Executing ' + step.commandName});

                    const t = Date.now();
                    tasksRunning++;
                    void execute(step.cmd, {
                        cwd: task.cwd || task.package.dirname,
                        argv: step.argv || [],
                        shell: true
                    }).then(async (r) => {
                        task.status = 'idle';
                        step.result = {
                            code: r.code == null ? 1 : r.code,
                            error: r.error,
                            stdout: r.stdout,
                            stderr: r.stderr
                        }
                        if (printJson)
                            logger.log((r.error ? 'error' : 'info'), {
                                package: task.package.name,
                                ...step,
                                status: r.error ? 'failed' : 'success',
                                duration: Date.now() - t
                            });
                        else {
                            logger.log((r.error ? 'error' : 'info'),
                                'Package:', chalk.yellow(task.package.name),
                                '| Step:', chalk.yellow(step.name),
                                '| Status: ', (r.error ? chalk.red('failed') : chalk.green('done')),
                                '| Time: ', chalk.yellow(Date.now() - t + ' ms'), '|',
                                (r.stdout ? '\n' + '  ' + r.stdout.trim().replace(/\n/g, '\n  ') : '') +
                                (r.stderr ? '\n' + '  ' + r.stderr.trim().replace(/\n/g, '\n  ') : '')
                            );
                        }
                        if (r.error) {
                            task.status = 'failed';
                            task.updateProgress({
                                details: chalk.yellow(step.commandName) + chalk.red(' Filed!')
                            });
                            if (noProgress) {
                                if (printJson)
                                    logger.error({
                                        package: task.package.name,
                                        status: 'failed'
                                    });
                                else
                                    logger.error(
                                        'Package:', chalk.yellow(task.package.name),
                                        '| Status', chalk.red('failed'));
                            }
                        } else {
                            task.currentIdx++;
                            if (task.progress)
                                task.progress.increment(1);
                            if (this._overallProgress)
                                this._overallProgress.increment(1);
                            if (!task.currentStep) {
                                task.status = 'success';
                                if (noProgress) {
                                    if (printJson)
                                        logger.info({
                                            package: task.package.name,
                                            status: 'success'
                                        });
                                    else
                                        logger.info(
                                            'Package:', chalk.yellow(task.package.name),
                                            '| Status:', chalk.greenBright('Completed successfully'));
                                }
                                task.updateProgress({details: chalk.greenBright('Success')});
                            }
                        }
                        setTimeout(next, 1);
                    }).finally(() => tasksRunning--);
                    if (concurrency > 0 && tasksRunning >= concurrency)
                        break;
                }

                taskIdx = 0;
            }
            next();
        }).finally(() => {
            logger.release();
        })
    }

    protected abstract _prepareTasks(): void;
}

export namespace BaseExecuteCommand {

    export interface Options {
        json?: boolean;
        concurrency?: number;
        parallel?: boolean;
        noProgress?: boolean;
        noBail?: boolean;
    }

    export class Task {
        status: 'idle' | 'running' | 'success' | 'failed' = 'idle'
        package!: Package;
        cwd?: string;
        steps!: TaskStep[];
        progress?: SingleBar;
        currentIdx = 0;

        get currentStep(): TaskStep | undefined {
            return (this.isIdle || this.isRunning) ? this.steps[this.currentIdx] : undefined;
        }

        get isFinished(): boolean {
            return this.status === 'success' || this.status === 'failed';
        }

        get isRunning(): boolean {
            return this.status === 'running';
        }

        get isIdle(): boolean {
            return this.status === 'idle';
        }

        get isFailed(): boolean {
            return this.status === 'failed';
        }

        updateProgress(payload: object): void;
        updateProgress(current: number, payload?: object): void;
        updateProgress(...args: any): void {
            if (this.progress) { // @ts-ignore
                // eslint-disable-next-line
                this.progress.update(...args);
            }
        }
    }

    export interface TaskStep {
        name: string;
        cmd: string;
        argv?: string[];
        commandName: string;
        waitDependencies: boolean;
        result?: {
            code: number;
            error?: unknown;
            stdout?: string;
            stderr?: string;
        }
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        'json': {
            describe: '# Stream output as json',
            type: 'boolean'
        },
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
        'no-progress': {
            describe: '# Disables progress bars',
            type: 'boolean'
        }
    };

}
