import colors from 'ansi-colors';
import logger from 'npmlog';
import path from 'path';
import { Task } from 'power-tasks';
import * as yargs from 'yargs';
import { Command } from '../core/command.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';
import { ExecuteCommandResult } from '../utils/exec.js';
import { NpmHelper } from '../utils/npm-utils.js';
import { RunCommand } from './run-command.js';

export class PublishCommand extends RunCommand<PublishCommand.Options> {
  static commandName = 'publish';

  constructor(
    readonly repository: Repository,
    options?: PublishCommand.Options,
  ) {
    super(repository, 'publish', {
      ...options,
      bail: false,
      parallel: true,
    });
  }

  protected async _prepareTasks(packages: Package[]): Promise<Task[]> {
    const newVersions: Record<string, string> = {};
    const selectedPackages: Package[] = [];

    const promises: Promise<any>[] = [];
    for (const p of packages) {
      const logPkgName = colors.yellow(p.name);
      if (p.json.private) {
        logger.info(this.commandName, logPkgName, logger.separator, `Ignored. Package is set to "private"`);
        continue;
      }

      logger.info(this.commandName, logPkgName, logger.separator, `Fetching package information from repository`);
      const npmHelper = new NpmHelper({ cwd: p.dirname });
      promises.push(
        npmHelper
          .getPackageInfo(p.json.name, { userconfig: this.options.userconfig })
          .then(r => {
            const sameVersion = !!(r && r.version === p.version);
            if (this.options.checkOnly) {
              logger.info(
                this.commandName,
                logPkgName,
                logger.separator,
                !r.version
                  ? colors.yellow('No package information found in repository')
                  : sameVersion
                    ? `No publish needed. Version (${colors.magenta(p.version)}) same in repository`
                    : `Publishing is possible.` +
                      ` Version "${colors.magenta(p.version)}" differs from version in repository (${colors.magenta(r.version)})`,
              );
              return;
            }
            if (r && r.version === p.version) {
              logger.info(
                this.commandName,
                logPkgName,
                logger.separator,
                `No publish needed. Version (${colors.magenta(p.version)}) same in repository`,
              );
            } else {
              logger.verbose(
                this.commandName,
                logPkgName,
                logger.separator,
                `Publishing is possible.` +
                  ` Version "${colors.magenta(p.version)}" differs from version in repository (${colors.magenta(r.version)})`,
              );
              selectedPackages.push(p);
            }
          })
          .catch(e => {
            if (e.name !== 'PackageNotFoundError') throw e;
          }),
      );
    }
    await Promise.all(promises);

    return super._prepareTasks(selectedPackages, { newVersions });
  }

  protected async _exec(pkg: Package, command: string, args: {}, options?: any): Promise<ExecuteCommandResult> {
    if (command === '#') {
      if (pkg === this.repository.rootPackage) return { code: 0 };
      const cwd = this.options.contents
        ? path.resolve(this.repository.dirname, path.join(this.options.contents, path.basename(pkg.dirname)))
        : pkg.dirname;
      return super._exec(
        pkg,
        'npm publish' +
          (this.options.access ? ' --access=' + this.options.access : '') +
          (this.options.userconfig ? ` --userconfig="${this.options.userconfig}"` : ''),
        {
          ...args,
          cwd,
          stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe',
        },
        options,
      );
    }
    return super._exec(pkg, command, args, options);
  }
}

export namespace PublishCommand {
  export interface Options extends RunCommand.Options {
    contents?: string;
    access?: string;
    checkOnly?: boolean;
    userconfig?: string;
  }

  export const cliCommandOptions: Record<string, yargs.Options> = {
    ...RunCommand.cliCommandOptions,
    contents: {
      describe: '# Subdirectory to publish',
      type: 'string',
    },
    access: {
      describe:
        '#  Tells the registry whether this package should be published as public or restricted. ' +
        "Only applies to scoped packages, which default to restricted. If you don't have a paid account, " +
        'you must publish with --access public to publish scoped packages.',
      type: 'string',
      choices: ['public', 'restricted'],
    },
    userconfig: {
      describe: '# Path of .npmrc file to use for authentication',
      type: 'string',
    },
    'check-only': {
      describe: '#  Only performs version checking and do not apply "publish" to the registry.',
      type: 'boolean',
    },
  };

  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'publish [...options]',
      describe: 'Publish packages in the current project',
      builder: cmd =>
        cmd
          .example('$0 publish', '')
          .example('$0 publish --contents dist', '# publish package from built directory')
          .option(PublishCommand.cliCommandOptions),
      handler: async args => {
        const options = Command.composeOptions(PublishCommand.commandName, args, repository.config);
        await new PublishCommand(repository, options).execute();
      },
    });
  }
}
