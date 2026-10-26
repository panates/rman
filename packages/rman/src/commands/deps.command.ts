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
      { command: '$0 deps --target minor', description: '# Stay inside each major' },
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

      /** Under `-u --json` the document waits for the resolver, so it holds what was really written. */
      if (!args.json) printPlan(all, repository.dirname);
      else if (!args.upgrade) console.log(JSON.stringify(jsonPlan(all), undefined, 2));

      const errors = all.filter(e => e.status === 'error');
      const updates = all.filter(e => e.status === 'update');

      if (!args.upgrade) {
        if (updates.length && !args.json) console.log(colors.gray('\nRun "rman deps -u" to upgrade.'));
        if (errors.length) throw logged(`${errors.length} dependency lookup(s) failed - see above.`);
        return;
      }

      const applied = new Map<DependencyUpdater, DependencyUpdater.Applied>();
      const apply = async (updater: DependencyUpdater, plan: readonly DependencyUpdater.Entry[]) => {
        if (plan.some(e => e.status === 'update')) applied.set(updater, await updater.applyPlan(ctx, plan));
        else applied.delete(updater);
      };
      for (const [updater, plan] of plans) await apply(updater, plan);

      /* A refusal the updater can pin on some of the moves holds those back and asks again with the
       * rest - each round holds at least one, so it ends. One it cannot pin puts everything back. */
      const held: DependencyUpdater.Blame[] = [];
      if (applied.size && args.verify !== false) {
        for (const [updater, packages] of byUpdater) {
          const plan = plans.get(updater)!;
          while (applied.has(updater)) {
            const refused = await updater.verify?.(ctx, packages);
            if (!refused) break;
            const blamed = updater.blame?.(refused, plan).filter(b => b.entry.status === 'update') ?? [];
            applied.get(updater)!.restore();
            applied.delete(updater);
            if (!blamed.length) {
              for (const a of applied.values()) a.restore();
              const shown = refused.split('\n');
              const text = shown.slice(0, 40).join('\n') + (shown.length > 40 ? '\n  ...' : '');
              throw logged(`The upgraded manifests do not install, so they were put back:\n${text}`);
            }
            for (const b of blamed) {
              Object.assign(b.entry, { status: 'held', target: undefined, bump: undefined, reason: b.reason });
              held.push(b);
            }
            await apply(updater, plan);
          }
        }
      }
      const files = [...applied.values()].flatMap(a => a.files);

      if (args.json) console.log(JSON.stringify(jsonPlan(all), undefined, 2));
      else {
        if (held.length) {
          console.log(colors.yellow('\nHeld back - the resolver refused them:'));
          for (const { entry, reason } of held) {
            console.log(`  ${colors.cyan(entry.package.name)} ${entry.name} ${entry.current}  ${colors.gray(reason)}`);
          }
        }
        if (held.length && !files.length) console.log(colors.yellow('Nothing upgraded.'));
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
 * `--target`: one of the version schemes' sizes, and by default the largest.
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
    installed: e.installed,
    installedInRange: e.installedInRange,
    resolved: e.resolved,
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
  const shown = entries.filter(e => e.status !== 'up-to-date' || reinstall(e));
  /** Said first when nothing moves, so a run whose only rows are majors left behind does not read
   *  as a list of things to do. */
  if (!updated.length) {
    const why = [
      ...(shown.some(e => e.status !== 'up-to-date')
        ? ['newer versions their settings leave out, or another rule holds back']
        : []),
      ...(shown.some(reinstall) ? ['installed versions that differ from what the range takes'] : []),
    ];
    console.log(
      colors.green('All dependencies are up to date') + (why.length ? colors.gray(` - ${why.join('; ')}:`) : '.'),
    );
    if (!shown.length) return;
  }

  /** The upgrade last before the note, so the row reads from what is there to what it would become. */
  const header = ['Dependency', 'Current', 'Installed', 'Latest', 'Change', 'Upgrade'];
  const cells = (e: DependencyUpdater.Entry): string[] => [
    e.name,
    e.current,
    e.installed ?? '-',
    e.status === 'error' ? '-' : (e.available ?? e.latest ?? e.resolved ?? ''),
    changeOf(e),
    e.status === 'update' ? (e.target ?? '') : '-',
  ];
  const last = header.length - 1;
  const widths = header.map((h, i) => Math.max(h.length, ...shown.map(e => cells(e)[i]!.length)));
  /** Padded to the column, except a last value nothing follows - trailing spaces inside a colour
   *  code are past the reach of `trimEnd`. */
  const line = (values: string[], paint: (text: string, column: number) => string = text => text) =>
    '  ' + values.map((v, i) => paint(i === values.length - 1 ? v : v.padEnd(widths[i]!), i)).join('  ');

  for (const pkg of [...new Set(shown.map(e => e.package))]) {
    const sizes = pkg.versionScheme.bumpNames;
    const rank = (e: DependencyUpdater.Entry) =>
      e.status === 'update'
        ? sizes.indexOf(e.bump!)
        : sizes.length + ['held', 'skipped', 'error', 'up-to-date'].indexOf(e.status);
    const rows = shown.filter(e => e.package === pkg).sort((x, y) => rank(x) - rank(y));

    const where = path.relative(root, pkg.dirname);
    console.log(colors.cyan(pkg.name) + (where ? colors.gray(` (${where})`) : ''));
    console.log(colors.gray(line([...header, 'Note']).trimEnd()));
    for (const e of rows) {
      const paint = e.status === 'update' ? sizeColor(e.bump, sizes) : changeColor(e.status);
      const values = cells(e);
      const note = e.reason ?? (reinstall(e) ? `"${e.current}" takes ${e.resolved} - install again` : undefined);
      if (note) values[last] = values[last]!.padEnd(widths[last]!);
      const text = line(values, (v, column) => {
        if (column === 2 && e.installedInRange === false) return colors.red(v);
        if (column === 3 && values[3] !== '-') return reachesLatest(e) ? colors.green(v) : colors.yellow(v);
        return column === 4 || column === 5 ? paint(v) : v;
      });
      if (!note) {
        console.log(text);
        continue;
      }
      const indent = 2 + widths.reduce((sum, w) => sum + w + 2, 0);
      const wrapped = wrapNote(note, process.stdout.isTTY ? process.stdout.columns - indent : 0);
      console.log(`${text}  ${wrapped.map(l => colors.gray(l)).join('\n' + ' '.repeat(indent))}`);
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
  if (e.status === 'up-to-date') return reinstall(e) ? 'install' : e.status;
  return e.status === 'update' ? (e.bump ?? 'other') : e.status;
}

/**
 * A range already at the newest version, with something else installed - a `node_modules` behind
 * its manifest. Listed although nothing moves: hidden, it read as up to date while the code ran
 * against the older version.
 */
function reinstall(e: DependencyUpdater.Entry): boolean {
  return e.status === 'up-to-date' && installedDiffers(e);
}

/** What is installed is not what the declared range takes. */
function installedDiffers(e: DependencyUpdater.Entry): boolean {
  return !!e.installed && !!e.resolved && e.installed !== e.resolved;
}

/**
 * Whether this row ends on the newest version - an upgrade that goes all the way, or a range that
 * already takes it. What the Latest column's colour says at a glance: green when it is reached,
 * yellow when the row stops short of it (skipped, held, or an upgrade cut short), so a reader need
 * not go to the note to tell the two apart.
 */
/* **Installed is red only outside the declared range**, never merely behind the newest: a lockfile
 * pinning an older version inside the range is the ordinary state of every row that moves, and
 * colouring it would light up the whole column - the user's first version, yellow everywhere. */
function reachesLatest(e: DependencyUpdater.Entry): boolean {
  if (e.status === 'update') return !e.reason;
  return e.status === 'up-to-date';
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
