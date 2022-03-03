import yargs from 'yargs';
import logger from 'npmlog';
import {Task} from 'power-tasks';
import chalk from 'chalk';
import parseNpmScript from '@netlify/parse-npm-script';
import {Repository} from '../core/repository';
import {MultiTaskCommand} from './multi-task-command';
import {Command} from '../core/command';
import {exec, ExecuteCommandResult} from '../utils/exec';
import {Package} from '../core/package';

export class RunCommand<TOptions extends RunCommand.Options> extends MultiTaskCommand<TOptions> {

    static commandName = 'run';

    constructor(readonly repository: Repository,
                public script: string,
                options?: TOptions) {
        super(repository, options);
    }

    protected _prepareTasks(packages: Package[], options?: any): Task[] | Promise<Task[]> {
        const packageTasks: Task[] = [];
        for (const p of packages) {
            if (p.json.scripts) {
                const childTask = this._prepareScriptTask({
                    name: p.name,
                    dirname: p.dirname,
                    json: p.json,
                    dependencies: p.dependencies
                }, options);
                if (childTask) {
                    packageTasks.push(childTask);
                }
            }
        }
        const mainTask = this._prepareScriptTask({
            name: 'root',
            dirname: this.repository.dirname,
            json: this.repository.json
        });
        if (!mainTask?.children)
            return packageTasks;
        const tasks: Task[] = [];
        const pre = mainTask.children.filter((t => t.name.endsWith(':pre' + this.script)));
        const post = mainTask.children.filter((t => t.name.endsWith(':post' + this.script)));
        pre.forEach(t => t.options.exclusive = true);
        post.forEach(t => t.options.exclusive = true);
        tasks.push(...pre);
        tasks.push(...packageTasks);
        tasks.push(...post);
        return tasks;
    }

    protected _prepareScriptTask(args: {
        name: string;
        json: any;
        dirname: string;
        dependencies?: string[];
    }, ctx?: any): Task | undefined {
        const json = {...args.json};
        json.scripts = json.scripts || {};
        json.scripts[this.script] = json.scripts[this.script] || '#';

        let scriptInfo: any;
        try {
            scriptInfo = parseNpmScript(json, 'npm run ' + this.script);
            if (!(scriptInfo && scriptInfo.raw))
                return;
        } catch {
            return;
        }
        const children: Task[] = [];
        for (const s of scriptInfo.steps) {
            const parsed = Array.isArray(s.parsed) ? s.parsed : [s.parsed];
            for (const cmd of parsed) {
                const task = new Task(async () => {
                    return await this._exec({
                        ...args,
                        command: cmd,
                        stdio: logger.levelIndex <= 1000 ? 'inherit' : 'pipe'
                    }, ctx);
                }, {
                    name: args.name + ':' + s.name,
                    dependencies: s.name.startsWith('pre') || s.name.startsWith('post') ?
                        undefined : args.dependencies
                });
                children.push(task);
            }
        }
        if (children.length) {
            return new Task(children, {
                name: args.name,
                bail: true,
                serial: true,
            });
        }
    }

    protected async _exec(args: {
        name: string;
        json: any;
        dirname: string;
        dependencies?: string[];
        command: string;
        stdio?: 'inherit' | 'pipe';
    }, options?: any): Promise<ExecuteCommandResult> {
        logger.verbose(this.commandName,
            chalk.cyan(args.name),
            chalk.cyanBright.bold('executing'),
            logger.separator,
            args.command
        );
        const t = Date.now();
        const r = await exec(args.command, {cwd: args.dirname, stdio: args.stdio});
        if (r.error) {
            logger.error(
                this.commandName,
                chalk.cyan(args.name),
                chalk.red.bold('failed'),
                logger.separator,
                args.command,
                logger.separator,
                r.error.message.trim()
            );
            logger.verbose(this.commandName, '', r.stderr || r.stdout);
        } else
            logger.info(
                this.commandName,
                chalk.cyan(args.name),
                chalk.green.bold('executed'),
                logger.separator,
                args.command,
                chalk.yellow(' (' + (Date.now() - t) + ' ms)')
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
