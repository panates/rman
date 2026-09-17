import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { VersionPlanService } from '../services/version-plan.service.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'changed',
    describe: 'Shows which packages the next "version" run would bump, without changing anything',
    builder: cmd =>
      applyPackageFilterOptions(cmd).example('$0 changed', '').example('$0 changed --json', '').option('json', {
        alias: 'j',
        describe: 'Print output as JSON',
        type: 'boolean',
      }),
    handler: async args => {
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
  });
}
