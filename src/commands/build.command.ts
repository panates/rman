import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { RunService } from '../services/run.service.js';
import { applyRunOptions, readRunOptions } from './run.command.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'build',
    describe: 'Alias for "run build"',
    builder: cmd => applyRunOptions(cmd).example('$0 build', '# Builds packages'),
    handler: async args => {
      await RunService.runScript(repository, 'build', { ...readRunOptions(args), commandName: 'build' });
    },
  });
}
