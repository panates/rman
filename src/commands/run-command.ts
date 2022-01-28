import path from 'path';
import yargs from 'yargs';
import logger from 'npmlog';
import splitString from 'split-string';
import parseNpmScript from '@netlify/parse-npm-script';
import {Repository} from '../core/repository';
import {MultiTaskCommand} from './multi-task-command';
import {Package} from '../core/package';

export class RunCommand<TOptions extends RunCommand.Options> extends MultiTaskCommand<TOptions> {

    static commandName = 'run';

    constructor(readonly repository: Repository,
                public script: string,
                options?: TOptions) {
        super(repository, options);
    }

    protected _readOptions(keys: string[], options?: any): void {
        super._readOptions(keys, options);
        for (const k of keys) {
            if (this.options[k] == null) {
                const o = this.repository.config.getObject('run.scripts.' + this.script);
                if (o)
                    this._options[k] = o[k];
            }
        }
    }

    protected async _preExecute(): Promise<void> {
        logger.info('run', `Executing script "${this.script}" for packages`);
    }

    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: true});
        for (const p of packages) {
            if (p.json.scripts)
                this._prepareTasksFromScripts(p);
        }
    }

    protected _addTask(pkg: Package): RunCommand.Task {
        const task = new RunCommand.Task();
        task.package = pkg;
        task.steps = [];
        this._tasks.push(task);
        return task;
    }

    protected _prepareTasksFromScripts(p: Package, pkgJson?: any): void {
        pkgJson = pkgJson || p.json;
        let scriptInfo: any;
        try {
            scriptInfo = parseNpmScript(pkgJson, 'npm run ' + this.script);
            if (!(scriptInfo && scriptInfo.raw))
                return;
        } catch {
            return;
        }
        const task = this._addTask(p);
        for (const s of scriptInfo.steps) {
            const parsed = Array.isArray(s.parsed) ? s.parsed : [s.parsed];
            for (const cmd of parsed) {
                task.steps.push({
                    name: s.name,
                    subName: path.basename(splitString(cmd, {quotes: true, separator: ' '})[0]),
                    cmd,
                    cwd: task.package.dirname,
                    waitDependencies: !(s.name.startsWith('pre') || s.name.startsWith('post'))
                })
            }
        }
    }

}

export namespace RunCommand {
    export interface Options extends MultiTaskCommand.Options {
    }

    export class Task extends MultiTaskCommand.Task {
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...MultiTaskCommand.cliCommandOptions
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
                await new RunCommand(workspace, script, options as Options).execute();
            }
        })
    }
}
