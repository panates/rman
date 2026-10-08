import path from 'node:path';
import colors from 'ansi-colors';
import type { RmanApplication } from '../core/application.js';
import type { Package } from '../core/classes/package.js';
import { semverScheme } from '../core/classes/version-scheme.js';
import { DependencyUpdater } from '../core/interfaces/dependency-updater.js';
import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import { filterPackages, packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

/** Hoisted for `ArgsOf` - see `version.command.ts` and `RmanConfig.ArgsOf` for why. */
const COMMAND = 'deps [names..]' as const;

const { scope, ignore, platform } = packageFilterOptions;

const config = {
  /* `--deps`/`--dependents` are left out: on a command called `deps`, `rman deps --deps` would read
   * as something other than "and the packages these depend on". */
  scope,
  ignore,
  platform,
  upgrade: {
    target: 'cli',
    alias: 'u',
    describe: 'Write the new ranges to the manifests, then check that they still install',
    type: 'boolean',
  },
  /** Its `choices` and its default are the version schemes' own sizes, so they are filled in where
   *  the command is built - see `targetOption`. */
  target: {
    target: 'both',
    describe: 'The largest move a dependency may make',
    type: 'string',
  },
  reject: {
    target: 'both',
    describe: 'Leave the dependencies matching these globs alone (repeatable)',
    type: 'string',
    array: true,
  },
  minAge: {
    target: 'both',
    cliName: 'min-age',
    describe: 'Only move to a version published at least this many days ago',
    type: 'number',
  },
  types: {
    target: 'config',
    describe: "The dependency kinds to look at, in the ecosystem's own words - default: every kind",
    type: 'string',
    array: true,
  },
  concurrency: {
    target: 'cli',
    describe: `How many registry lookups run at once (default: ${defaultConcurrency()})`,
    type: 'number',
  },
  verify: {
    target: 'cli',
    describe: "After --upgrade, ask the ecosystem's own resolver whether the result installs (default: true)",
    type: 'boolean',
  },
  json: {
    target: 'cli',
    alias: 'j',
    describe: 'Print the plan as JSON - one entry per package and dependency',
    type: 'boolean',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

/**
 * `rman deps` - which dependencies have a newer version, and with `--upgrade`, moving them there.
 *
 * A version is offered only when every rule that can be seen allows it: the package's own
 * `deps.target`/`reject`/`minAge`, the peer ranges of the other dependencies it names, the runtime
 * the package supports, and what its sibling packages ask of a shared dependency. Each version held
 * back is printed with the rule that held it.
 */
/* **The command is the core's and the answer is the technology's** - see `DependencyUpdater`. A
 * package whose platform has no updater is left alone, which in a polyglot repository is the right
 * answer for the half rman cannot speak for. */
const depsCommand = registerCommand(app => {
  const repository = app.repository;

  return {
    command: COMMAND,
    describe: 'Lists the dependencies that have a newer version - pass -u to upgrade them',
    config: { ...config, target: targetOption(app) },
    positionals: {
      names: { describe: 'Only these dependencies (globs)', type: 'string' },
    },
    examples: [
      { command: '$0 deps', description: '# What could move, and what holds it back' },
      { command: '$0 deps -u', description: '# Write the new ranges, then check that they install' },
      { command: '$0 deps --target major', description: '# Across a major too' },
      { command: '$0 deps "@types/*"', description: '# Only the dependencies matching this glob' },
    ],
    handler: async (args: Args) => {
      const options: DependencyUpdater.Options = {
        names: args.names?.length ? args.names.map(String) : undefined,
        target: args.target,
        reject: args.reject?.map(String),
        minAge: args.minAge,
        concurrency: Math.max(1, args.concurrency ?? defaultConcurrency()),
      };
      const ctx: DependencyUpdater.Context = { app, repository, options };

      /** The root holds a monorepo's shared tooling, so it is asked too. */
      const candidates = repository.monorepo ? [repository.rootPackage, ...repository.packages] : repository.packages;
      const selected = filterPackages([...candidates], readPackageFilterOptions(args));
      if (!selected.length) throw logged('No package matched.');

      const byUpdater = new Map<DependencyUpdater, Package[]>();
      for (const pkg of selected) {
        const updater = pkg.platform.dependencyUpdater;
        if (!updater) continue;
        byUpdater.set(updater, [...(byUpdater.get(updater) ?? []), pkg]);
      }
      if (!byUpdater.size) {
        throw logged('None of the selected packages belongs to a technology that can update its dependencies.');
      }

      const plans = new Map<DependencyUpdater, DependencyUpdater.Entry[]>();
      for (const [updater, packages] of byUpdater) plans.set(updater, await updater.getPlan(ctx, packages));
      const all = [...plans.values()].flat();

      if (args.json) console.log(JSON.stringify(jsonPlan(all), undefined, 2));
      else printPlan(all, repository.dirname);

      const errors = all.filter(e => e.status === 'error');
      const updates = all.filter(e => e.status === 'update');

      if (!args.upgrade) {
        if (updates.length && !args.json) console.log(colors.gray('\nRun "rman deps -u" to upgrade.'));
        if (errors.length) throw logged(`${errors.length} dependency lookup(s) failed - see above.`);
        return;
      }

      const applied: DependencyUpdater.Applied[] = [];
      for (const [updater, plan] of plans) {
        if (plan.some(e => e.status === 'update')) applied.push(await updater.applyPlan(ctx, plan));
      }
      const files = applied.flatMap(a => a.files);

      if (files.length && args.verify !== false) {
        for (const [updater, packages] of byUpdater) {
          const refused = await updater.verify?.(ctx, packages);
          if (!refused) continue;
          for (const a of applied) a.restore();
          throw logged(`The upgraded manifests do not install, so they were put back:\n${refused}`);
        }
      }

      if (!args.json) {
        for (const file of files) console.log(colors.green('updated'), path.relative(repository.dirname, file));
      }
      if (errors.length) throw logged(`${errors.length} dependency lookup(s) failed - see above.`);
    },
  };
});

export default depsCommand;

/** The rest of `deps.*` - what an option cannot describe. */
export interface DepsExtraKeys {
  /**
   * The largest move for the dependencies a glob matches, ahead of `target` - a package that
   * releases a major every few weeks, or one that has stayed on `0.x` for years, where a `0.x`
   * minor counts as a major. The last glob matching a name wins.
   *
   * @example { "@types/node": "major", "esbuild": "major" }
   */
  targets?: Record<string, string>;
}

/** `deps`'s own keys on `RmanConfig`: derived from the `config` block, plus `DepsExtraKeys`. */
declare module '../interfaces/rman-config.interface.js' {
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<ReturnType<typeof depsCommand>, DepsExtraKeys> {}
  }
}

/** Registry lookups are child processes waiting on the network, not CPU work, so the default is a
 *  fixed number rather than the core count. */
function defaultConcurrency(): number {
  return 16;
}

/**
 * `--target`: one of the version schemes' sizes, and by default every size but the largest.
 *
 * Read off the technologies this repository loaded rather than written down, because the sizes are
 * a scheme's - semver's three are the only ones today.
 */
function targetOption(app: RmanApplication): typeof config.target & { choices: string[] } {
  const schemes = [...app.platforms].map(p => p.manifestProvider.versionScheme ?? semverScheme);
  const sizes = [...new Set((schemes.length ? schemes : [semverScheme]).flatMap(s => s.bumpNames))];
  const defaults = [...new Set(schemes.map(s => DependencyUpdater.defaultTarget(s.bumpNames)))];
  return {
    ...config.target,
    describe: `${config.target.describe} (default: ${defaults.join(' / ') || DependencyUpdater.defaultTarget(semverScheme.bumpNames)})`,
    choices: sizes,
  };
}

function jsonPlan(entries: readonly DependencyUpdater.Entry[]) {
  return entries.map(e => ({
    package: e.package.name,
    name: e.name,
    types: e.types,
    status: e.status,
    current: e.current,
    target: e.target,
    latest: e.latest,
    available: e.available,
    bump: e.bump,
    reason: e.reason,
  }));
}

/**
 * One table per package with something to say, under a header: what each dependency would move to
 * and how far, and for one that stays, the newest release and why it is not taken.
 */
/* **One row per dependency, the change a column.** It was a list per size (`patch`, `minor`) and a
 * second list headed "not updated" - wrong for a command that, without `-u`, updates nothing, and a
 * dependency that moved part of the way appeared in both. The `Change` column says what a row is:
 * the size of the move, or `held` (another dependency's rule refuses it), `skipped` (the package's
 * own settings leave the newer version out) or `error`. Moves first, smallest first, then the rest. */
function printPlan(entries: readonly DependencyUpdater.Entry[], root: string): void {
  const updated = entries.filter(e => e.status === 'update');
  const shown = entries.filter(e => e.status !== 'up-to-date');
  /** Said first when nothing moves, so a run whose only rows are majors left behind does not read
   *  as a list of things to do. */
  if (!updated.length) {
    console.log(
      colors.green('All dependencies are up to date') +
        (shown.length ? colors.gray(' - newer versions their settings leave out, or another rule holds back:') : '.'),
    );
    if (!shown.length) return;
  }

  const header = ['Dependency', 'Current', 'Upgrade', 'Latest', 'Change'];
  const cells = (e: DependencyUpdater.Entry): string[] => [
    e.name,
    e.current,
    e.status === 'update' ? (e.target ?? '') : '-',
    e.status === 'error' ? '-' : (e.available ?? e.latest ?? ''),
    changeOf(e),
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...shown.map(e => cells(e)[i]!.length)));
  /** Padded to the column, except a last value nothing follows - trailing spaces inside a colour
   *  code are past the reach of `trimEnd`. */
  const line = (values: string[], paint: (text: string, column: number) => string = text => text) =>
    '  ' + values.map((v, i) => paint(i === values.length - 1 ? v : v.padEnd(widths[i]!), i)).join('  ');

  for (const pkg of [...new Set(shown.map(e => e.package))]) {
    const sizes = pkg.versionScheme.bumpNames;
    const rank = (e: DependencyUpdater.Entry) =>
      e.status === 'update' ? sizes.indexOf(e.bump!) : sizes.length + ['held', 'skipped', 'error'].indexOf(e.status);
    const rows = shown.filter(e => e.package === pkg).sort((x, y) => rank(x) - rank(y));

    const where = path.relative(root, pkg.dirname);
    console.log(colors.cyan(pkg.name) + (where ? colors.gray(` (${where})`) : ''));
    console.log(colors.gray(line([...header, 'Note']).trimEnd()));
    for (const e of rows) {
      const paint = e.status === 'update' ? sizeColor(e.bump, sizes) : changeColor(e.status);
      const values = cells(e);
      if (e.reason) values[4] = values[4]!.padEnd(widths[4]!);
      const text = line(values, (v, column) => (column === 2 || column === 4 ? paint(v) : v));
      if (!e.reason) {
        console.log(text);
        continue;
      }
      const indent = 2 + widths.reduce((sum, w) => sum + w + 2, 0);
      const note = wrapNote(e.reason, process.stdout.isTTY ? process.stdout.columns - indent : 0);
      console.log(`${text}  ${note.map(l => colors.gray(l)).join('\n' + ' '.repeat(indent))}`);
    }
  }
}

/**
 * A note cut into lines of at most `width` characters, at spaces, so a long one continues under its
 * own column instead of wrapping to the terminal's left edge. One line when `width` is too narrow to
 * be worth it, or 0 - output that is not a terminal has no edge to wrap at.
 */
function wrapNote(note: string, width: number): string[] {
  if (width < 20 || note.length <= width) return [note];
  const lines: string[] = [];
  let current = '';
  for (const word of note.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

/** What the `Change` column says: the size of the move, or why there is none. */
function changeOf(e: DependencyUpdater.Entry): string {
  return e.status === 'update' ? (e.bump ?? 'other') : e.status;
}

/** `held` and `skipped` in yellow, an error in red - a row with no move to colour by size. */
function changeColor(status: DependencyUpdater.Entry['status']): (text: string) => string {
  return status === 'error' ? colors.red : colors.yellow;
}

/** The colours `npm-check-updates` uses - the largest size red, the next cyan, the rest green - read
 *  off the scheme's own order so a scheme with other names still gets them. */
function sizeColor(size: string | undefined, sizes: readonly string[]): (text: string) => string {
  const rank = size ? sizes.indexOf(size) : -1;
  if (rank === sizes.length - 1) return colors.red;
  if (rank === sizes.length - 2) return colors.cyan;
  return colors.green;
}

/** The `logged` convention: printed here, so `runCli`'s catch does not print it a second time. */
function logged(message: string): Error {
  console.error(colors.red(message));
  const err: any = new Error(message);
  err.logged = true;
  return err;
}
