import chalk from 'chalk';
import envinfo from 'envinfo';
import semver from 'semver';
import yargs from 'yargs';
import { Command } from '../core/command';
import { Repository } from '../core/repository';

export class InfoCommand extends Command {
  static commandName = 'info';

  protected async _execute(): Promise<any> {
    const systemInfo = JSON.parse(
        await envinfo.run({
          System: ['OS', 'CPU', 'Memory', 'Shell'],
          Binaries: ['Node', 'Yarn', 'npm'],
          Utilities: ['Git'],
          npmPackages: ['rman', 'typescript'],
          npmGlobalPackages: ['typescript']
        }, {json: true}));
    if (this.options.json) {
      this.logger.output('', '%j', systemInfo);
      return;
    }
    const maxName = Object.keys(systemInfo).reduce((l, p) =>
            Object.keys(systemInfo[p]).reduce((i, x) => l = Math.max(i, x.length), l)
        , 0);
    for (const [categoryName, category] of Object.entries<object>(systemInfo)) {
      this.logger.output('', '', chalk.whiteBright(categoryName) + ':');
      for (const [n, v] of Object.entries(category)) {
        const label = '    ' + chalk.reset(n) +
            ' '.repeat(maxName - n.length) + ' :';
        if (typeof v === 'string') {
          this.logger.output('', label, chalk.yellowBright(v));
          continue;
        }
        if (v.version)
          this.logger.output('', label, chalk.yellowBright(v.version),
              (v.path ? ' ' + chalk.yellow(v.path) : ''));
        if (v.installed) {
          if (v.wanted === 'latest' || semver.intersects(v.installed, v.wanted))
            this.logger.output('', label, chalk.yellowBright(v.installed));
          else this.logger.output('', label, chalk.red(v.installed), ' => ', chalk.yellowBright(v.wanted));
        }
      }
    }
  }

}

export namespace InfoCommand {

  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'info [options...]',
      describe: 'Prints local environment information',
      builder: (cmd) => {
        return cmd
            .example("$0 info", "# Prints information")
            .example('$0 info --json', '# Prints information in JSON format');
      },
      handler: async (args) => {
        const options = Command.composeOptions(InfoCommand.commandName, args, repository.config);
        await new InfoCommand(options)
            .execute();
      }
    })
  }


}
