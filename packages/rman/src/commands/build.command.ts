import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { RunService } from '../services/run.service.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { applyRunOptions, readRunOptions } from './run.command.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'build',
    configKeys: ['run.build'],
    describe: 'Alias for "run build"',
    builder: cmd => applyRunOptions(cmd).example('$0 build', '# Builds packages'),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await RunService.runScript(repository, 'build', { ...readRunOptions(args), commandName: 'build' });
    },
  });
}
