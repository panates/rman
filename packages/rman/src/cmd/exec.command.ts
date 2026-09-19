import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { ExecService } from '../services/exec.service.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { readPackageFilterOptions } from '../utils/package-filter.js';
import { runOptions } from '../utils/run-options.js';

const COMMAND = 'exec [command..]' as const;

/**
 * `runOptions` with three texts replaced - the override case the spread order exists for.
 *
 * `exec` takes the same scheduling flags as `run`, but not the same *explanations*: `run`'s mention
 * `.rmanrc run.<script>.bail` and friends, and `exec` runs no script, so there is no such block to
 * point at. The declarations are shared; only the sentences that would be untrue differ.
 */
const config = {
  ...runOptions,
  bail: { target: 'cli', describe: 'Stop on first failure (default: true)', type: 'boolean' },
  topo: {
    target: 'cli',
    describe:
      'Respect package dependency order: a package waits for its dependencies and is skipped if one ' +
      'fails. Set false to run in every matching package independently, alphabetically. Default: true.',
    type: 'boolean',
  },
  progress: {
    target: 'cli',
    describe: 'Show a live progress panel (default: true; auto-disabled when not a TTY)',
    type: 'boolean',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const execCommand = registerCommand(repository => ({
  command: COMMAND,
  describe: 'Runs an arbitrary shell command in each package - unlike run, not tied to any npm script',
  /**
   * The two parser switches this command cannot work without: `populate--` keeps everything after
   * `--` out of `exec`'s own options, and `unknown-options-as-args` passes the flags of the command
   * being run through untouched.
   */
  parserConfiguration: { 'populate--': true, 'unknown-options-as-args': true },
  config,
  positionals: {
    command: {
      describe:
        "The command (and its own arguments) to run in each package - its own flags don't need to be " +
        'escaped unless one happens to share a name with one of these options below, in which case put ' +
        '"--" first',
      type: 'string',
    },
  },
  examples: [
    { command: '$0 exec rm -rf dist', description: '# Not an npm script - runs directly in every package' },
    {
      command: '$0 exec --scope pkg-a -- ls -la',
      description: '# "--" needed only if the command shares a flag name with exec\'s own',
    },
  ],
  handler: async (args: Args) => {
    await assertAllowedBranch(repository, readBranchGuardOptions(args));
    const afterDashDash = args['--'];
    /** `command` is variadic (`[command..]`), so it arrives as a list - `ArgsOf` reads that off the
     *  command string rather than being told. */
    const tokens = afterDashDash?.length ? afterDashDash.map(String) : args.command;
    if (!tokens?.length) {
      const err: any = new Error('No command given - e.g. "rman exec ls" or "rman exec -- eslint --bail"');
      throw err;
    }
    await ExecService.exec(repository, tokens.join(' '), {
      ...readPackageFilterOptions(args),
      parallel: args.parallel,
      topo: args.topo,
      bail: args.bail,
      progress: args.progress,
      changed: args.changed,
      changedSince: args.changedSince,
      logLevel: args.logLevel,
      root: args.root,
    });
  },
}));

export default execCommand;
