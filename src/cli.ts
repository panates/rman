#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import colors from 'ansi-colors';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as buildCommand from './commands/build.command.js';
import * as changedCommand from './commands/changed.command.js';
import * as changelogCommand from './commands/changelog.command.js';
import * as ciCommand from './commands/ci.command.js';
import * as cleanCommand from './commands/clean.command.js';
import * as diffCommand from './commands/diff.command.js';
import * as execCommand from './commands/exec.command.js';
import * as importCommand from './commands/import.command.js';
import * as infoCommand from './commands/info.command.js';
import * as listCommand from './commands/list.command.js';
import * as publishCommand from './commands/publish.command.js';
import * as runCommand from './commands/run.command.js';
import * as testCommand from './commands/test.command.js';
import * as versionCommand from './commands/version.command.js';
import { version } from './constants.js';
import { Repository } from './core/repository.js';
import { LOG_LEVELS } from './utils/logger.js';

export async function runCli(options?: { argv?: string[]; cwd?: string }) {
  try {
    const repository = Repository.create(options?.cwd);
    const _argv = options?.argv || hideBin(process.argv);

    const program = yargs(_argv)
      .scriptName('rman2')
      .version(version)
      .alias('version', 'v')
      .usage('$0 <cmd> [options...]')
      .help('help')
      .alias('help', 'h')
      .option('log-level', {
        describe:
          'Default verbosity of the per-step log for run/build/ci (default: info, or .rmanrc "logLevel"; ' +
          'overridable per-package via .rmanrc run.<script>.logLevel)',
        choices: LOG_LEVELS,
      })
      .showHelpOnFail(false, 'Run with --help for available options')
      .fail((msg: any, err: any) => {
        if (!err?.logged) {
          const text = msg
            ? msg + '\n\n' + colors.whiteBright('Run with --help for available options')
            : err
              ? err.message
              : '';
          console.log('\n' + colors.red(text));
          throw msg;
        } else process.exit(1);
      });

    infoCommand.initCli(repository, program);
    listCommand.initCli(repository, program);
    runCommand.initCli(repository, program);
    buildCommand.initCli(repository, program);
    ciCommand.initCli(repository, program);
    cleanCommand.initCli(repository, program);
    changelogCommand.initCli(repository, program);
    testCommand.initCli(repository, program);
    versionCommand.initCli(repository, program);
    publishCommand.initCli(repository, program);
    execCommand.initCli(repository, program);
    changedCommand.initCli(repository, program);
    diffCommand.initCli(repository, program);
    importCommand.initCli(repository, program);

    program.demandCommand(1).strict().completion();

    if (!_argv.length) program.showHelp();
    else await program.parseAsync().catch(() => process.exit(1));
  } catch (e: any) {
    console.error(colors.red(e.message));
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) runCli().catch(() => 0);
