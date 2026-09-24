import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import type { Repository } from '../core/repository.js';
import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import type { ListService } from '../services/list.service.js';
import { packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

/** `[options...]` is yargs-meaningless - its variadic marker is two dots, and this command declares
 *  no positional for it. Left as it is rather than fixed in passing: dropping it makes
 *  `rman list foo` start failing, which is a behaviour change and belongs in its own commit. */
const COMMAND = 'list [options...]' as const;

const config = {
  ...packageFilterOptions,
  short: { target: 'cli', alias: 's', describe: 'Do not show extended information', type: 'boolean' },
  parseable: { target: 'cli', alias: 'p', describe: 'Show parseable output', type: 'boolean' },
  toposort: {
    target: 'cli',
    alias: 't',
    describe: 'Sort packages in topological order (dependencies before dependents) instead of lexical by directory',
    type: 'boolean',
  },
  graph: {
    target: 'cli',
    alias: 'g',
    describe: 'Show dependency graph as a JSON-formatted adjacency list',
    type: 'boolean',
    /** Declared on the option instead of as separate `.conflicts()` calls - what a flag is and what
     *  it cannot be combined with end up in one place. */
    conflicts: ['parseable', 'json'],
  },
  json: { target: 'cli', alias: 'j', describe: 'Show output in JSON format', type: 'boolean' },
  changed: {
    target: 'cli',
    alias: 'c',
    describe: 'Only list packages that have changed since the last publish (dirty or committed but not yet published)',
    type: 'boolean',
  },
  changedSince: {
    target: 'cli',
    cliName: 'changed-since',
    describe: 'Only list packages that have changed since the given git commit/hash',
    type: 'string',
    conflicts: 'changed',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const listCommand = registerCommand(app => {
  return {
    command: COMMAND,
    aliases: ['ls'],
    describe: 'Lists packages in repository',
    config,
    examples: [
      { command: '$0 list', description: '# List all packages' },
      { command: '$0 list --json', description: '# List all packages in JSON format' },
    ],
    handler: async (args: Args) => {
      /**
       * **Only the table asks for the root**, and that is why the option exists rather than the
       * service always including it. The table draws a tree, which needs the row its members are
       * nested under; the other four forms are the inventory a script parses, and the inventory is
       * the workspace members - which is also what the count line reports.
       */
      const table = !args.graph && !args.json && !args.parseable && !args.short;
      const items = await app.getService('list').getPackages({
        ...readPackageFilterOptions(args),
        toposort: args.toposort,
        changed: args.changed,
        changedSince: args.changedSince,
        includeRoot: table,
      });

      if (args.graph) printGraph(items);
      else if (args.json) console.log(JSON.stringify(items, undefined, 2));
      else if (args.parseable) printParseable(items);
      else if (args.short) for (const it of items) console.log(it.name);
      /**
       * **Whether a root row was added is asked here, not inferred from the rows.** `isRoot` is
       * true of the one package in a *single-package* repository too - it genuinely is the root -
       * so counting rows that are not the root reported `0 Package(s) found` there (measured). The
       * condition is the same one the service applies, and it is one line.
       */
      else printTable(items, table && app.repository.monorepo);
    },
  };
});

export default listCommand;

function statusLabel(status: Repository.PackageStatus): string {
  switch (status) {
    case 'dirty':
      return colors.magenta('dirty');
    case 'committed':
      return colors.yellow('committed');
    case 'changed':
      return colors.cyan('changed');
    default:
      return '';
  }
}

/**
 * **The tree, as a table**: the root first, then each package indented by how far below it sits.
 *
 * Indentation rather than box-drawing characters, which was the cheaper answer to the same
 * question and stays legible when the output is pasted somewhere without a monospace font, copied
 * into a `--scope` argument, or read by eye for the one name someone is looking for. The nesting is
 * `Item.depth`, a fact about the package - so `--toposort` reorders the rows and leaves each one's
 * indentation telling the truth about where it lives.
 *
 * **`Platform` is a column because a package's technology is now a per-package answer.** A polyglot
 * repository is the whole point of the walk finding nested packages of another platform, and until
 * this column existed `rman list` was the one place that showed every package and could not say
 * which technology each belonged to. Blank rather than a word when none claimed it: `Package.provider`
 * is an empty string there, and inventing `unknown` would read as a technology's name.
 *
 * **The count is the members**, root excluded, which is what `repository.packages` means and what
 * every other form of this command reports.
 */
function printTable(items: ListService.Item[], withRoot: boolean): void {
  const table = new EasyTable();
  for (const it of items) {
    const indent = '  '.repeat(it.depth);
    table.cell('Package', indent + (it.isRoot ? colors.whiteBright(it.selector) : colors.yellowBright(it.selector)));
    table.cell('Version', colors.yellow(it.version));
    table.cell('Platform', it.platform ? colors.cyan(it.platform) : '');
    table.cell('Private', it.private ? colors.magentaBright('yes') : '');
    table.cell('Changed', statusLabel(it.status));
    table.cell('Path', it.location);
    table.newRow();
  }
  console.log(table.toString().trim());
  console.log('');
  console.log(colors.gray(`${items.length - (withRoot ? 1 : 0)} Package(s) found`));
}

function printParseable(items: ListService.Item[]): void {
  for (const it of items) {
    console.log(
      [
        it.location,
        it.name,
        it.version,
        it.private ? 'PRIVATE' : '',
        it.status !== 'clean' ? it.status.toUpperCase() : '',
      ].join('::'),
    );
  }
}

function printGraph(items: ListService.Item[]): void {
  const graph: Record<string, string[]> = {};
  for (const it of items) graph[it.name] = it.dependencies;
  console.log(JSON.stringify(graph, undefined, 2));
}
