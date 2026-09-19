import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { RunService } from '../services/run.service.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { readRunOptions, runOptions } from '../utils/run-options.js';

const COMMAND = 'test' as const;
const config = runOptions;
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const testCommand = registerCommand(repository => ({
  command: COMMAND,
  describe: 'Alias for "run test"',
  /** Owns nothing, for the same reason `build` does not - see there. */
  configKeys: ['run.test'],
  config,
  examples: [{ command: '$0 test', description: '# Tests packages' }],
  handler: async (args: Args) => {
    await assertAllowedBranch(repository, readBranchGuardOptions(args));
    await RunService.runScript(repository, 'test', { ...readRunOptions(args), commandName: 'test' });
  },
}));

export default testCommand;
