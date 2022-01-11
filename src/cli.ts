import path from 'path';
import fs from 'fs/promises';
import yargs, {Options} from "yargs"

import {getDirname} from './utils';
import {Workspace} from './core/workspace';
import {ListCommand} from './commands/list.command';
import {InfoCommand} from './commands/info.command';
import {RunCommand} from './commands/run.command';
import {ExecuteCommand} from './commands/execute.command';
import {ChangedCommand} from './commands/changed.command';

export async function runCli(argv: string[] = process.argv.slice(2)) {
    const s = path.resolve(getDirname(), '../package.json');
    const pkgJson = JSON.parse(await fs.readFile(s, 'utf-8'));
    const workspace = Workspace.create();

    const program = yargs(argv)
        .scriptName('rman')
        .version(pkgJson.version || '').alias('version', 'v')
        .usage('$0 <cmd> [options...]')
        .help('help').alias('help', 'h')
        .showHelpOnFail(false, 'Run with --help for available options')

    setGlobalOptions(program);
    ListCommand.initCli(workspace, program);
    InfoCommand.initCli(workspace, program);
    ExecuteCommand.initCli(workspace, program);
    RunCommand.initCli(workspace, program);
    ChangedCommand.initCli(workspace, program);

    await program.parseAsync();

    /* .option('-j, --json')
    .option('-p, --parseable')
    .option('-t, --toposort')
    .option('-g --graph');

program
    .command('info')
    .description('Prints local environment information')
    .action(async (options) => runCliCommand(
        new InfoCommand(workspace, {...options, logger: console.log})))
    .option('-j, --json');

program
    .command('run <script> [args...]')
    .description('Executes given script for every package in repository')
    .action(async (script: string, args, options) =>
        runCliCommand(new RunCommand(workspace, script, {
            ...options,
            logger: !options.gui ? console.log : undefined,
            argv: args
        })))
    .option('--json', 'Stream output as json')
    .option('--serial', 'Disables concurrency and executes every step one by one')
    .option('--parallel', 'Disregards concurrency and topological sorting and runs script for every package at same time.')
    .option('--no-gui', 'Disable gui components and logs events into console.')
    .option('--no-bail', 'Runs script for all packages even one fails.');

program
    .command('version <newversion>')
    .option('-u --uniform', 'Sets all versions same in repository')
    .description('Updated versions of packages')
    .action(async (version, options) => {
        await cliVersion(version, {uniform: options.uniform});
    })
    .allowUnknownOption()

/*

    program
        .command('build')
        .description('Executes "build" script for every package in repository')
        .action(async () => cliRunScript('build'))
        .allowUnknownOption()
    program
        .command('lint')
        .description('Executes "lint" script for every package in repository')
        .action(async () => cliRunScript('lint'))
        .allowUnknownOption()
    program
        .command('test')
        .description('Executes "test" script for every package in repository')
        .action(async () => cliRunScript('lint'))
        .allowUnknownOption()

*/
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
