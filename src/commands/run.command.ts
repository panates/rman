import yargs from 'yargs';
import splitString from 'split-string';
import parseNpmScript from '@netlify/parse-npm-script';
import {Repository} from '../core/repository';
import {ExecuteCommand} from './execute.command';

export class RunCommand extends ExecuteCommand {

    constructor(readonly repository: Repository,
                public options: RunCommand.Options) {
        super(repository, options);
    }

    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: true});
        this.totalSteps = 0;
        for (const p of packages) {
            let scriptInfo: any;
            try {
                scriptInfo = parseNpmScript(p.json, 'npm run ' + this.options.cmd);
            } catch {
                continue;
            }
            if (!(scriptInfo && scriptInfo.raw))
                continue;
            const steps: ExecuteCommand.TaskStep[] = [];
            for (const s of scriptInfo.steps) {
                const parsed = Array.isArray(s.parsed) ? s.parsed : [s.parsed];
                for (const cwd of parsed) {
                    steps.push({
                        name: s.name,
                        cwd,
                        commandName: splitString(cwd, {quotes: true, separator: ' '})[0],
                        waitDependencies: !(s.name.startsWith('pre') || s.name.startsWith('post'))
                    })
                }
            }

            const task = new ExecuteCommand.Task();
            task.package = p;
            task.steps = steps;
            task.progress = this._multiBar &&
                this._multiBar.create(steps.length, 0, {task: p.name, details: ''});
            this._tasks.push(task);
            this.totalSteps += steps.length;
        }
    }
}

export namespace RunCommand {
    export interface Options extends ExecuteCommand.Options {
    }

    export function initCli(workspace: Repository, program: yargs.Argv) {
        program.command({
            command: 'run <script> [...args]',
            describe: 'Execute an arbitrary command in each package',
            builder: (cmd) => {
                return cmd
                    .example("$0 run build", '')
                    .example('$0 run test -- -b', '')
                    .parserConfiguration({
                        "populate--": true,
                    })
                    .positional("script", {
                        describe: "# The script to execute. Any command flags must be passed after --",
                        type: "string",
                    })
                    .positional("args", {
                        describe: "# Positional arguments to send to command",
                        type: "string",
                    })
                    .option(ExecuteCommand.cliCommandOptions);
            },
            handler: async (options) => {
                const script: string = '' + options.script;
                const argv: string[] = (options['--'] as string[]) || [];
                await new RunCommand(workspace, {
                    ...options,
                    cmd: script,
                    argv,
                    logger: options.progress === false ? console.log : undefined
                }).execute();
            }
        })
    }
}
