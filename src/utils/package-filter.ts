import micromatch from 'micromatch';
import type { Argv } from 'yargs';
import type { Package } from '../core/package.js';

/** Shared by every command that iterates packages (`run`/`build`/`test`/`exec`, `list`, `ci`,
 *  `clean`, `version`, `publish`, `changelog`) - narrows *which* packages a command applies to,
 *  independent of what the command actually does to them. */
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
 */
export function filterPackages(packages: Package[], options: PackageFilterOptions): Package[] {
  let matched = packages;
  if (options.scope) {
    const patterns = toArray(options.scope);
    matched = matched.filter(p => micromatch.isMatch(p.name, patterns));
  }
  if (options.ignore) {
    const patterns = toArray(options.ignore);
    matched = matched.filter(p => !micromatch.isMatch(p.name, patterns));
  }
  if (!options.deps && !options.dependents) return matched;

  const included = new Set(matched.map(p => p.name));
  if (options.deps) {
    for (const p of matched) for (const dep of p.dependencies) included.add(dep);
  }
  if (options.dependents) {
    const matchedNames = new Set(matched.map(p => p.name));
    for (const p of packages) {
      if (p.dependencies.some(d => matchedNames.has(d))) included.add(p.name);
    }
  }
  return packages.filter(p => included.has(p.name));
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}
