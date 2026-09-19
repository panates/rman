import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { readRunOptions, runOptions } from '../utils/run-options.js';

const COMMAND = 'build' as const;
const config = runOptions;
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const buildCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Alias for "run build"',
    /**
     * Read, not owned - and it owns nothing at all. `build` is `run build` under another name, so its
     * settings live in `run.build`, which belongs to `run`. Two commands cannot contribute under one
     * top-level key (interface merging is not a deep merge), and this is why they never needed to.
     */
    configKeys: ['run.build'],
    config,
    examples: [{ command: '$0 build', description: '# Builds packages' }],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await app.getService('run').runScript('build', { ...readRunOptions(args), commandName: 'build' });
    },
  };
});

export default buildCommand;
