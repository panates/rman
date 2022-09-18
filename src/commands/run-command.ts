import chalk from 'chalk';
import logger from 'npmlog';
import { Task } from 'power-tasks';
import yargs from 'yargs';
import parseNpmScript from '@netlify/parse-npm-script';
import { Command } from '../core/command.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';
import { exec, ExecuteCommandResult } from '../utils/exec.js';
import { MultiTaskCommand } from './multi-task-command.js';

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
        const childTask = this._prepareScriptTask(p, options);
        if (childTask) {
          packageTasks.push(childTask);
        }
      }
    }
    const rootTask = this._prepareScriptTask(this.repository.rootPackage);
    if (!rootTask?.children)
      return packageTasks;
    const tasks: Task[] = [];
    const pre = rootTask.children.filter((t => t.name?.endsWith(':pre' + this.script)));
    const post = rootTask.children.filter((t => t.name?.endsWith(':post' + this.script)));
    pre.forEach(t => t.options.exclusive = true);
    post.forEach(t => t.options.exclusive = true);
    tasks.push(...pre);
    tasks.push(...packageTasks);
    tasks.push(...post);
    return tasks;
  }

  protected _prepareScriptTask(pkg: Package, options?: any): Task | undefined {
    const json = {...pkg.json};
    json.scripts = json.scripts || {};
    json.scripts[this.script] = json.scripts[this.script] || '#';

    const scriptInfo = parseNpmScript(json, 'npm run ' + this.script);
    if (!(scriptInfo && scriptInfo.raw))
      return;

    const children: Task[] = [];
    for (const s of scriptInfo.steps) {
      const parsed = Array.isArray(s.parsed) ? s.parsed : [s.parsed];
      for (const cmd of parsed) {
        const task = new Task(async () => {
          return await this._exec(pkg, cmd, {
            stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe'
          }, options);
        }, {
          name: pkg.name + ':' + s.name,
          dependencies:
              (this.options.parallel || s.name.startsWith('pre') || s.name.startsWith('post')) ?
                  undefined : pkg.dependencies
        });
        children.push(task);
      }
    }
    if (children.length) {
      return new Task(children, {
        name: pkg.name,
        bail: true,
        serial: true,
      });
    }
  }

  protected async _exec(
      pkg: Package,
      command: string,
      args: {
        stdio?: 'inherit' | 'pipe';
        cwd?: string;
        json?: any;
        logLevel?: string;
        noThrow?: boolean;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      }, options?: any
  ): Promise<ExecuteCommandResult> {
    const name = pkg === this.repository.rootPackage ? 'root' : pkg.name;
    const logLevel = args.logLevel == null ? 'info' : args.logLevel;
    if (logLevel)
      logger.verbose(this.commandName,
          chalk.cyan(name),
          chalk.cyanBright.bold('executing'),
          logger.separator,
          command
      );
    const t = Date.now();
    const cwd = args.cwd || pkg.dirname;
    const r = await exec(command, {cwd, stdio: args.stdio, throwOnError: false});
    if (logLevel)
      if (r.error) {
        logger.error(
            this.commandName,
            chalk.cyan(name),
            chalk.red.bold('failed'),
            logger.separator,
            command,
            logger.separator,
            r.error.message.trim() + ('\n' + r.stdout).trim()
        );
      } else
        logger.log(logLevel,
            this.commandName,
            chalk.cyan(name),
            chalk.green.bold('executed'),
            logger.separator,
            command,
            chalk.yellow(' (' + (Date.now() - t) + ' ms)')
        );
    if (r.error && !args.noThrow)
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
      describe: 'Execute an arbitrary script in each package',
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
        const runCfg = repository.config?.command?.run;
        if (args.script && runCfg && typeof runCfg === 'object') {
          ['parallel', 'bail', 'progress'].forEach(n => {
            if (typeof runCfg[n] === 'string') {
              runCfg[n] = runCfg[n].split(/\s*,\s*/).includes(args.script);
            }
          })
        }
        const options = Command.composeOptions(RunCommand.commandName, args, repository.config);
        const script: string = '' + args.script;
        await new RunCommand(repository, script, options).execute();
      }
    })
  }
}
