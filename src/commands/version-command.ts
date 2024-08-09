import colors from 'ansi-colors';
import logger from 'npmlog';
import path from 'path';
import { Task } from 'power-tasks';
import semver from 'semver';
import stripColor from 'strip-color';
import yargs from 'yargs';
import { Command } from '../core/command.js';
import { Package } from '../core/package.js';
import { Repository } from '../core/repository.js';
import { ExecuteCommandResult } from '../utils/exec.js';
import { GitHelper } from '../utils/git-utils.js';
import { RunCommand } from './run-command.js';

export class VersionCommand extends RunCommand<VersionCommand.Options> {
  static commandName = 'version';
  private _updatedPackages = new Set<Package>();

  constructor(
    readonly repository: Repository,
    public bump: string,
    options?: VersionCommand.Options,
  ) {
    super(repository, 'version', options);
  }

  protected async _prepareTasks(packages: Package[]): Promise<Task[]> {
    const { repository } = this;
    const git = new GitHelper({ cwd: repository.dirname });

    const dirtyFiles = await git.listDirtyFiles();
    const committedFiles = await git.listCommittedFiles();

    const newVersions: Record<string, string> = {};
    let errorCount = 0;
    const selectedPackages: Package[] = [];
    const dependentPackages: Package[] = [];
    for (const p of packages) {
      const relDir = path.relative(repository.dirname, p.dirname);
      let status = '';
      let message = '';
      let newVer: any = '';
      const logPkgName = colors.yellow(p.name);

      if (!this.options.noTag) {
        const isDirty = dirtyFiles.find(f => !path.relative(relDir, f).startsWith('..'));
        if (isDirty) {
          if (!this.options.ignoreDirty) errorCount++;
          status = this.options.ignoreDirty ? colors.cyan.bold('skip') : colors.redBright.bold('error');
          message = 'Git directory is not clean';
        }
      }

      if (!status) {
        const isChanged = committedFiles.find(f => !path.relative(relDir, f).startsWith('..'));
        newVer =
          isChanged || this.options.all || this.options.unified
            ? semver.inc(p.version, this.bump as semver.ReleaseType)
            : undefined;
        if (newVer) newVersions[p.name] = newVer;
        else {
          status = colors.cyanBright.bold('no-change');
          message = 'No change detected';
        }
      }

      if (status) {
        if (this.options.json) {
          logger.info(this.commandName, '%j', {
            package: p.name,
            version: p.version,
            newVersion: newVer,
            status: stripColor(status),
            message: stripColor(message),
          });
        } else {
          logger.log(
            this.options.ignoreDirty ? 'info' : 'error',
            this.commandName,
            logPkgName,
            colors.whiteBright(p.version),
            status,
            logger.separator,
            message,
          );
        }
        continue;
      }
      selectedPackages.push(p);

      packages.forEach(p2 => {
        if (p2.dependencies.includes(p.name) && !dependentPackages.includes(p2)) dependentPackages.push(p2);
      });
    }

    if (errorCount) throw new Error('Unable to bump version due to error(s)');

    const maxVer = Object.values(newVersions).reduce((m, v) => (semver.gt(m, v) ? m : v), '0.0.0');
    if (this.options.unified) {
      Object.keys(newVersions).forEach(k => (newVersions[k] = maxVer));
    }

    dependentPackages.forEach(p2 => {
      if (!selectedPackages.includes(p2)) selectedPackages.push(p2);
    });

    const tasks = await super._prepareTasks(selectedPackages, { newVersions });
    tasks.forEach(t => (t.options.exclusive = true));

    if (!this.options.noTag) {
      tasks.push(
        new Task(
          async () => {
            while (this._updatedPackages.size) {
              const filenames: string[] = [];
              const [first] = this._updatedPackages;
              for (const pkg of this._updatedPackages) {
                if (pkg.version === first.version) {
                  filenames.push(path.relative(this.repository.rootPackage.dirname, pkg.jsonFileName));
                  this._updatedPackages.delete(pkg);
                }
              }
              await super._exec(
                this.repository.rootPackage,
                'git commit -m "' + first.version + '" ' + filenames.map(s => '"' + s + '"').join(' '),
                {
                  stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe',
                  logLevel: 'silly',
                },
              );
            }
            if (this.options.unified) {
              try {
                await super._exec(
                  this.repository.rootPackage,
                  'git tag -a "v' + maxVer + '" -m "version ' + maxVer + '"',
                  {
                    cwd: this.repository.dirname,
                    stdio: logger.levelIndex < 1000 ? 'inherit' : 'pipe',
                    logLevel: 'silly',
                  },
                );
              } catch {
                //
              }
            }
          },
          { exclusive: true },
        ),
      );
    }
    return tasks;
  }

  protected async _exec(pkg: Package, command: string, args: {}, options?: any): Promise<ExecuteCommandResult> {
    if (pkg === this.repository.rootPackage) return { code: 0 };
    if (command === '#') {
      const { newVersions } = options;
      pkg.reloadJson();
      const oldVer = pkg.json.version;
      const newVer = newVersions[pkg.name];
      pkg.json.version = newVer;
      delete pkg.json.scripts.version;
      pkg.writeJson();
      if (!this._updatedPackages.has(pkg)) this._updatedPackages.add(pkg);

      const packages = this.repository.getPackages();
      for (const p of packages) {
        if (p.dependencies.includes(pkg.name)) {
          p.reloadJson();
          for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            if (p.json[k]?.[pkg.name]) {
              p.json[k][pkg.name] = '^' + newVer;
            }
          }
          p.writeJson();
          if (!this._updatedPackages.has(p)) this._updatedPackages.add(p);
        }
      }

      logger.info(
        this.commandName,
        pkg.name,
        logger.separator,
        'Version changed from ' + colors.cyan(oldVer) + ' to ' + colors.cyan(newVer),
      );
      return { code: 0 };
    }
    return super._exec(pkg, command, args, options);
  }
}

export namespace VersionCommand {
  export interface Options extends RunCommand.Options {
    unified?: boolean;
    all?: boolean;
    ignoreDirty?: boolean;
    noTag?: boolean;
  }

  export const cliCommandOptions: Record<string, yargs.Options> = {
    unified: {
      alias: 'u',
      describe: '# Keep all package versions same',
      type: 'boolean',
    },
    all: {
      alias: 'a',
      describe: '# Bump version for all packages even no commits',
      type: 'boolean',
    },
    'ignore-dirty': {
      alias: 'i',
      describe: '# Do not bump version for dirty packages',
      type: 'boolean',
    },
    'no-tag': {
      alias: 'n',
      describe: '# Do not crate git version tag. (Ignores dirty check)',
      type: 'boolean',
    },
  };

  export function initCli(repository: Repository, program: yargs.Argv) {
    program.command({
      command: 'version [bump] [...options]',
      describe: 'Bump version of packages',
      builder: cmd =>
        cmd
          .example('$0 version patch', '# semver keyword')
          .example('$0 version 1.0.1', '# explicit')
          .conflicts('ignore-dirty', ['force-dirty', 'unified'])
          .option(cliCommandOptions),
      handler: async args => {
        const bump = args.bump as string;
        const options = Command.composeOptions(VersionCommand.commandName, args, repository.config);
        await new VersionCommand(repository, bump, options).execute();
      },
    });
  }
}
