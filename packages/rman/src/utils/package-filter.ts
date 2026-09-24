import micromatch from 'micromatch';
import type { Argv } from 'yargs';
import type { Package } from '../core/package.js';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';

/** Shared by every command that iterates packages (`run`/`build`/`test`/`exec`, `list`, `ci`,
 *  `clean`, `version`, `publish`, `changelog`) - narrows *which* packages a command applies to,
 *  independent of what the command actually does to them. The repository's own standing filter,
 *  `.rmanrc "skip"`, is applied by `filterPackages` itself rather than being an option here: it is
 *  the repository's statement, not the caller's. */
export interface PackageFilterOptions {
  /** Only include packages whose name matches at least one of these globs (e.g. `@scope/*`), or
   *  **`"/"`** for the repository's own root package - see `ROOT_SELECTOR`. */
  scope?: string | string[];
  /** Exclude packages whose name matches at least one of these globs (or `"/"`) - applied after
   *  `scope`. */
  ignore?: string | string[];
  /** Also include every package the matched set depends on (transitively) - e.g. to build
   *  everything a scoped app actually needs. */
  deps?: boolean;
  /** Also include every package that depends on the matched set (transitively) - e.g. to test
   *  everything that could be affected by a scoped library's change. */
  dependents?: boolean;
}

/**
 * **`--scope /` is the repository's own root package**, the one selector that is not a glob.
 *
 * The same `/` `.rmanrc`'s `"[/]"` block uses, and for the same reason stated there: *the root is
 * never selected by name.* A glob matches package names, and a name can be anything - so
 * `--scope rman-repo` happened to work (measured) while being exactly the name-based addressing the
 * config selectors were redesigned to remove. `/` is structural, cannot collide with a package
 * (nothing can be named it), and gives "the root" one spelling across config and CLI.
 *
 * Accepted by `--ignore` too. The asymmetry would be the thing to remember, and `--ignore /` -
 * every package but the root - is a real thing to want of `clean`.
 *
 * **It selects nothing on a command whose candidates exclude the root**, which is most of them:
 * `repository.packages` holds the workspace members only, so `rman list --scope /` and
 * `rman run build --scope /` match nothing and say so. That is the honest answer rather than a
 * special case - the root has no `list` row and contributes only `pre`/`post` bookends to `run`.
 * `clean` and `changelog`, which put the root in their candidate list on purpose, are where it bites.
 */
