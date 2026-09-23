import type { ArgsOf, CommandOption } from '../../../index.js';
import { declareCommand } from '../../../interfaces/rman-config.interface.js';
import { assertAllowedBranch, branchGuardOptions, readBranchGuardOptions } from '../../../utils/branch-guard.js';
import { packageFilterOptions, readPackageFilterOptions } from '../../../utils/package-filter.js';
import { CiService } from '../services/ci.service.js';

/** Hoisted out of the metadata literal so the handler can be annotated against them - see
 *  `RmanConfig.ArgsOf` for why an inferred `argv` and the metadata's own typo checking cannot both
 *  work in one signature. */
const COMMAND = 'ci' as const;

const config = {
  ...packageFilterOptions,
  ...branchGuardOptions,
  packageManager: {
    target: 'cli',
    cliName: 'package-manager',
    describe: 'Package manager to install with (default: npm, or .rmanrc "packageManager")',
    choices: CiService.PACKAGE_MANAGERS,
  },
  progress: {
    target: 'cli',
    describe:
      'Show a live progress panel while running (default: true; auto-disabled when not a TTY). ' +
      'Unlike run/build, completion is not reported as a per-package tally - only failures are called out.',
    type: 'boolean',
  },
} satisfies Record<string, CommandOption>;

type Args = ArgsOf<typeof config, typeof COMMAND>;

/**
 * `rman ci` - contributed by the `node` built-in rather than always present.
 *
 * **Declared, not built.** This was a `CustomCommand` with a hand-written `builder` chaining
 * `applyBranchGuardOptions(applyPackageFilterOptions(cmd))`, which is the shape every built-in had
 * before the options became data. A plugin's command uses the identical declaration now -
 * `declareCommand` rather than `registerCommand`, which is the one difference and the reason for
 * it: `registerCommand` pushes onto a module-level registry that `runCli` always walks, so a plugin
 * using it would hand `ci` to repositories that are not Node ones.
 *
 * The repository arrives through `app` when the factory runs (in `cli.ts`, after `Repository.create`
 * has attached one), rather than through a `CommandContext` per invocation.
 */
const ciCommand = declareCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Deletes node_modules and lockfiles in every package, then reinstalls from scratch',
    /** Read, not owned: `packageManager` is a root-level key this package declares in
     *  `NodeConfigKeys`, and the `npm` publish target reads it too. */
    configKeys: ['packageManager'],
    config,
    examples: [{ command: '$0 ci' }],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await CiService.reinstall(repository, {
        ...readPackageFilterOptions(args),
        packageManager: args.packageManager,
        progress: args.progress,
        logLevel: args.logLevel,
      });
    },
  };
});

export default ciCommand;
