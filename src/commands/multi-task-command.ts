import os from 'os';
import chalk from 'chalk';
import yargs from 'yargs';
import logger from 'npmlog';
import figures from 'figures';
import {Repository} from '../core/repository';
import {Package} from '../core/package';
import {Command, CommandOptions} from '../core/command';
import {execute, ExecuteCommandResult} from '../utils/execute';
import {DOTS} from '../utils/constants';

export abstract class MultiTaskCommand<TOptions extends MultiTaskCommand.Options = MultiTaskCommand.Options,
    TTask extends MultiTaskCommand.Task = MultiTaskCommand.Task>
    extends Command<TOptions> {
    protected _tasks: TTask[] = [];
    totalSteps = 0;

    protected constructor(readonly repository: Repository,
                          options?: TOptions) {
        super(repository, options);
    }

    protected _readOptions(keys: string[], options?: any) {
        super._readOptions([...keys, 'concurrency', 'parallel', 'bail'], options);
        // @ts-ignore
        this.options.concurrency = parseInt(this.options.concurrency, 10);
        if (this.options.bail == null)
            this.options.bail = true;
    }

    protected _statistics(): MultiTaskCommand.Statistics {
        const result: MultiTaskCommand.Statistics = {
            total: this._tasks.length,
            finished: 0,
            running: 0,
            failed: 0,
            success: 0,
            idle: 0
        }
        for (const t of this._tasks) {
            if (t.isIdle) result.idle++;
            if (t.isFinished) result.finished++;
            if (t.isRunning) result.running++;
            if (t.isFailed) result.failed++;
            if (t.isSuccess) result.success++;
        }
        return result;
    }

    protected _drawProgress(): string {
        let output = '';
        for (const task of this._tasks) {
            const data = task.progressData;
            let line = '';
            switch (task.status) {

                case 'running':
                    data.dotIndex = data.dotIndex || 0;
                    data.dotIndex++;
                    if (data.dotIndex >= DOTS.length)
                        data.dotIndex = 0;
                    line += chalk.cyanBright(DOTS[data.dotIndex]) +
                        ' ' + chalk.cyanBright(task.package.name);
                    if (task.currentStep) {
                        line += ' ' + chalk.green(figures.play) +
                            ' ' + chalk.yellow(task.currentStep.name);
                        if (task.currentStep.subName)
                            line += ' ' + chalk.green(figures.play) +
                                ' ' + chalk.yellow(task.currentStep.subName)
                    }
                    break;

                case 'success':
                    line += chalk.greenBright(figures.tick) +
                        ' ' + chalk.green(task.package.name);
                    break;

                case 'failed':
                    line += chalk.redBright(figures.cross) +
                        ' ' + chalk.red(task.package.name);
                    break;

                default:
                    line += chalk.gray(figures.circle) +
                        ' ' + chalk.white(task.package.name);
            }

            if (task.statusText) {
                line += ' ' + chalk.yellowBright(figures.circleDotted) +
                    ' ' + task.statusText;
            }

            output += line.substring(0, (process.stdout.columns || 80) - 1) + '\n';
        }
        return output;
    }

    protected async _execute(): Promise<any> {
        // @ts-ignore
        let concurrency = parseInt(this.options.concurrency, 10);
        if (!(concurrency >= 0)) concurrency = os.cpus().length;

        await this._prepareTasks();
        this.totalSteps = this._tasks.reduce((x, task) => x + task.steps.length, 0);
        if (!this.totalSteps)
            logger.info(this.commandName,
                chalk.gray(figures.lineVerticalDashed0),
                'There is no task to process');
        else
            logger.info(this.commandName,
                chalk.gray(figures.lineVerticalDashed0),
                'Processing ' +
                chalk.cyanBright(this.totalSteps) + ' commands from ' +
                chalk.cyanBright(this._tasks.length) + ' packages');
        if (this.options.progress) {
            logger.pause();
            this.enableProgress();
        }

        return new Promise<void>((resolve, reject) => {
            let taskIdx = 0;
            let tasksRunning = 0;
            let resolved = false;
            const next = () => {
                if (resolved)
                    return;
                // Check all tasks are finished
                if (!this._tasks.find(t => !t.isFinished)) {
                    resolved = true;
                    const stat = this._statistics();
                    if (stat.failed)
                        return reject(new Error((stat.failed === 1 ? '1 task' : `${stat.failed} tasks`) + ' failed'));
                    return resolve();
                }

                for (let i = taskIdx; i < this._tasks.length; i++) {
                    taskIdx = i;
                    const task = this._tasks[i];
                    const step = task.currentStep;
                    if (!step || task.isRunning)
                        continue;
                    const logPkgName = chalk.yellow(task.package.name);
                    const logStepName = chalk.magenta(step.name);
                    const logSubName = step.subName ? chalk.magenta(step.subName) : '';
                    if (!this.options.parallel && step.waitDependencies) {
                        // Check if dependent task failed. If so, we can not continue this task
                        let depTask = this.options.bail && task.package.dependencies.find(
                            (dep) => this._tasks.find(
                                t => t !== task && t.package.name === dep && t.isFailed))
                        if (depTask) {
                            task.status = 'failed';
                            task.statusText = 'Dependent package failed';
                            this._taskStatusChange(task);

                            if (this.options.json)
                                logger.output('', '%j', {
                                    package: task.package.name,
                                    status: task.status,
                                    message: task.statusText,
                                    dependency: depTask
                                });
                            else logger.error(this.commandName, logPkgName,
                                chalk.gray(figures.lineVerticalDashed0),
                                chalk.red(task.status),
                                chalk.gray(figures.lineVerticalDashed0),
                                task.statusText);

                            if (i === this._tasks.length - 1)
                                setTimeout(next, 1);
                            continue;
                        }
                        // Check if dependent task is already running. If so, we need to wait
                        depTask = task.package.dependencies.find(
                            (dep) => this._tasks.find(t => t !== task && t.package.name === dep && t.isRunning))
                        if (depTask) {
                            task.statusText = 'Waiting dependencies';
                            continue;
                        }
                    }

                    const processResult = async (r: ExecuteCommandResult) => {
                        step.result = this._onStepResult(task, step, {
                            code: r.code == null ? 1 : r.code,
                            error: r.error,
                            stdout: r.stdout,
                            stderr: r.stderr
                        });
                        if (this.options.json)
                            logger.output('', '%j', {
                                package: task.package.name,
                                ...step,
                                status: r.error ? 'failed' : 'success',
                                duration: Date.now() - t
                            });
                        else {
                            logger.log((r.error ? 'error' : 'verbose'),
                                this.commandName,
                                chalk.gray(figures.lineVerticalDashed0),
                                logPkgName + ':' + logStepName + (logSubName ? ':' + logSubName : ''),
                                chalk.gray(figures.lineVerticalDashed0),
                                (r.error ? chalk.red.bold('failed') : chalk.green.bold('success')),
                                chalk.gray(figures.lineVerticalDashed0),
                                'Completed in ' + chalk.yellow('' + (Date.now() - t) + ' ms')
                            );
                            const content: string[] = [];
                            if (r.stdout)
                                content.push(r.stdout.trim());
                            if (r.error)
                                content.push(chalk.red(('' + r.error).trim()));
                            if (r.stderr)
                                content.push(chalk.red(r.stderr.trim()));
                            if (content.length)
                                logger.silly(this.commandName, content.join('\n'));
                        }
                        if (r.error) {
                            task.status = 'failed';
                            task.statusText = (r.error.message || '' + r.error);
                            this._taskStatusChange(task);
                            if (this.options.json)
                                logger.output('', '%j', {
                                    package: task.package.name,
                                    status: 'failed'
                                });
                            else
                                logger.error(this.commandName, logPkgName,
                                    chalk.gray(figures.lineVerticalDashed0),
                                    chalk.red.bold('failed'),
                                    chalk.gray(figures.lineVerticalDashed0),
                                    'Task failed');
                        } else {
                            task.stepIndex++;
                            if (task.currentStep) {
                                task.status = 'idle';
                                task.statusText = '';
                                this._taskStatusChange(task);
                            } else {
                                task.status = 'success';
                                task.statusText = step.resultMessage || '';
                                this._taskStatusChange(task);
                                if (this.options.json)
                                    logger.output('', '%j', {
                                        package: task.package.name,
                                        status: 'success'
                                    });
                                else
                                    logger.info(this.commandName, logPkgName,
                                        chalk.gray(figures.lineVerticalDashed0),
                                        chalk.green.bold('success'),
                                        chalk.gray(figures.lineVerticalDashed0),
                                        (task.statusText || 'Task completed successfully'));
                            }
                        }
                        setTimeout(next, 1);
                    }

                    task.status = 'running';
                    task.statusText = '';
                    this._taskStatusChange(task);
                    tasksRunning++;

                    if (this.options.json)
                        logger.output('', '%j', {
                            package: task.package.name,
                            step: step.name,
                            cmd: typeof step.cmd === 'string' ? step.cmd : undefined,
                            cwd: step.cwd,
                            argv: step.argv,
                            status: task.status
                        });
                    else logger.verbose(this.commandName,
                        logPkgName + ':' + logStepName + (logSubName ? ':' + logSubName : ''),
                        chalk.gray(figures.lineVerticalDashed0),
                        chalk.cyanBright.bold('executing'),
                        chalk.gray(figures.lineVerticalDashed0),
                        typeof step.cmd === 'string' ? step.cmd : '',
                    );

                    const t = Date.now();
                    this._executeStep(task, step)
                        .then(processResult)
                        .catch(error => processResult({
                            code: 1,
                            error
                        }))
                        .finally(() => tasksRunning--);

                    if (concurrency > 0 && tasksRunning >= concurrency)
                        break;
                }

                taskIdx = 0;
            }
            next();
        })
    }

    protected async _executeStep(task: TTask, step: MultiTaskCommand.TaskStep): Promise<ExecuteCommandResult> {
        if (typeof step.cmd === 'function') {
            return step.cmd(task, step)
        } else
            return execute(step.cmd, {
                cwd: step.cwd,
                argv: step.argv || []
            });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected _taskStatusChange(task: TTask): void {
        //
    }

    protected abstract _prepareTasks(): Promise<void> | void;

    protected _onStepResult(task: TTask,
                            step: MultiTaskCommand.TaskStep,
                            stepResult: MultiTaskCommand.TaskStepResult
    ): MultiTaskCommand.TaskStepResult {
        if (stepResult.code === 'ENOENT') {
            // stepResult.error = 'ENOENT: No such file or directory "';
        }
        return stepResult;
    }
}

export namespace MultiTaskCommand {

    export interface Options extends CommandOptions {
        concurrency?: number;
        parallel?: boolean;
        bail?: boolean;
    }

    export type TaskStatus = 'idle' | 'running' | 'success' | 'failed';

    export class Task {
        status: TaskStatus = 'idle'
        package!: Package;
        steps!: TaskStep[];
        stepIndex = 0;
        statusText = '';
        progressData: any = {};

        get currentStep(): TaskStep | undefined {
            return (this.isIdle || this.isRunning) ? this.steps[this.stepIndex] : undefined;
        }

        get isFinished(): boolean {
            return !this.steps.length || this.status === 'success' || this.status === 'failed';
        }

        get isSuccess(): boolean {
            return this.status === 'success';
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

    }

    export interface TaskStep {
        name: string;
        subName: string;
        cmd: string | ((task: Task, step: TaskStep) => ExecuteCommandResult | Promise<ExecuteCommandResult>);
        cwd: string;
        argv?: string[];
        waitDependencies: boolean;
        resultMessage?: string;
        result?: TaskStepResult;
    }

    export interface TaskStepResult {
        code: number | string;
        error?: any;
        stdout?: string;
        stderr?: string;
    }

    export interface Statistics {
        total: number;
        finished: number;
        running: number;
        failed: number;
        success: number;
        idle: number;
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
        }
    };

}
