import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { RunService } from '../services/run.service.js';
import { applyBranchGuardOptions, assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import type { LogLevel } from '../utils/logger.js';
import { applyPackageFilterOptions, applyRootOption, readPackageFilterOptions } from '../utils/package-filter.js';

export function applyRunOptions<T>(cmd: Argv<T>): Argv<T> {
  return applyRootOption(applyBranchGuardOptions(applyPackageFilterOptions(cmd)), 'Run')
    .option('parallel', {
      describe:
        'Max packages to build at once: omit/true for CPU count (or .rmanrc run.<script>.concurrency), ' +
        'a number for that many, false to run serially. Packages always build in dependency order.',
      coerce: (v: unknown): boolean | number | undefined => {
        if (v === undefined) return undefined;
        if (v === 'false' || v === false) return false;
        if (v === 'true' || v === true) return true;
        const n = Number(v);
        return Number.isFinite(n) ? n : true;
      },
    })
    .option('bail', {
      describe: 'Stop on first failure (default: true, overridable per-package via .rmanrc run.<script>.bail)',
      type: 'boolean',
    })
    .option('topo', {
      describe:
        'Respect package dependency order: a package waits for its dependencies and is skipped if one ' +
        'fails. Set false for independent scripts (e.g. lint/test) - order becomes alphabetical and ' +
        'failures never skip other packages. Default: true, overridable per-package via .rmanrc run.<script>.topo.',
      type: 'boolean',
    })
    .option('progress', {
      describe:
        'Show a live progress panel (default: true; auto-disabled when not a TTY; .rmanrc run.<script>.progress)',
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
    .conflicts('changed', 'changed-since');
}

export function readRunOptions(args: any): RunService.Options {
  return {
    ...readPackageFilterOptions(args),
    parallel: args.parallel as boolean | number | undefined,
    topo: args.topo as boolean,
    bail: args.bail as boolean,
    progress: args.progress as boolean,
    changed: args.changed as boolean,
    changedSince: args.changedSince as string | undefined,
    logLevel: args.logLevel as LogLevel | undefined,
    root: args.root as boolean,
  };
}

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'run <script>',
    /** Which `.rmanrc` `--config` shows for this command: the script's own block, whichever
     *  script was asked for. */
    configKeys: (args: any) => ['run.' + args.script],
    describe: 'Run an npm script in each package',
    builder: cmd =>
      applyRunOptions(cmd)
        .example('$0 run build', '')
        .example('$0 run build --changed', '# Only in packages changed since the last publish')
        .positional('script', {
          describe: 'The script to run',
          type: 'string',
        }),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      await RunService.runScript(repository, args.script as string, { ...readRunOptions(args), commandName: 'run' });
    },
  });
}
