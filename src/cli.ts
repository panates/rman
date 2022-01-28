import path from 'path';
import fs from 'fs/promises';
import yargs, {Options} from "yargs"
import chalk from 'chalk';
import {getDirname} from './utils';
import {Repository} from './core/repository';
import {InfoCommand} from './commands/info-command';
import {ListCommand} from './commands/list-command';
import {ChangedCommand} from './commands/changed-command';
import {ExecuteCommand} from './commands/execute-command';
import {RunCommand} from './commands/run-command';
import {VersionCommand} from './commands/version-command';
import {PublishCommand} from './commands/publish-command';

export async function runCli(options?: { argv?: string[], cwd?: string }) {
    const s = path.resolve(getDirname(), '../package.json');
    const pkgJson = JSON.parse(await fs.readFile(s, 'utf-8'));
    const repository = Repository.create(options?.cwd);
    const _argv = options?.argv || process.argv.slice(2);

    const program = yargs(_argv)
        .scriptName('rman')
        .strict()
        .version(pkgJson.version || '').alias('version', 'v')
        .usage('$0 <cmd> [options...]')
        .help('help').alias('help', 'h')
        .showHelpOnFail(false, 'Run with --help for available options')
        .fail((msg: any, err) => {
            const text = (msg
                ? msg + '\n\n' + chalk.whiteBright('Run with --help for available options')
                : (err ? err.message : ''));
            console.log('\n' + chalk.red(text));
            throw msg;
        });

    setGlobalOptions(program);
    InfoCommand.initCli(repository, program);
    ListCommand.initCli(repository, program);
    ChangedCommand.initCli(repository, program);
    ExecuteCommand.initCli(repository, program);
    RunCommand.initCli(repository, program);
    VersionCommand.initCli(repository, program);
    PublishCommand.initCli(repository, program);

    if (!_argv.length)
        program.showHelp();
    else
        await program.parseAsync()
            .catch();
}

export function setGlobalOptions(program: yargs.Argv): yargs.Argv {

    const globalOptions: Record<string, Options> = {
        'log-level': {
            defaultDescription: "info",
            describe: "Set log level",
            choices: ['silly', 'verbose', 'info', 'output', 'notice', 'success', 'warn', 'error', 'silent'],
            requiresArg: true,
            hidden: true
        },
        'no-progress': {
            describe: "Disable progress bars",
            type: 'boolean',
        },
        'progress': {
            hidden: true,
            type: 'boolean'
        },
        'json': {
            alias: 'j',
            describe: '# Stream output as json'
        },
        'ci': {
            hidden: true,
            type: "boolean"
        }
    }

    // group options under "Global Options:" header
    const globalKeys = Object.keys(globalOptions).concat(["help", "version"]);
    return program.options(globalOptions)
        .group(globalKeys, "Global Options:");

}
