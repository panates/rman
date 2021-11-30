import fs from 'fs/promises';
import {URL} from 'url';
import chalk from 'chalk';
import {program} from "commander"
import {Workspace} from './workspace/workspace.js';

export async function run(argv: string[] = process.argv) {
    const pkgJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf-8'));

    program.version(pkgJson.version || '');

    program
        .command('run <script>')
        .description('Executes given script for every package in repository')
        .action(async (script) => runScript(script))
        .allowUnknownOption();
    program
        .command('build')
        .description('Executes "build" script for every package in repository')
        .action(async () => runScript('build'))
        .allowUnknownOption()
    program
        .command('lint')
        .description('Executes "lint" script for every package in repository')
        .action(async () => runScript('lint'))
        .allowUnknownOption()
    program
        .command('test')
        .description('Executes "test" script for every package in repository')
        .action(async () => runScript('lint'))
        .allowUnknownOption()

    program.parse(argv);

}

async function runScript(script: string): Promise<void> {
    const workspace = await Workspace.resolve();
    const result = await workspace.runScript(script, {
        gauge: true
    });

    if (result.errorCount) {
        console.error('\n' + chalk.yellow(result.errorCount) + chalk.white(' error(s)'));
        let s = ''
        for (let i = 0; i < result.commands.length; i++) {
            const cmd = result.commands[i];
            if (cmd.error) {
                s += '\n' + (i + 1) + ') ' +
                    chalk.cyanBright(cmd.package) + '\n' +
                    chalk.white(cmd.command) + '\n' +
                    chalk.red('Error: ' + cmd.error.message) + '\n' +
                    chalk.red(cmd.stderr) + '\n';
            }
        }
        console.error(s);
    }
}
