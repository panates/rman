import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { RunService } from '../services/run.service.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { applyRunOptions, readRunOptions } from './run.command.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'test',
    describe: 'Alias for "run test"',
    builder: cmd => applyRunOptions(cmd).example('$0 test', '# Tests packages'),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await RunService.runScript(repository, 'test', { ...readRunOptions(args), commandName: 'test' });
    },
  });
}
