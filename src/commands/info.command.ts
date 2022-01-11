import chalk from 'chalk';
import envinfo from 'envinfo';
import semver from 'semver';
import yargs from 'yargs';
import {Command, CommandOptions} from '../core/command';
import {Workspace} from '../core/workspace';

export class InfoCommand extends Command {

    constructor(readonly workspace: Workspace, public options: InfoCommand.Options = {}) {
        super(workspace, options);
    }

    protected async _execute(): Promise<any> {
        const {workspace, options} = this;

        this.log(chalk.whiteBright('Workspace: ') + chalk.cyanBright(workspace.dirname));
        this.log(chalk.whiteBright('Environment info: '));

        const systemInfo = JSON.parse(
            await envinfo.run({
                System: ['OS', 'CPU', 'Memory', 'Shell'],
                Binaries: ['Node', 'Yarn', 'npm'],
                Utilities: ['Git'],
                npmPackages: ['rman', 'typescript'],
                npmGlobalPackages: ['typescript']
            }, {json: true}));
        if (options?.json) {
            this.log(systemInfo);
            return;
        }
        const maxName = Object.keys(systemInfo).reduce((l, p) =>
                Object.keys(systemInfo[p]).reduce((i, x) => l = Math.max(i, x.length), l)
            , 0);
        for (const [categoryName, category] of Object.entries<object>(systemInfo)) {
            this.log(' ', chalk.whiteBright(categoryName) + ':');
            for (const [n, v] of Object.entries(category)) {
                const label = '    ' + chalk.reset(n) +
                    ' '.repeat(maxName - n.length) + ' :';
                if (typeof v === 'string') {
                    this.log(label, chalk.yellowBright(v))
                    continue;
                }
                if (v.version)
                    this.log(label, chalk.yellowBright(v.version),
                        (v.path ? ' ' + chalk.yellow(v.path) : ''));
                if (v.installed) {
                    if (v.wanted === 'latest' || semver.intersects(v.installed, v.wanted))
                        this.log(label, chalk.yellowBright(v.installed));
                    else this.log(label, chalk.red(v.installed), ' => ', chalk.yellowBright(v.wanted));
                }
            }
        }

    }

}

export namespace InfoCommand {
    export interface Options extends CommandOptions {
        json?: boolean;
    }

    export function initCli(workspace: Workspace, program: yargs.Argv) {
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
                await new InfoCommand(workspace, {...options, logger: console.log})
                    .execute();
            }
        })
    }
}
