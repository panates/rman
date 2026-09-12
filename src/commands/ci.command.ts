import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { CiService } from '../services/ci.service.js';
import { applyBranchGuardOptions, assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import type { LogLevel } from '../utils/logger.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'ci',
    describe: 'Deletes node_modules and lockfiles in every package, then reinstalls from scratch',
    builder: cmd =>
      applyBranchGuardOptions(applyPackageFilterOptions(cmd))
        .example('$0 ci', '')
        .option('package-manager', {
          describe: 'Package manager to install with (default: npm, or .rmanrc "packageManager")',
          choices: PACKAGE_MANAGERS,
        })
        .option('progress', {
          describe:
            'Show a live progress panel while running (default: true; auto-disabled when not a TTY). ' +
            'Unlike run/build, completion is not reported as a per-package tally - only failures are called out.',
          type: 'boolean',
        }),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await CiService.reinstall(repository, {
        ...readPackageFilterOptions(args),
        packageManager: args.packageManager as CiService.PackageManager | undefined,
        progress: args.progress as boolean | undefined,
        logLevel: args.logLevel as LogLevel | undefined,
      });
    },
  });
}

const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'] as const;
