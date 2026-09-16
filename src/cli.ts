#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
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
import * as githubReleaseCommand from './commands/github-release.command.js';
import * as importCommand from './commands/import.command.js';
import * as infoCommand from './commands/info.command.js';
import * as listCommand from './commands/list.command.js';
import * as publishCommand from './commands/publish.command.js';
import * as runCommand from './commands/run.command.js';
import * as testCommand from './commands/test.command.js';
import * as versionCommand from './commands/version.command.js';
import { version } from './constants.js';
import { assertNoBuiltinShadowing, type CommandContext, loadCustomCommands } from './core/custom-command.js';
import { Repository } from './core/repository.js';
import { LOG_LEVELS } from './utils/logger.js';

export async function runCli(options?: { argv?: string[]; cwd?: string }) {
  try {
    const repository = await Repository.create(options?.cwd);
    const _argv = options?.argv || hideBin(process.argv);

    const program = yargs(_argv)
      .scriptName('rman')
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
          /** A real `Error`, marked `logged` since the text above just went out: yargs hands the
           *  reason over as a bare string, and rethrowing that raw made bad argv indistinguishable
           *  from success to anything holding the promise - or the shell. */
          const failure: any = new Error(
            typeof msg === 'string' && msg ? msg : typeof err?.message === 'string' ? err.message : 'invalid arguments',
          );
          failure.logged = true;
          throw failure;
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
    githubReleaseCommand.initCli(repository, program);
    execCommand.initCli(repository, program);
    changedCommand.initCli(repository, program);
    diffCommand.initCli(repository, program);
    importCommand.initCli(repository, program);

    /** A repository's own commands, from `.rman/*.mjs` - registered after the built-ins so the
     *  clash check below has the full list to compare against. */
    const { commands, errors } = await loadCustomCommands(repository.dirname);
    assertNoBuiltinShadowing(commands, BUILT_IN_COMMANDS);
    for (const custom of commands) {
      program.command({
        command: custom.command!,
        describe: custom.describe,
        builder: custom.builder ?? (y => y),
        handler: args => {
          const context: CommandContext = { repository, package: repository.currentPackage };
          return custom.handler(context, args);
        },
      });
    }
    /** Warned about, not thrown: one unparseable file must not take the other commands with it.
     *  Loud enough not to be mistaken for success, and it names the file and the reason - "my
     *  command isn't there" is otherwise a long afternoon. */
    for (const { file, reason } of errors) {
      console.error(colors.yellow(`Skipped "${path.relative(process.cwd(), file)}": ${reason}`));
    }

    program.demandCommand(1).strict().recommendCommands().completion();

    if (!_argv.length) program.showHelp();
    else await program.parseAsync().catch(() => process.exit(1));
  } catch (e: any) {
    /** Setup failures - no `package.json` to be found, a `.rman` command shadowing a built-in -
     *  used to be printed and then swallowed, so the shell saw success: `rman info` in the wrong
     *  directory reported failure on stdout and 0 to whatever called it. Printed once (unless the
     *  thrower already did, per the `logged` convention) and rethrown, so the exit code agrees
     *  with the message. */
    if (!e?.logged) console.error(colors.red(e.message));
    throw e;
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) runCli().catch(() => process.exit(1));

/** Every name a built-in command answers to - what a `.rman/*.mjs` command may not take. Kept here
 *  rather than read back out of yargs (which exposes no such list) and pinned by a test against the
 *  `command:` strings in `src/commands/*.command.ts`, so adding a command can't quietly leave a
 *  repository's own able to shadow it. */
const BUILT_IN_COMMANDS = [
  'build',
  'changed',
  'changelog',
  'ci',
  'clean',
  'completion',
  'diff',
  'exec',
  'github-release',
  'import',
  'info',
  'list',
  'publish',
  'run',
  'test',
  'version',
] as const;
