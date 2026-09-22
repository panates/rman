import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { readRunOptions, runOptions } from '../utils/run-options.js';

const COMMAND = 'run <script>' as const;
const config = runOptions;
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const runCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Run an npm script in each package',
    /**
     * The one command whose `--config` keys depend on argv: the script's own block, whichever script
     * was asked for. Read, not owned - `run.<script>.*` is keyed by script name, so it is the one
     * config shape a flat option map cannot describe and it stays hand-written in `RmanConfig`.
     */
    configKeys: (args: any) => ['run.' + args.script],
    config,
    positionals: {
      script: { describe: 'The script to run', type: 'string' },
    },
    examples: [
      { command: '$0 run build' },
      { command: '$0 run build --changed', description: '# Only in packages changed since the last publish' },
    ],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await app.getService('run').runScript(args.script, { ...readRunOptions(args), commandName: 'run' });
    },
  };
});

export default runCommand;
