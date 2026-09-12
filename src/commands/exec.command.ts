import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { ExecService } from '../services/exec.service.js';
import { applyBranchGuardOptions, assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import type { LogLevel } from '../utils/logger.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'exec [command..]',
    describe: 'Runs an arbitrary shell command in each package - unlike run, not tied to any npm script',
    builder: cmd =>
      applyBranchGuardOptions(applyPackageFilterOptions(cmd))
        .parserConfiguration({ 'populate--': true, 'unknown-options-as-args': true })
        .example('$0 exec rm -rf dist', '# Not an npm script - runs directly in every package')
        .example(
          '$0 exec --scope pkg-a -- ls -la',
          '# "--" needed only if the command shares a flag name with exec\'s own',
        )
        .positional('command', {
          describe:
            "The command (and its own arguments) to run in each package - its own flags don't need to be " +
            'escaped unless one happens to share a name with one of these options below, in which case put ' +
            '"--" first',
          type: 'string',
        })
        .option('parallel', {
          describe:
            'Max packages at once: omit/true for CPU count, a number for that many, false to run serially. ' +
            'Packages always run in dependency order unless --no-topo.',
          coerce: (v: unknown): boolean | number | undefined => {
            if (v === undefined) return undefined;
            if (v === 'false' || v === false) return false;
            if (v === 'true' || v === true) return true;
            const n = Number(v);
            return Number.isFinite(n) ? n : true;
          },
        })
        .option('bail', {
          describe: 'Stop on first failure (default: true)',
          type: 'boolean',
        })
        .option('topo', {
          describe:
            'Respect package dependency order: a package waits for its dependencies and is skipped if one ' +
            'fails. Set false to run in every matching package independently, alphabetically. Default: true.',
          type: 'boolean',
        })
        .option('progress', {
          describe: 'Show a live progress panel (default: true; auto-disabled when not a TTY)',
          type: 'boolean',
        })
        .option('changed', {
          alias: 'c',
          describe: 'Only run in packages that have changed since the last publish',
          type: 'boolean',
        })
        .option('changed-since', {
          describe: 'Only run in packages that have changed since the given git commit/hash',
          type: 'string',
        })
        .option('root', {
          alias: 'r',
          describe:
            'Run across the whole repository even when the current directory is inside a single ' +
            'package (which otherwise scopes the run to just that package). No effect elsewhere.',
          type: 'boolean',
        })
        .conflicts('changed', 'changed-since'),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      const afterDashDash = args['--'] as string[] | undefined;
      const tokens = afterDashDash?.length ? afterDashDash : (args.command as unknown as string[] | undefined);
      if (!tokens?.length) {
        const err: any = new Error('No command given - e.g. "rman exec ls" or "rman exec -- eslint --bail"');
        throw err;
      }
      const command = tokens.join(' ');
      await ExecService.exec(repository, command, {
        ...readPackageFilterOptions(args),
        parallel: args.parallel as boolean | number | undefined,
        topo: args.topo as boolean | undefined,
        bail: args.bail as boolean | undefined,
        progress: args.progress as boolean | undefined,
        changed: args.changed as boolean | undefined,
        changedSince: args.changedSince as string | undefined,
        logLevel: args.logLevel as LogLevel | undefined,
        root: args.root as boolean | undefined,
      });
    },
  });
}
