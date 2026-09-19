import micromatch from 'micromatch';
import type { Argv } from 'yargs';
import type { Package } from '../core/package.js';
import type { RmanConfig } from '../interfaces/rman-cfg.interface.js';

/** Shared by every command that iterates packages (`run`/`build`/`test`/`exec`, `list`, `ci`,
 *  `clean`, `version`, `publish`, `changelog`) - narrows *which* packages a command applies to,
 *  independent of what the command actually does to them. The repository's own standing filter,
 *  `.rmanrc "skip"`, is applied by `filterPackages` itself rather than being an option here: it is
 *  the repository's statement, not the caller's. */
export interface PackageFilterOptions {
  /** Only include packages whose name matches at least one of these globs (e.g. `@scope/*`). */
  scope?: string | string[];
  /** Exclude packages whose name matches at least one of these globs - applied after `scope`. */
  ignore?: string | string[];
  /** Also include every package the matched set depends on (transitively) - e.g. to build
   *  everything a scoped app actually needs. */
  deps?: boolean;
  /** Also include every package that depends on the matched set (transitively) - e.g. to test
   *  everything that could be affected by a scoped library's change. */
  dependents?: boolean;
}

/**
 * `--scope`/`--ignore`/`--deps`/`--dependents` as a **declaration** rather than a builder call -
 * spread into a command's `config` block:
 *
 * ```ts
 * config: { ...packageFilterOptions, ...branchGuardOptions, changelog: { ... } }
 * ```
 *
 * **`satisfies`, never a `: Record<...>` annotation.** An annotation widens `type: 'string'` back to
 * `string`, and every type derived from the declaration - the config contribution, the option's own
 * value type - collapses with it. `satisfies` checks the shape and keeps the literals, and it also
 * catches a misspelled key *here*, at the group's own line, rather than in the ten commands that
 * spread it. The `Argv` chaining this replaces could not: a typo there was simply a new option.
 *
 * **Every option is `target: 'cli'`, including the ones that have a config twin.** A shared group
 * belongs to no command, so declaring one `'both'` would contribute `version.scope` - a key nothing
 * reads. Where a `.rmanrc` equivalent exists it is a core key in its own right (`allowBranch`), and
 * a command that reads it names it in `configKeys`.
 */
