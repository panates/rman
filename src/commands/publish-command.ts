import yargs from 'yargs';
import {Task} from 'power-tasks';
import chalk from 'chalk';
import fetchPackageInfo from 'package-json';
import logger from 'npmlog';
import figures from 'figures';
import {Repository} from '../core/repository';
import {Command} from '../core/command';
import {Package} from '../core/package';
import {RunCommand} from './run-command';

export class PublishCommand extends RunCommand<PublishCommand.Options> {

    static commandName = 'publish';

    constructor(readonly repository: Repository,
                options?: PublishCommand.Options) {
        super(repository, 'publish', options);
    }

    protected async _prepareTasks(): Promise<Task[]> {
        const {repository} = this;
        const packages = repository.getPackages({toposort: true});
        const newVersions: Record<string, string> = {};
        const selectedPackages: Package[] = [];
        for (const p of packages) {
            const logPkgName = chalk.yellow(p.name);
            const r = await fetchPackageInfo(p.json.name);
            if (r.version === p.version) {
                logger.info(
                    this.commandName,
                    logPkgName,
                    chalk.gray(figures.lineVerticalDashed0),
                    `Ignored. Same version (${p.version}) in repository`);
                continue;
            }
            selectedPackages.push(p);
        }

        const tasks: Task[] = [];
        for (const p of selectedPackages) {
            const json = {...p.json};
            json.scripts = json.scripts || {};
            json.scripts.publish = json.scripts.publish || 'npm publish';
            const _p = {json};
            Object.setPrototypeOf(_p, p);

            const childTask = this._preparePackageTask(_p as Package, {newVersions});
            if (childTask) {
                tasks.push(childTask);
            }
        }
        return tasks;
    }

}

export namespace PublishCommand {
    export interface Options extends RunCommand.Options {
        contents?: string;
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...RunCommand.cliCommandOptions,
        'contents': {
            describe: '# Subdirectory to publish',
            type: 'string'
        }
    };

    export function initCli(repository: Repository, program: yargs.Argv) {
        program.command({
            command: 'publish [...options]',
            describe: 'Publish packages in the current project',
            builder: (cmd) => {
                return cmd
                    .example("$0 publish", '')
                    .example("$0 publish --contents dist", '# publish package from built directory')
                    .option(PublishCommand.cliCommandOptions);
            },
            handler: async (args) => {
                const options = Command.composeOptions(PublishCommand.commandName, args, repository.config);
                await new PublishCommand(repository, options).execute();
            }
        })
    }
}
