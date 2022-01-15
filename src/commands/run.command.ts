import yargs from 'yargs';
import splitString from 'split-string';
import parseNpmScript from '@netlify/parse-npm-script';
import {Repository} from '../core/repository';
import {BaseExecuteCommand} from './base-execute.command';

export class RunCommand extends BaseExecuteCommand {

    commandName = 'run';

    constructor(readonly repository: Repository,
                public options: RunCommand.Options) {
        super(repository, options);
    }

    getOption(name: string): any {
        const v = super.getOption(name);
        if (v == null) {
            const o = this.repository.config.scripts[this.options.script];
            if (o && typeof o === 'object')
                return o[name];
        }
    }


    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: true});
        this.totalSteps = 0;
        for (const p of packages) {
            let scriptInfo: any;
            try {
                scriptInfo = parseNpmScript(p.json, 'npm run ' + this.options.script);
            } catch {
                continue;
            }
            if (!(scriptInfo && scriptInfo.raw))
                continue;
            const task = new RunCommand.Task();
            task.package = p;
            task.steps = [];
            for (const s of scriptInfo.steps) {
                const parsed = Array.isArray(s.parsed) ? s.parsed : [s.parsed];
                for (const cwd of parsed) {
                    task.steps.push({
                        name: s.name,
                        cmd: cwd,
                        commandName: splitString(cwd, {quotes: true, separator: ' '})[0],
                        waitDependencies: !(s.name.startsWith('pre') || s.name.startsWith('post'))
                    })
                }
            }
            task.progress = this._multiBar &&
                this._multiBar.create(task.steps.length, 0, {task: p.name, details: ''});
            this._tasks.push(task);
            this.totalSteps += task.steps.length;
        }
    }
}

export namespace RunCommand {
    export interface Options extends BaseExecuteCommand.Options {
        script: string;
    }

    export class Task extends BaseExecuteCommand.Task {
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...BaseExecuteCommand.cliCommandOptions
    };

    export function initCli(workspace: Repository, program: yargs.Argv) {
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
            handler: async (options) => {
                const script: string = '' + options.script;
                await new RunCommand(workspace, {...options, script}).execute();
            }
        })
    }
}
