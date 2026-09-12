import path from 'node:path';
import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { ImportService } from '../services/import.service.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'import <path>',
    describe: 'Imports an external git repository as a new package, preserving its full commit history',
    builder: cmd =>
      cmd
        .example('$0 import ../my-old-repo', '')
        .example('$0 import ../my-old-repo --dest libs', '# Under libs/ instead of packages/')
        .positional('path', {
          describe: 'Path to a local clone of the repository to import (not a URL - clone it first)',
          type: 'string',
        })
        .option('dest', {
          describe: 'Subdirectory the new package is placed under (default: "packages")',
          type: 'string',
        }),
    handler: async args => {
      const result = await ImportService.importRepo(repository, args.path as string, {
        dest: args.dest as string | undefined,
      });
      console.log(
        colors.green('imported'),
        colors.cyan(result.name),
        '->',
        path.relative(repository.dirname, result.targetDir),
        colors.gray(`(${result.commitCount} commit(s))`),
      );
      console.log(colors.gray('Add it to your workspaces glob if it is not already covered, then reinstall ("ci").'));
    },
  });
}
