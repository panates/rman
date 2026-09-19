import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import type { Repository } from '../core/repository.js';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { ListService } from '../services/list.service.js';
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

const listCommand = registerCommand(repository => ({
  command: COMMAND,
  aliases: ['ls'],
  describe: 'Lists packages in repository',
  config,
  examples: [
    { command: '$0 list', description: '# List all packages' },
    { command: '$0 list --json', description: '# List all packages in JSON format' },
  ],
  handler: async (args: Args) => {
    const items = await ListService.getPackages(repository, {
      ...readPackageFilterOptions(args),
      toposort: args.toposort,
      changed: args.changed,
      changedSince: args.changedSince,
    });

    if (args.graph) printGraph(items);
    else if (args.json) console.log(JSON.stringify(items, undefined, 2));
    else if (args.parseable) printParseable(items);
    else if (args.short) for (const it of items) console.log(it.name);
    else printTable(items);
  },
}));

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

function printTable(items: ListService.Item[]): void {
  const table = new EasyTable();
  for (const it of items) {
    table.cell('Package', colors.yellowBright(it.name));
    table.cell('Version', colors.yellow(it.version));
    table.cell('Private', it.private ? colors.magentaBright('yes') : '');
    table.cell('Changed', statusLabel(it.status));
    table.cell('Path', it.location);
    table.newRow();
  }
  console.log(table.toString().trim());
  console.log('');
  console.log(colors.gray(`${items.length} Package(s) found`));
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