export const packageFilterOptions = {
  scope: {
    target: 'cli',
    describe: 'Only include packages whose name matches this glob (repeatable)',
    // Deliberately 'string', not 'array': an array-typed option greedily swallows every
    // following bare word as its own value, which would eat "exec"'s [command..] positional
    // whole. yargs still collects repeated "--scope a --scope b" into an array either way.
    type: 'string',
  },
  ignore: {
    target: 'cli',
    describe: 'Exclude packages whose name matches this glob (repeatable) - applied after --scope',
    type: 'string',
  },
  deps: {
    target: 'cli',
    describe: 'Also include every package the matched set depends on',
    type: 'boolean',
  },
  dependents: {
    target: 'cli',
    describe: 'Also include every package that depends on the matched set',
    type: 'boolean',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

/**
 * `--root`/`-r` - a group of one, and a function because its text is the command's own word for
 * what it does. Spread it like the others: `...rootOption('Build')`.
 *
 * Only where a command scopes by the current directory; see `applyRootOption` for why adding it
 * elsewhere is worse than leaving it out.
 */
export function rootOption(verb: string) {
  return {
    root: {
      target: 'cli',
      alias: 'r',
      describe:
        `${verb} across the whole repository even when the current directory is inside a single ` +
        'package (which otherwise scopes it to just that package). No effect elsewhere.',
      type: 'boolean',
    },
  } satisfies Record<string, RmanConfig.CommandOption>;
}

/** `--scope`/`--ignore`/`--deps`/`--dependents`, the same shape and describe text in every command
 *  that supports them - mirrors `run.command.ts`'s own `applyRunOptions`. */
export function applyPackageFilterOptions<T>(cmd: Argv<T>): Argv<T> {
  return cmd
    .option('scope', {
      describe: 'Only include packages whose name matches this glob (repeatable)',
      // Deliberately 'string', not 'array': an array-typed option greedily swallows every
      // following bare word as its own value, which would eat "exec"'s [command..] positional
      // whole. yargs still collects repeated "--scope a --scope b" into an array either way.
      type: 'string',
    })
    .option('ignore', {
      describe: 'Exclude packages whose name matches this glob (repeatable) - applied after --scope',
      type: 'string',
    })
    .option('deps', {
      describe: 'Also include every package the matched set depends on',
      type: 'boolean',
    })
    .option('dependents', {
      describe: 'Also include every package that depends on the matched set',
      type: 'boolean',
    });
}

export function readPackageFilterOptions(args: any): PackageFilterOptions {
  return {
    scope: args.scope as string[] | undefined,
    ignore: args.ignore as string[] | undefined,
    deps: args.deps as boolean | undefined,
    dependents: args.dependents as boolean | undefined,
  };
}

/**
 * Narrows `packages` (the full, already-resolved list - toposort order, if any, is preserved)
 * down to what `options` selects. `scope`/`ignore` match against each package's bare name (glob
 * syntax via `micromatch` - `*`, `**`, `{a,b}`, ...); `ignore` is applied after `scope`, on
 * whatever it left. `deps`/`dependents` then each independently expand *that* matched set along
 * `Package.dependencies` (already the full transitive closure - see
 * `Repository`'s own `_updateDependencies`) and their results are unioned in - so `--deps
 * --dependents` together never re-expands one direction's additions through the other, which
 * would otherwise tend to blow up toward "the whole repository" for any reasonably-connected graph.
 *
 * A package excluded by its own `.rmanrc "skip"` is dropped **first**, before any of that - so
 * `--deps` never drags a skipped package back in through a dependency edge.
 */
export function filterPackages(
  packages: Package[],
  options: PackageFilterOptions,
  /**
   * Whether each package's own `.rmanrc "skip"` applies. Default `true`: every command that *acts*
   * on packages honours it, which is the point of one standing "leave this package alone" instead
   * of a separate `skip` invented per command.
   *
   * `list` passes `false` - an inventory that hides part of the repository is answering a different
   * question than the one asked. That is the only caller that does, and it is the test for whether a
   * new command should: does it *do* something to the packages, or does it *report* on them?
   */
  applySkip = true,
): Package[] {
  let matched = applySkip ? packages.filter(p => p.config?.skip !== true) : packages;
  if (options.scope) {
    const patterns = toArray(options.scope);
    matched = matched.filter(p => micromatch.isMatch(p.name, patterns));
  }
  if (options.ignore) {
    const patterns = toArray(options.ignore);
    matched = matched.filter(p => !micromatch.isMatch(p.name, patterns));
  }
  if (!options.deps && !options.dependents) return matched;

  /** A set of packages, not of names: `Package.dependencies` holds references now, so identity is
   *  what these comparisons are about. */
  const included = new Set<Package>(matched);
  if (options.deps) {
    for (const p of matched) for (const dep of p.dependencies) included.add(dep);
  }
  if (options.dependents) {
    const matchedSet = new Set(matched);
    for (const p of packages) {
      if (p.dependencies.some(d => matchedSet.has(d))) included.add(p);
    }
  }
  return packages.filter(p => included.has(p));
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * `--root`/`-r`, with one describe text instead of four near-identical ones.
 *
 * **It only means anything where a command scopes by the current directory** - `run`/`build`/`test`,
 * `exec`, `clean`, `changelog` and `diff` narrow to `Repository.currentPackage` when you stand
 * inside a package, and this is the escape hatch. On a command that already works across the whole
 * repository (`version`, `publish`, `list`, `changed`) it would be a flag that does nothing, which
 * is worse than not offering it: a no-op flag reads as a promise.
 *
 * `verb` is the command's own word for what it does, so the text stays the sentence each command was
 * already saying.
 */
export function applyRootOption<T>(cmd: Argv<T>, verb: string): Argv<T> {
  return cmd.option('root', {
    alias: 'r',
    describe:
      `${verb} across the whole repository even when the current directory is inside a single ` +
      'package (which otherwise scopes it to just that package). No effect elsewhere.',
    type: 'boolean',
  });
}

/** The `--root` flag as the services read it - beside `readPackageFilterOptions`, so a command
 *  reads both the same way. */
export function readRootOption(args: any): boolean | undefined {
  return args.root as boolean | undefined;
}
