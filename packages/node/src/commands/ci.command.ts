import {
  applyBranchGuardOptions,
  applyPackageFilterOptions,
  assertAllowedBranch,
  type CustomCommand,
  type LogLevel,
  readBranchGuardOptions,
  readPackageFilterOptions,
} from 'rman';
import { CiService } from '../services/ci.service.js';

/**
 * `rman ci` - contributed by the `rman-node` plugin rather than built into rman.
 *
 * A plugin's command is a `CustomCommand`, so the repository arrives through `context` instead of
 * being captured when the command is registered - the same shape a repository's own `.rman/*.mjs`
 * command has, and the reason both can be registered through one code path.
 */
export const command: CustomCommand = {
  command: 'ci',
  configKeys: ['packageManager'],
  describe: 'Deletes node_modules and lockfiles in every package, then reinstalls from scratch',
  builder: cmd =>
    applyBranchGuardOptions(applyPackageFilterOptions(cmd))
      .example('$0 ci', '')
      .option('package-manager', {
        describe: 'Package manager to install with (default: npm, or .rmanrc "packageManager")',
        choices: CiService.PACKAGE_MANAGERS,
      })
      .option('progress', {
        describe:
          'Show a live progress panel while running (default: true; auto-disabled when not a TTY). ' +
          'Unlike run/build, completion is not reported as a per-package tally - only failures are called out.',
        type: 'boolean',
      }),
  handler: async ({ repository }, args) => {
    await assertAllowedBranch(repository, readBranchGuardOptions(args));
    await CiService.reinstall(repository, {
      ...readPackageFilterOptions(args),
      packageManager: args.packageManager as CiService.PackageManager | undefined,
      progress: args.progress as boolean | undefined,
      logLevel: args.logLevel as LogLevel | undefined,
    });
  },
};
