import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { CleanService } from '../services/clean.service.js';
import type { LogLevel } from '../utils/logger.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'clean',
    describe: 'Removes compiled TypeScript output and any extra files/dirs configured via .rmanrc "clean"',
    builder: cmd =>
      cmd
        .example('$0 clean', '')
        .example('$0 clean --dry-run', '# Preview what would be removed')
        .option('progress', {
          describe: 'Show a live progress panel (default: true; auto-disabled when not a TTY)',
          type: 'boolean',
        })
        .option('dry-run', {
          describe: 'Report what would be removed without actually removing anything',
          type: 'boolean',
        })
        .option('root', {
          alias: 'r',
          describe:
            'Clean the whole repository even when the current directory is inside a single ' +
            'package (which otherwise scopes cleaning to just that package). No effect elsewhere.',
          type: 'boolean',
        }),
    handler: async args => {
      await CleanService.clean(repository, {
        progress: args.progress as boolean | undefined,
        dryRun: args.dryRun as boolean | undefined,
        root: args.root as boolean | undefined,
        logLevel: args.logLevel as LogLevel | undefined,
      });
    },
  });
}
