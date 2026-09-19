import type { RmanConfig } from '../interfaces/rman-cfg.interface.js';
import type { RunService } from '../services/run.service.js';
import { branchGuardOptions } from './branch-guard.js';
import type { LogLevel } from './logger.js';
import { packageFilterOptions, readPackageFilterOptions, rootOption } from './package-filter.js';

/**
 * Everything `run`, `build` and `test` accept - the package filter, the branch guard, `--root`, and
 * the scheduling flags on top.
 *
 * **In `utils/` rather than in `run.command.ts`, which is where the `Argv` version lived.** `build`
 * and `test` had to import it from a sibling command, which reads as a dependency between commands
 * and is not one: they share a declaration, the way they already share `packageFilterOptions`.
 *
 * Every option is `target: 'cli'`. The `.rmanrc` half of these lives at `run.<script>.concurrency`,
 * `.bail`, `.topo`, `.progress` - keyed by script name, so it is the one config shape that cannot be
 * derived from a flat option map and stays hand-written in `RmanConfig`.
 */
export const runOptions = {
  ...packageFilterOptions,
  ...branchGuardOptions,
  ...rootOption('Run'),
  parallel: {
    target: 'cli',
    describe:
      'Max packages to build at once: omit/true for CPU count (or .rmanrc run.<script>.concurrency), ' +
      'a number for that many, false to run serially. Packages always build in dependency order.',
    /** No `type`: the flag takes a boolean *or* a number, and `coerce` is what says so - which is
     *  also where `OptionValue` reads this option's type from. */
    coerce: (v: unknown): boolean | number | undefined => {
      if (v === undefined) return undefined;
      if (v === 'false' || v === false) return false;
      if (v === 'true' || v === true) return true;
      const n = Number(v);
      return Number.isFinite(n) ? n : true;
    },
  },
  bail: {
    target: 'cli',
    describe: 'Stop on first failure (default: true, overridable per-package via .rmanrc run.<script>.bail)',
    type: 'boolean',
  },
  topo: {
    target: 'cli',
    describe:
      'Respect package dependency order: a package waits for its dependencies and is skipped if one ' +
      'fails. Set false for independent scripts (e.g. lint/test) - order becomes alphabetical and ' +
      'failures never skip other packages. Default: true, overridable per-package via .rmanrc run.<script>.topo.',
    type: 'boolean',
  },
  progress: {
    target: 'cli',
    describe: 'Show a live progress panel (default: true; auto-disabled when not a TTY; .rmanrc run.<script>.progress)',
    type: 'boolean',
  },
  changed: {
    target: 'cli',
    alias: 'c',
    describe: 'Only run in packages that have changed since the last publish',
    type: 'boolean',
  },
  changedSince: {
    target: 'cli',
    cliName: 'changed-since',
    describe: 'Only run in packages that have changed since the given git commit/hash',
    type: 'string',
    /** Declared on the option rather than as a separate `.conflicts()` call - one place says what
     *  this flag is and what it cannot be combined with. */
    conflicts: 'changed',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

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