export const ROOT_SELECTOR = '/';

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
    describe: 'Only include packages whose name matches this glob, or "/" for the root package (repeatable)',
    // Deliberately 'string', not 'array': an array-typed option greedily swallows every
    // following bare word as its own value, which would eat "exec"'s [command..] positional
    // whole. yargs still collects repeated "--scope a --scope b" into an array either way.
    type: 'string',
  },
  ignore: {
    target: 'cli',
    describe: 'Exclude packages matching this glob (or "/" for the root) - applied after --scope',
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
 * `--from-root`/`-r` - a group of one, and a function because its text is the command's own word
 * for what it does. Spread it like the others: `...fromRootOption('Build')`.
 *
 * Only where a command scopes by the current directory; see `applyFromRootOption` for why adding it
 * elsewhere is worse than leaving it out.
 *
 * **It was `--root` through 1.x, and the name said the opposite of what it does.** Every reader
 * spells it the same single line - `options.fromRoot ? undefined : repository.currentPackage` - so
 * the flag means *ignore where I am standing*, i.e. the **whole repository**. `--root` reads as "the
 * root alone", which is the narrowest possible set rather than the widest, and the confusion was
 * about to become a contradiction: a `--root-only` beside a `--root` that meant "everything" is
 * unreadable.
 *
 * **`-r` is kept, and a two-letter `-fr` is not possible.** yargs' `short-option-groups` is on by
 * default, so `-fr` parses as `-f -r` and `.strict()` answers `Unknown arguments: f, r` (measured).
 * Turning that off makes `-fr` work and breaks every grouped short - `rman list -sj` works today.
 * So the long name carries the meaning and the incumbent short stays.
 */
export function fromRootOption(verb: string) {
  return {
    fromRoot: {
      target: 'cli',
      cliName: 'from-root',
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
      describe: 'Only include packages whose name matches this glob, or "/" for the root package (repeatable)',
      // Deliberately 'string', not 'array': an array-typed option greedily swallows every
      // following bare word as its own value, which would eat "exec"'s [command..] positional
      // whole. yargs still collects repeated "--scope a --scope b" into an array either way.
      type: 'string',
    })
    .option('ignore', {
      describe: 'Exclude packages matching this glob (or "/" for the root) - applied after --scope',
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
 * syntax via `micromatch` - `*`, `**`, `{a,b}`, ...), plus `ROOT_SELECTOR` (`"/"`) for the root
 * package, which is matched structurally rather than by name; `ignore` is applied after `scope`, on
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
    const selects = selector(options.scope);
    matched = matched.filter(p => selects(p));
  }
  if (options.ignore) {
    const selects = selector(options.ignore);
    matched = matched.filter(p => !selects(p));
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

/**
 * `--from-root`/`-r`, with one describe text instead of four near-identical ones.
 *
 * **It only means anything where a command scopes by the current directory** - `run`/`build`/`test`,
 * `exec`, `clean`, `changelog` and `diff` narrow to `Repository.currentPackage` when you stand
 * inside a package, and this is the escape hatch. On a command that already works across the whole
 * repository (`version`, `publish`, `list`, `changed`) it would be a flag that does nothing, which
 * is worse than not offering it: a no-op flag reads as a promise.
 *
 * That same rule is why there is no `--root-only` beside it, however naturally the pair reads: it
 * would be a no-op on `run`/`build`/`test` (the root is not in `repository.packages` at all and
 * contributes only `pre`/`post` bookends), identical to this flag on `diff`, already what this flag
 * does on `config`, and on `clean` actively misleading - the root's own sweep recurses through
 * `packages/*`, so a `--root-only` there deletes *more* than a package-scoped run, not less
 * (measured). Where the root genuinely is a candidate, `--scope /` says so - see `ROOT_SELECTOR`.
 *
 * `verb` is the command's own word for what it does, so the text stays the sentence each command was
 * already saying.
 */
export function applyFromRootOption<T>(cmd: Argv<T>, verb: string): Argv<T> {
  return cmd.option('from-root', {
    alias: 'r',
    describe:
      `${verb} across the whole repository even when the current directory is inside a single ` +
      'package (which otherwise scopes it to just that package). No effect elsewhere.',
    type: 'boolean',
  });
}

/** The `--from-root` flag as the services read it - beside `readPackageFilterOptions`, so a command
 *  reads both the same way. */
export function readFromRootOption(args: any): boolean | undefined {
  return args.fromRoot as boolean | undefined;
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * One `--scope`/`--ignore` value list as a predicate, with `ROOT_SELECTOR` lifted out of the globs.
 *
 * Split once rather than per package. The root is answered by `wantsRoot` alone and everything else
 * by the globs, so the two never consult each other - and `micromatch` is asked only when a glob is
 * left, since an empty pattern list must match no member rather than all of them, which is what
 * makes a bare `--scope /` select the root **and nothing else**.
 *
 * **A glob is never offered the root**, which is the other half of `ROOT_SELECTOR` and the reason it
 * is not merely a second spelling. `.rmanrc`'s selectors state the same rule - `"[my-*]"` cannot
 * pick up a repository whose root package is called `my-repo`, and `"[*]"` means the members - and
 * the CLI disagreed with it: measured, `rman clean --scope 'rman*'` selected this repository's root.
 * For `clean` that is destructive rather than merely surprising, since the root's own sweep recurses
 * through `packages/*`. Globs are the members, `/` is the root, in both vocabularies.
 */
function selector(value: string | string[]): (pkg: Package) => boolean {
  const patterns = toArray(value);
  const wantsRoot = patterns.includes(ROOT_SELECTOR);
  const globs = patterns.filter(p => p !== ROOT_SELECTOR);
  /** Against `pkg.selector`, which is what `.rmanrc`'s `"[glob]"` matches - one vocabulary, as the
   *  `/` above already is. It was `pkg.name`, and the two coincide for every Node repository; a
   *  package having a name at all is an ecosystem's promise, and a repository can assign a selector
   *  where its own does not offer one. */
  return pkg => (pkg.isRoot ? wantsRoot : globs.length > 0 && micromatch.isMatch(pkg.selector, globs));
}
