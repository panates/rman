import chalk from 'chalk';
import envinfo from 'envinfo';
import semver from 'semver';
import yargs from 'yargs';
import {Command} from '../core/command';
import {Repository} from '../core/repository';
import logger from '../core/logger';

export class InfoCommand extends Command {
    commandName = 'info';

    constructor(readonly repository: Repository, public options: InfoCommand.Options = {}) {
        super(repository);
    }

    protected async _execute(): Promise<any> {
        const {options} = this;
        logger.info(chalk.whiteBright('# Environment info: '));
        const systemInfo = JSON.parse(
            await envinfo.run({
                System: ['OS', 'CPU', 'Memory', 'Shell'],
                Binaries: ['Node', 'Yarn', 'npm'],
                Utilities: ['Git'],
                npmPackages: ['rman', 'typescript'],
                npmGlobalPackages: ['typescript']
            }, {json: true}));
        if (options?.json) {
            logger.info(systemInfo);
            return;
        }
        const maxName = Object.keys(systemInfo).reduce((l, p) =>
                Object.keys(systemInfo[p]).reduce((i, x) => l = Math.max(i, x.length), l)
            , 0);
        for (const [categoryName, category] of Object.entries<object>(systemInfo)) {
            logger.info(' ', chalk.whiteBright(categoryName) + ':');
            for (const [n, v] of Object.entries(category)) {
                const label = '    ' + chalk.reset(n) +
                    ' '.repeat(maxName - n.length) + ' :';
                if (typeof v === 'string') {
                    logger.info(label, chalk.yellowBright(v))
                    continue;
                }
                if (v.version)
                    logger.info(label, chalk.yellowBright(v.version),
                        (v.path ? ' ' + chalk.yellow(v.path) : ''));
                if (v.installed) {
                    if (v.wanted === 'latest' || semver.intersects(v.installed, v.wanted))
                        logger.info(label, chalk.yellowBright(v.installed));
                    else logger.info(label, chalk.red(v.installed), ' => ', chalk.yellowBright(v.wanted));
                }
            }
        }
    }

}

export namespace InfoCommand {
    export interface Options {
        json?: boolean;
    }

    export function initCli(workspace: Repository, program: yargs.Argv) {
        program.command({
            command: 'info [options...]',
            describe: 'Prints local environment information',
            builder: (cmd) => {
                return cmd
                    .example("$0 info", "# Prints information")
                    .example('$0 info --json', '# Prints information in JSON format')
                    .option({
                        'j': {
                            alias: 'json',
                            describe: '# Stream output as json',
                        }
                    });
            },
            handler: async (options) => {
                await new InfoCommand(workspace, options as Options)
                    .execute();
            }
        })
    }
}
