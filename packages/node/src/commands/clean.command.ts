import {
  type ArgsOf,
  assertAllowedBranch,
  branchGuardOptions,
  type CommandOption,
  declareCommand,
  fromRootOption,
  packageFilterOptions,
  readBranchGuardOptions,
  readPackageFilterOptions,
} from 'rman';
import { CleanService } from '../services/clean.service.js';

/** Hoisted for `ArgsOf` - see `ci.command.ts` and `RmanConfig.ArgsOf`. */
const COMMAND = 'clean' as const;

const config = {
  ...packageFilterOptions,
  ...branchGuardOptions,
  /** A group of one, and a function because its text is this command's own word for what it does. */
  ...fromRootOption('Clean'),
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
  /** Config-only: `.rmanrc "clean.skip"` excludes a package from `clean` entirely. Not a flag -
   *  a single run narrows with `--scope`/`--ignore`, which every command already has. */
  skip: {
    target: 'config',
    describe: 'Excludes this package from clean entirely',
    type: 'boolean',
  },
} satisfies Record<string, CommandOption>;

/**
 * The rest of `clean.*` - the two keys an option cannot describe.
 *
 * `include`/`exclude` are each **a glob or a list of them**, and a `CommandOption` says one or the
 * other: `type: 'string'` is a string, `array: true` beside it is a `string[]`. Neither is the
 * union, and the union is what a config author actually writes (`include: 'build'` as often as
 * `include: ['build', '*.tsbuildinfo']`). So they are written out and intersected in, which is what
 * `Extra` is for - `skip` above is an ordinary option and is derived like everything else.
 */
export interface CleanExtraKeys {
  /** Extra files and directories to remove, beyond TypeScript's own output - globs relative to
   *  each package's own directory. Per-package cascaded; a package declaring its own `clean` block
   *  replaces the root's entirely for itself, rather than combining with it. */
  include?: string | string[];
  /** Globs to keep, applied after `include`. */
  exclude?: string | string[];
}

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
     * **No `configKeys`, because `clean` is this command's *own* key now** - derived from the
     * `config` block above and contributed to `RmanConfig` by `CommandContribution`, exactly as a
     * built-in contributes its own. It used to be hand-written in `NodeConfigKeys` *and* named
     * here, which is two statements about one key.
     *
     * **The contribution itself is in `augmentation/rman.augmentation.ts`, not here**, and that is
     * not a stylistic choice: one `declare module 'rman'` block per package is the limit, and a
     * second silently disables the first. Measured again while moving this - a second block left
     * `SystemInfo.PackageManager` unresolved at four call sites, with nothing pointing at the
     * cause. rman's own commands declare theirs beside themselves because they augment a *module
     * path*, which has no such limit.
     */
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
        fromRoot: args.fromRoot,
        logLevel: args.logLevel,
      });
    },
  };
});

export default cleanCommand;
