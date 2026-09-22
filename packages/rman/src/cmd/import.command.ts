import path from 'node:path';
import colors from 'ansi-colors';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';

const COMMAND = 'import <path>' as const;

const config = {
  dest: {
    target: 'cli',
    describe: 'Subdirectory the new package is placed under (default: "packages")',
    type: 'string',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const importCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Imports an external git repository as a new package, preserving its full commit history',
    config,
    positionals: {
      path: {
        describe: 'Path to a local clone of the repository to import (not a URL - clone it first)',
        type: 'string',
      },
    },
    examples: [
      { command: '$0 import ../my-old-repo' },
      { command: '$0 import ../my-old-repo --dest libs', description: '# Under libs/ instead of packages/' },
    ],
    handler: async (args: Args) => {
      const result = await app.getService('import').importRepo(args.path, { dest: args.dest });
      console.log(
        colors.green('imported'),
        colors.cyan(result.name),
        '->',
        path.relative(repository.dirname, result.targetDir),
        colors.gray(`(${result.commitCount} commit(s))`),
      );
      console.log(colors.gray('Add it to your workspaces glob if it is not already covered, then reinstall ("ci").'));
    },
  };
});

export default importCommand;
