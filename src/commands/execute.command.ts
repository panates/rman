import os from 'os';
import chalk from 'chalk';
import {MultiBar, Presets, SingleBar} from 'cli-progress';
import yargs, {Options} from 'yargs';
import {Repository} from '../core/repository';
import {Package} from '../core/package';
import {Command, CommandOptions} from '../core/command';
import {execute} from '../utils/execute';

export class ExecuteCommand extends Command {
    protected _tasks: ExecuteCommand.Task[] = [];
    protected _multiBar?: MultiBar;
    protected _overallProgress?: SingleBar;

    constructor(readonly repository: Repository,
                public options: ExecuteCommand.Options) {
        super(repository, options);
        if (options.progress !== false) {
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
        const concurrency = this.options.concurrency ?? os.cpus().length;
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
                    if (step.waitDependencies) {
                        // Check if dependent task failed. If so, we can not continue this task
                        let depTask = this.options.bail && task.package.dependencies.find(
                            (dep) => this._tasks.find(
                                t => t !== task && t.package.name === dep && t.isFailed))
                        if (depTask) {
                            task.status = 'failed';
                            if (this.options.json)
                                this.log({
                                    package: task.package.name,
                                    step: step.name,
                                    cwd: step.cwd,
                                    status: task.status,
                                    message: 'Dependency failed',
                                    dependency: depTask
                                });
                            else this.log(chalk.yellow(task.package.name), chalk.red('Dependency failed'));
                            task.updateProgress(0, {details: chalk.red('Dependency failed')});
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
                    if (this.options.json)
                        this.log({
                            package: task.package.name,
                            step: step.name,
                            cwd: step.cwd,
                            status: task.status
                        });
                    else this.log(
                        chalk.yellow(task.package.name), '|',
                        chalk.yellow(step.name), '|',
                        chalk.yellowBright('executing'), '|',
                        step.cwd,
                    );
                    task.updateProgress({details: 'Executing ' + step.commandName});

                    const t = Date.now();
                    tasksRunning++;
                    void execute(step.cwd, {
                        cwd: task.package.dirname,
                        argv: this.options.argv,
                        shell: true
                    }).then(async (r) => {
                        task.result = {
                            code: r.code || 1,
                            error: r.error,
                            stdout: r.stdout,
                            stderr: r.stderr
                        }
                        task.status = 'idle';
                        if (this.options.json)
                            this.log({
                                package: task.package.name,
                                step: step.name,
                                cwd: step.cwd,
                                status: r.error ? 'failed' : 'success',
                                duration: Date.now() - t,
                                ...task.result
                            });
                        else this.log(
                            chalk.yellow(task.package.name), '|',
                            chalk.yellow(step.name), '|',
                            (r.error ? chalk.red('failed') : chalk.green('done')), '|',
                            chalk.yellow(Date.now() - t + ' ms'), '|',
                            (r.stdout ? '\n' + '  ' + r.stdout.trim().replace(/\n/g, '\n  ') : '') +
                            (r.stderr ? '\n' + '  ' + r.stderr.trim().replace(/\n/g, '\n  ') : '')
                        );
                        if (r.error) {
                            task.status = 'failed';
                            task.updateProgress({
                                details: chalk.yellow(step.commandName) + chalk.red(' Filed!')
                            });
                            if (this.options.json)
                                this.log({
                                    package: task.package.name,
                                    status: 'failed'
                                });
                            else this.log(chalk.yellow(task.package.name), chalk.red('failed'));
                        } else {
                            task.currentIdx++;
                            if (task.progress)
                                task.progress.increment(1);
                            if (this._overallProgress)
                                this._overallProgress.increment(1);
                            if (!task.currentStep) {
                                task.status = 'success';
                                if (this.options.json)
                                    this.log({
                                        package: task.package.name,
                                        status: 'success'
                                    });
                                else this.log(chalk.yellow(task.package.name), chalk.greenBright('Completed successfully'));
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
        })
    }

    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: !this.options.parallel});
        for (const p of packages) {
            const task = new ExecuteCommand.Task();
            task.package = p;
            task.steps = [];
            task.steps.push({
                name: this.options.cmd,
                cwd: this.options.cmd,
                commandName: this.options.cmd,
                waitDependencies: !this.options.parallel
            })
            task.progress = this._multiBar &&
                this._multiBar.create(task.steps.length, 0, {task: p.name, details: ''});
            this._tasks.push(task);
        }
    }
}

export namespace ExecuteCommand {

    export interface Options extends CommandOptions {
        cmd: string;
        argv?: string[];
        json?: boolean;
        concurrency?: number;
        parallel?: boolean;
        progress?: boolean;
        bail?: boolean;
    }

    export class Task {
        status: 'idle' | 'running' | 'success' | 'failed' = 'idle'
        package!: Package;
        steps!: TaskStep[];
        progress?: SingleBar;
        currentIdx = 0;
        result?: {
            code: number;
            error?: unknown;
            stdout?: string;
            stderr?: string;
        }

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
        cwd: string;
        commandName: string;
        waitDependencies: boolean;
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        'json': {
            describe: '# Stream output as json'
        },
        'concurrency': {
            describe: '# Set processes count to parallelize tasks. (CPU count if not defined)',
            type: 'number'
        },
        'parallel': {
            describe: '# Disregards dependency checking and runs the command for every package at same time.'
        },
        'no-bail': {
            describe: '# Runs script for all packages even one fails.'
        },
        'bail': {
            // proxy for --no-bail
            hidden: true,
            type: "boolean",
        }
    };

    export function initCli(repository: Repository, program: yargs.Argv) {
        program.command({
            command: 'exec <cmd> [...args]',
            describe: 'Execute an arbitrary command in each package',
            builder: (cmd) => {
                return cmd
                    .example("$0 exec -- ls", '')
                    .example('$0 exec -- rm -rf ./node_modules', '')
                    .parserConfiguration({
                        "populate--": true,
                    })
                    .positional("cmd", {
                        describe: "The command to execute. Any command flags must be passed after --",
                        type: "string",
                    })
                    .positional("args", {
                        describe: "Positional arguments to send to command",
                        type: "string",
                    })
                    .option(cliCommandOptions);
            },
            handler: async (options) => {
                const cmd: string = '' + options.cmd;
                const argv: string[] = (options['--'] as string[]) || [];
                await new ExecuteCommand(repository, {
                    ...options,
                    cmd,
                    argv,
                    logger: options.progress === false ? console.log : undefined
                }).execute();
            }
        })
    }

}
