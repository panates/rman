import yargs from 'yargs';
import {Task} from 'power-tasks';
import chalk from 'chalk';
import fetchPackageInfo from 'package-json';
import logger from 'npmlog';
import {Repository} from '../core/repository';
import {Command} from '../core/command';
import {Package} from '../core/package';
import {RunCommand} from './run-command';
import {ExecuteCommandResult} from '../utils/exec';
import path from 'path';

export class PublishCommand extends RunCommand<PublishCommand.Options> {

    static commandName = 'publish';

    constructor(readonly repository: Repository,
                options?: PublishCommand.Options) {
        super(repository, 'publish', options);
    }

    protected async _prepareTasks(packages: Package[]): Promise<Task[]> {
        const newVersions: Record<string, string> = {};
        const selectedPackages: Package[] = [];
        for (const p of packages) {
            const logPkgName = chalk.yellow(p.name);
            logger.verbose(
                this.commandName,
                logPkgName,
                logger.separator,
                `Fetching package information from repository`);
            /*
            const r = await fetchPackageInfo(p.json.name);
            if (r.version === p.version) {
                logger.info(
                    this.commandName,
                    logPkgName,
                    logger.separator,
                    `Ignored. Same version (${p.version}) in repository`);
                continue;
            }*/
            selectedPackages.push(p);
        }

        return super._prepareTasks(selectedPackages, {newVersions});
    }

    protected async _exec(args: {
        name: string;
        json: any;
        cwd: string;
        dependencies?: string[];
        command: string;
    }, options?: any): Promise<ExecuteCommandResult> {
        if (args.command === '#') {
            if (args.name === 'root')
                return {code: 0};
            const cwd = this.options.contents
                ? path.resolve(this.repository.dirname, path.join(this.options.contents, path.basename(args.cwd)))
                : args.cwd;
            return super._exec({
                ...args,
                cwd,
                command: 'npm publish'
            }, {...options, stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe'});
        }
        return super._exec(args, options);
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
