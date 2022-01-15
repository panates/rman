import path from 'path';
import fs from 'fs/promises';
import yargs, {Options} from "yargs"

import {getDirname} from './utils';
import {Repository} from './core/repository';
import {ListCommand} from './commands/list.command';
import {InfoCommand} from './commands/info.command';
import {RunCommand} from './commands/run.command';
import {ExecuteCommand} from './commands/execute.command';
import {ChangedCommand} from './commands/changed.command';
import {VersionCommand} from './commands/version.command';
import chalk from 'chalk';
import logger from './core/logger';

// import {PublishCommand} from './commands/publish.command';

export async function runCli(options?: { argv?: string[], cwd?: string }) {
    const s = path.resolve(getDirname(), '../package.json');
    const pkgJson = JSON.parse(await fs.readFile(s, 'utf-8'));
    const repository = Repository.create(options?.cwd);

    logger.setHandler((level, message, ...optionalParams) => {
        console.log(message, ...optionalParams);
    });

    const program = yargs(options?.argv || process.argv.slice(2))
        .scriptName('rman')
        .version(pkgJson.version || '').alias('version', 'v')
        .usage('$0 <cmd> [options...]')
        .help('help').alias('help', 'h')
        .showHelpOnFail(false, 'Run with --help for available options')
        .middleware(() => {
            console.log(chalk.whiteBright('# Project root: ') + chalk.magenta(repository.dirname));
        })
        .fail(() => setTimeout(() => process.exit(1), 100));

    setGlobalOptions(program);
    ListCommand.initCli(repository, program);
    InfoCommand.initCli(repository, program);
    ExecuteCommand.initCli(repository, program);
    RunCommand.initCli(repository, program);
    ChangedCommand.initCli(repository, program);
    VersionCommand.initCli(repository, program);
    // PublishCommand.initCli(repository, program);

    await program.parseAsync().catch(() => 0);
}

export function setGlobalOptions(program: yargs.Argv): yargs.Argv {

    const globalOptions: Record<string, Options> = {
        'log-level': {
            defaultDescription: "info",
            describe: "Set log level",
            choices: ['trace', 'info', 'warn', 'error', 'fatal'],
            requiresArg: true,
            hidden: true
        },
        'no-progress': {
            describe: "Disable progress bars",
            type: 'boolean',
        }
    }

    // group options under "Global Options:" header
    const globalKeys = Object.keys(globalOptions).concat(["help", "version"]);

    return program.options(globalOptions)
        .group(globalKeys, "Global Options:")
        .option('ci', {
            hidden: true,
            type: "boolean",
        });

}
