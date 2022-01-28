import path from 'path';
import yargs from 'yargs';
import {Repository} from '../core/repository';
import {MultiTaskCommand} from './multi-task-command';

export class ExecuteCommand extends MultiTaskCommand<ExecuteCommand.Options> {

    static commandName = 'exec';

    constructor(readonly repository: Repository,
                public cmd: string,
                public argv?: string[],
                options?: ExecuteCommand.Options) {
        super(repository, options);
    }

    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: !this.options.parallel});
        for (const p of packages) {
            const task = new ExecuteCommand.Task();
            task.package = p;
            task.steps = [];
            task.steps.push({
                name: path.basename(this.cmd),
                subName: '',
                cmd: this.cmd,
                cwd: p.dirname,
                argv: this.argv,
                waitDependencies: !this.options.parallel
            })
            this._tasks.push(task);
        }
    }
}

export namespace ExecuteCommand {

    export interface Options extends MultiTaskCommand.Options {
    }

    export class Task extends MultiTaskCommand.Task {
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
            handler: async (options) => {
                const argv: string[] = (options['--'] as string[]) || [];
                await new ExecuteCommand(repository,
                    '' + argv.shift(), argv, options as Options).execute();
            }
        })
    }

}
