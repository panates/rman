import colors from 'ansi-colors';
import fs from 'fs/promises';
import logger from 'npmlog';
import path from 'path';
import yargs from 'yargs';
import { BuildCommand } from './commands/build-command.js';
import { ChangedCommand } from './commands/changed-command.js';
import { CleanInstallCommand } from './commands/ci-command.js';
import { ExecuteCommand } from './commands/execute-command.js';
import { InfoCommand } from './commands/info-command.js';
import { ListCommand } from './commands/list-command.js';
import { PublishCommand } from './commands/publish-command.js';
import { RunCommand } from './commands/run-command.js';
import { VersionCommand } from './commands/version-command.js';
import { Command } from './core/command.js';
import { Repository } from './core/repository.js';
import { getDirname } from './utils/get-dirname.js';

export async function runCli(options?: { argv?: string[]; cwd?: string }) {
  try {
    const s = path.resolve(getDirname(), '../package.json');
    const pkgJson = JSON.parse(await fs.readFile(s, 'utf-8'));
    const repository = Repository.create(options?.cwd);
    const _argv = options?.argv || process.argv.slice(2);

    const globalKeys = Object.keys(Command.globalOptions).concat(['help', 'version']);

    const program = yargs(_argv)
      // .scriptName('rman')
      .strict()
      .version(pkgJson.version || '')
      .alias('version', 'v')
      .usage('$0 <cmd> [options...]')
      .help('help')
      .alias('help', 'h')
      .showHelpOnFail(false, 'Run with --help for available options')
      .fail((msg: any, err: any) => {
        if (!err?.logged) {
          const text = msg
            ? msg + '\n\n' + colors.whiteBright('Run with --help for available options')
            : err
              ? err.message
              : '';
          // eslint-disable-next-line no-console
          console.log('\n' + colors.red(text));
          throw msg;
        } else process.exit(1);
      })
      // group options under "Global Options:" header
      .options(Command.globalOptions)
      .group(globalKeys, 'Global Options:');

    InfoCommand.initCli(repository, program);
    ListCommand.initCli(repository, program);
    ChangedCommand.initCli(repository, program);
    ExecuteCommand.initCli(repository, program);
    RunCommand.initCli(repository, program);
    VersionCommand.initCli(repository, program);
    PublishCommand.initCli(repository, program);
    CleanInstallCommand.initCli(repository, program);
    BuildCommand.initCli(repository, program);

    if (!_argv.length) program.showHelp();
    else await program.parseAsync().catch(() => process.exit(1));
  } catch (e: any) {
    logger.error('rman', e);
  }
}
