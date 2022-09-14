import yargs from 'yargs';
import { Task } from 'power-tasks';
import chalk from 'chalk';
import logger from 'npmlog';
import { Repository } from '../core/repository';
import { Command } from '../core/command';
import { Package } from '../core/package';
import { RunCommand } from './run-command';
import { ExecuteCommandResult } from '../utils/exec';
import path from 'path';
import { NpmHelper } from '../utils/npm-utils';

export class PublishCommand extends RunCommand<PublishCommand.Options> {

  static commandName = 'publish';

  constructor(readonly repository: Repository,
              options?: PublishCommand.Options) {
    super(repository, 'publish', {
      ...options,
      bail: false,
      parallel: true
    });
  }

  protected async _prepareTasks(packages: Package[]): Promise<Task[]> {
    const newVersions: Record<string, string> = {};
    const selectedPackages: Package[] = [];

    const promises: Promise<any>[] = [];
    for (const p of packages) {
      const logPkgName = chalk.yellow(p.name);
      if (p.json.private) {
        logger.info(
            this.commandName,
            logPkgName,
            logger.separator,
            `Ignored. Package is set to "private"`);
        continue;
      }

      logger.info(
          this.commandName,
          logPkgName,
          logger.separator,
          `Fetching package information from repository`);
      const npmHelper = new NpmHelper({cwd: p.dirname});
      promises.push(npmHelper.getPackageInfo(p.json.name)
          .then(r => {
            const sameVersion = !!(r && r.version === p.version);
            if (this.options.checkOnly) {
              logger.info(
                  this.commandName,
                  logPkgName,
                  logger.separator,
                  !r.version
                      ? chalk.yellow('No package information found in repository')
                      : (sameVersion
                              ? `Version "${chalk.magenta(p.version)}" same in repository`
                              : `Version "${chalk.magenta(p.version)}" differs from version in repository (${chalk.magenta(r.version)})`
                      )
              );
              return;
            }
            if (r && r.version === p.version) {
              logger.info(
                  this.commandName,
                  logPkgName,
                  logger.separator,
                  `Ignored. Same version (${p.version}) in repository`);
            } else {
              logger.info(
                  this.commandName,
                  logPkgName,
                  logger.separator,
                  `Version (${r.version}) in repository`);
              selectedPackages.push(p);
            }
          }).catch(e => {
            if (e.name !== 'PackageNotFoundError')
              throw e;
          })
      );
    }
    await Promise.all(promises);

    return super._prepareTasks(selectedPackages, {newVersions});
  }

  protected async _exec(args: {
    name: string;
    json: any;
    cwd: string;
    dependencies?: string[];
    command: string;
  }, options?: any): Promise<ExecuteCommandResult> {
    if (args.command === '#') {
      if (args.name === 'root')
        return {code: 0};
      const cwd = this.options.contents
          ? path.resolve(this.repository.dirname, path.join(this.options.contents, path.basename(args.cwd)))
          : args.cwd;
      return super._exec({
        ...args,
        cwd,
        command: 'npm publish' + (this.options.access ? ' --access=' + this.options.access : '')
      }, {
        ...options,
        stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe'
      });
    }
    return super._exec(args, options);
  }
}

export namespace PublishCommand {
  export interface Options extends RunCommand.Options {
    contents?: string;
    access?: string;
    checkOnly?: boolean;
  }

  export const cliCommandOptions: Record<string, yargs.Options> = {
    ...RunCommand.cliCommandOptions,
    'contents': {
      describe: '# Subdirectory to publish',
      type: 'string'
    },
    'access': {
      describe: '#  Tells the registry whether this package should be published as public or restricted. ' +
          'Only applies to scoped packages, which default to restricted. If you don\'t have a paid account, ' +
          'you must publish with --access public to publish scoped packages.',
      type: 'string',
      choices: ['public', 'restricted']
    },
    'check-only': {
      describe: '#  Only performs version checking and do not apply "publish" to the registry.',
      type: 'boolean'
    }
  };

  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'publish [...options]',
      describe: 'Publish packages in the current project',
      builder: (cmd) => {
        return cmd
            .example("$0 publish", '')
            .example("$0 publish --contents dist", '# publish package from built directory')
            .option(PublishCommand.cliCommandOptions);
      },
      handler: async (args) => {
        const options = Command.composeOptions(PublishCommand.commandName, args, repository.config);
        await new PublishCommand(repository, options).execute();
      }
    })
  }
}
