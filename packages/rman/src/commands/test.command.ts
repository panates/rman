import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { readRunOptions, runOptions } from '../utils/run-options.js';

const COMMAND = 'test' as const;
const config = runOptions;
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const testCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Alias for "run test"',
    /** Owns nothing, for the same reason `build` does not - see there. */
    configKeys: ['run.test'],
    config,
    examples: [{ command: '$0 test', description: '# Tests packages' }],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await app.getService('run').runScript('test', { ...readRunOptions(args), commandName: 'test' });
    },
  };
});

export default testCommand;
