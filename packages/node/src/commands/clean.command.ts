import {
  type ArgsOf,
  assertAllowedBranch,
  branchGuardOptions,
  type CommandOption,
  declareCommand,
  packageFilterOptions,
  readBranchGuardOptions,
  readPackageFilterOptions,
  rootOption,
} from 'rman';
import { CleanService } from '../services/clean.service.js';

/** Hoisted for `ArgsOf` - see `ci.command.ts` and `RmanConfig.ArgsOf`. */
const COMMAND = 'clean' as const;

const config = {
  ...packageFilterOptions,
  ...branchGuardOptions,
  /** A group of one, and a function because its text is this command's own word for what it does. */
  ...rootOption('Clean'),
  progress: {
    target: 'cli',
    describe: 'Show a live progress panel (default: true; auto-disabled when not a TTY)',
    type: 'boolean',
  },
  dryRun: {
    target: 'cli',
    cliName: 'dry-run',
    describe: 'Report what would be removed without actually removing anything',
    type: 'boolean',
  },
} satisfies Record<string, CommandOption>;

type Args = ArgsOf<typeof config, typeof COMMAND>;

/**
 * `rman clean` - contributed by the `rman-node` plugin rather than built into rman, because what
 * it deletes is TypeScript's output. See `CleanService.clean`.
 *
 * Declared the same way `ci` is - see that file for why a plugin uses `declareCommand` rather than
 * `registerCommand`.
 */
const cleanCommand = declareCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Removes compiled TypeScript output and any extra files/dirs configured via .rmanrc "clean"',
    /**
     * Named rather than derived, unlike a built-in's own key.
     *
     * `clean.include`/`exclude`/`skip` are declared in this package's `NodeConfigKeys`, which merges
     * into the **config** `RmanConfig` - the one `pkg.config` is typed by and `CleanService` reads
     * through. Contributing them here as well would mean declaring the same keys against a second,
     * parallel type; that stops being two statements when the two `RmanConfig`s merge.
     */
    configKeys: ['clean'],
    config,
    examples: [
      { command: '$0 clean' },
      { command: '$0 clean --dry-run', description: '# Preview what would be removed' },
    ],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await CleanService.clean(repository, {
        ...readPackageFilterOptions(args),
        progress: args.progress,
        dryRun: args.dryRun,
        root: args.root,
        logLevel: args.logLevel,
      });
    },
  };
});

export default cleanCommand;
