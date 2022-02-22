import yargs from 'yargs';
import logger from 'npmlog';
import chalk from 'chalk';
import figures from 'figures';
import {Repository} from '../core/repository';
import {MultiTaskCommand} from './multi-task-command';
import {Task} from 'power-tasks';
import {exec} from '../utils/exec';
import {Command} from '../core/command';

export class ExecuteCommand extends MultiTaskCommand<ExecuteCommand.Options> {

    static commandName = 'exec';

    constructor(readonly repository: Repository,
                public cmd: string,
                public argv?: string[],
                options?: ExecuteCommand.Options) {
        super(repository, options);
    }

    protected _prepareTasks(): Task[] {
        const packages = this.repository.getPackages({toposort: !this.options.parallel});
        const tasks: Task[] = [];
        for (const p of packages) {
            const task = new Task(async () => {
                const t = Date.now();
                logger.verbose(this.commandName,
                    p.name,
                    chalk.gray(figures.lineVerticalDashed0),
                    chalk.cyanBright.bold('executing'),
                    chalk.gray(figures.lineVerticalDashed0),
                    this.cmd + ' ' + (this.argv?.join(' ') || ''),
                );
                const r = await exec(this.cmd, {
                    cwd: p.dirname,
                    argv: this.argv
                });
                logger.log((r.error ? 'error' : 'verbose'),
                    this.commandName,
                    chalk.gray(figures.lineVerticalDashed0),
                    p.name,
                    chalk.gray(figures.lineVerticalDashed0),
                    (r.error ? chalk.red.bold('failed') : chalk.green.bold('success')),
                    chalk.gray(figures.lineVerticalDashed0),
                    'Completed in ' + chalk.yellow('' + (Date.now() - t) + ' ms')
                );
            }, {
                name: p.name,
                dependencies: this.options.parallel ? undefined : p.dependencies,
                bail: this.options.bail,
                concurrency: this.options.concurrency
            });
            tasks.push(task);
        }
        return tasks;
    }
}

export namespace ExecuteCommand {

    export interface Options extends MultiTaskCommand.Options {
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...MultiTaskCommand.cliCommandOptions
    };

    export function initCli(repository: Repository, program: yargs.Argv) {
        program.command({
            command: 'exec [cmd] [args..]',
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
            handler: async (args) => {
                const argv: string[] = (args['--'] as string[]) || [];
                const options = Command.composeOptions(ExecuteCommand.commandName, args, repository.config);
                await new ExecuteCommand(repository,
                    '' + argv.shift(),
                    argv,
                    options
                ).execute();
            }
        })
    }

}
