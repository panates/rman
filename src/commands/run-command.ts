import yargs from 'yargs';
import logger from 'npmlog';
import {Task} from 'power-tasks';
import chalk from 'chalk';
import figures from 'figures';
import parseNpmScript from '@netlify/parse-npm-script';
import {Repository} from '../core/repository';
import {MultiTaskCommand} from './multi-task-command';
import {Package} from '../core/package';
import {Command} from '../core/command';
import {exec, ExecuteCommandResult, IExecutorOptions} from '../utils/exec';

export class RunCommand<TOptions extends RunCommand.Options> extends MultiTaskCommand<TOptions> {

    static commandName = 'run';

    constructor(readonly repository: Repository,
                public script: string,
                options?: TOptions) {
        super(repository, options);
    }

    protected async _preExecute(): Promise<void> {
        logger.info('run', `Executing script "${this.script}" for packages`);
    }

    protected _prepareTasks(): Task[] | Promise<Task[]> {
        const packages = this.repository.getPackages({toposort: true});
        const tasks: Task[] = [];
        for (const p of packages) {
            if (p.json.scripts) {
                const childTask = this._preparePackageTask(p);
                if (childTask) {
                    tasks.push(childTask);
                }
            }
        }
        return tasks;
    }

    protected _preparePackageTask(p: Package, ctx?: any): Task | undefined {
        let scriptInfo: any;
        try {
            scriptInfo = parseNpmScript(p.json, 'npm run ' + this.script);
            if (!(scriptInfo && scriptInfo.raw))
                return;
        } catch {
            return;
        }
        const tasks: Task[] = [];
        for (const s of scriptInfo.steps) {
            const parsed = Array.isArray(s.parsed) ? s.parsed : [s.parsed];
            for (const cmd of parsed) {
                const task = new Task(async () => {
                    return await this._exec(p, cmd, {
                        cwd: p.dirname,
                        argv: this.argv
                    }, ctx);
                });
                tasks.push(task);
            }
        }
        if (tasks.length)
            return new Task(tasks, {
                name: p.name,
                dependencies: this.options.parallel ? undefined : p.dependencies,
                bail: this.options.bail,
                concurrency: this.options.concurrency
            })
    }

    protected async _exec(pkg: Package, command: string,
                          options: IExecutorOptions,
                          ctx?: any): Promise<ExecuteCommandResult> {
        logger.verbose(this.commandName,
            pkg.name,
            chalk.gray(figures.lineVerticalDashed0),
            chalk.cyanBright.bold('executing'),
            chalk.gray(figures.lineVerticalDashed0),
            command,
        );
        const t = Date.now();
        const r = await exec(command, options);
        if (r.error) {
            logger.error(
                this.commandName,
                chalk.gray(figures.lineVerticalDashed0),
                pkg.name,
                chalk.gray(figures.lineVerticalDashed0),
                chalk.red.bold('failed'),
                chalk.gray(figures.lineVerticalDashed0),
                command,
                chalk.gray(figures.lineVerticalDashed0),
                r.error.message.trim()
            );
        } else
            logger.info(
                this.commandName,
                chalk.gray(figures.lineVerticalDashed0),
                pkg.name,
                chalk.gray(figures.lineVerticalDashed0),
                chalk.green.bold('success'),
                chalk.gray(figures.lineVerticalDashed0),
                command,
                chalk.gray(figures.lineVerticalDashed0),
                'Completed in ' + chalk.yellow('' + (Date.now() - t) + ' ms')
            );
        if (r.error)
            throw r.error;
        return r;
    }
}

export namespace RunCommand {
    export interface Options extends MultiTaskCommand.Options {
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...MultiTaskCommand.cliCommandOptions
    };

    export function initCli(repository: Repository, program: yargs.Argv) {
        program.command({
            command: 'run <script>',
            describe: 'Execute an arbitrary command in each package',
            builder: (cmd) => {
                return cmd
                    .example("$0 run build", '')
                    .positional("script", {
                        describe: "# The script to execute. Any command flags must be passed after --",
                        type: "string",
                    })
                    .option(RunCommand.cliCommandOptions);
            },
            handler: async (args) => {
                const options = Command.composeOptions(RunCommand.commandName, args, repository.config);
                const script: string = '' + args.script;
                await new RunCommand(repository, script, options).execute();
            }
        })
    }
}
