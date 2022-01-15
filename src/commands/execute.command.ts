import yargs from 'yargs';
import {Repository} from '../core/repository';
import {BaseExecuteCommand} from './base-execute.command';

export class ExecuteCommand extends BaseExecuteCommand {

    commandName = 'exec';

    constructor(readonly repository: Repository,
                public options: ExecuteCommand.Options) {
        super(repository, options);
    }

    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: !this.options.parallel});
        for (const p of packages) {
            const task = new ExecuteCommand.Task();
            task.package = p;
            task.steps = [];
            task.steps.push({
                name: this.options.cmd,
                cmd: this.options.cmd,
                argv: this.options.argv,
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

    export interface Options extends BaseExecuteCommand.Options {
        cmd: string;
        argv?: string[];
    }

    export class Task extends BaseExecuteCommand.Task {
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...BaseExecuteCommand.cliCommandOptions
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
                    argv
                }).execute();
            }
        })
    }

}
