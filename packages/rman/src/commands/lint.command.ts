import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import { assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { readRunOptions, runOptions } from '../utils/run-options.js';

const COMMAND = 'lint' as const;
const config = runOptions;
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

/**
 * `rman lint` - an alias for `rman run lint`, the third of the trio beside `build` and `test`.
 */
/* **Core, not the `node` preset, and the test is what the command *knows*.** It knows a script
 * name and nothing else: a Cargo repository declaring `lint: 'cargo clippy'` and a Go one
 * declaring `golangci-lint run` are served by exactly this file. That is the line `clean` is on the
 * other side of - everything `clean` knows how to delete is a TypeScript fact - and it is why
 * `build` and `test` are here too.
 *
 * **It owns no config key**, for the reason `build` documents: `lint` is `run lint` under another
 * name, so its settings are `run.lint`, which belongs to `run`. Two commands cannot contribute
 * under one top-level key - interface merging is not a deep merge - and these three never needed
 * to. */
const lintCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Alias for "run lint"',
    /** Read, not owned - see the note above. */
    configKeys: ['run.lint'],
    config,
    examples: [{ command: '$0 lint', description: '# Lints packages' }],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await app.getService('run').runScript('lint', { ...readRunOptions(args), commandName: 'lint' });
    },
  };
});

export default lintCommand;
