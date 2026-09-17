import {
  applyBranchGuardOptions,
  applyPackageFilterOptions,
  applyRootOption,
  assertAllowedBranch,
  type CustomCommand,
  type LogLevel,
  readBranchGuardOptions,
  readPackageFilterOptions,
} from 'rman';
import { CleanService } from '../services/clean.service.js';

/**
 * `rman clean` - contributed by the `@rman/node` plugin rather than built into rman, because what
 * it deletes is TypeScript's output. See `CleanService.clean`.
 */
export const command: CustomCommand = {
  command: 'clean',
  configKeys: ['clean'],
  describe: 'Removes compiled TypeScript output and any extra files/dirs configured via .rmanrc "clean"',
  builder: cmd =>
    applyRootOption(applyBranchGuardOptions(applyPackageFilterOptions(cmd)), 'Clean')
      .example('$0 clean', '')
      .example('$0 clean --dry-run', '# Preview what would be removed')
      .option('progress', {
        describe: 'Show a live progress panel (default: true; auto-disabled when not a TTY)',
        type: 'boolean',
      })
      .option('dry-run', {
        describe: 'Report what would be removed without actually removing anything',
        type: 'boolean',
      }),
  handler: async ({ repository }, args) => {
    await assertAllowedBranch(repository, readBranchGuardOptions(args));
    await CleanService.clean(repository, {
      ...readPackageFilterOptions(args),
      progress: args.progress as boolean | undefined,
      dryRun: args.dryRun as boolean | undefined,
      root: args.root as boolean | undefined,
      logLevel: args.logLevel as LogLevel | undefined,
    });
  },
};
