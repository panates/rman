import colors from 'ansi-colors';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { VersionPlanService } from '../services/version-plan.service.js';
import { packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

const COMMAND = 'changed' as const;

const config = {
  ...packageFilterOptions,
  json: { target: 'cli', alias: 'j', describe: 'Print output as JSON', type: 'boolean' },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

/** Declares no `target: 'config'` option, so it contributes nothing to `RmanConfig` and writes no
 *  augmentation - a command that owns no config key simply has none. */
const changedCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Shows which packages the next "version" run would bump, without changing anything',
    config,
    examples: [{ command: '$0 changed' }, { command: '$0 changed --json' }],
    handler: async (args: Args) => {
      const plan = await VersionPlanService.getPlanner().getPlan(repository, readPackageFilterOptions(args));
      const changed = plan.filter(e => e.status === 'bump');

      if (args.json) {
        console.log(
          JSON.stringify(
            changed.map(e => ({ name: e.package.name, group: e.group, from: e.from, to: e.to, reason: e.reason })),
            undefined,
            2,
          ),
        );
        return;
      }
      if (!changed.length) {
        console.log(colors.gray('Nothing has changed.'));
        return;
      }
      for (const e of changed) {
        console.log(
          colors.green('changed'),
          colors.cyan(e.package.name),
          colors.gray(`(${e.group})`),
          e.from,
          '->',
          colors.yellow(e.to!),
        );
      }
    },
  };
});

export default changedCommand;
