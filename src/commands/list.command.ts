import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { ListService } from '../services/list.service.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

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

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'list [options...]',
    aliases: ['ls'],
    describe: 'Lists packages in repository',
    builder: cmd =>
      applyPackageFilterOptions(cmd)
        .example('$0 list', '# List all packages')
        .example('$0 list --json', '# List all packages in JSON format')
        .conflicts('graph', ['parseable', 'json'])
        .conflicts('short', ['parseable', 'json'])
        .conflicts('changed', 'changed-since')
        .option('short', {
          alias: 's',
          describe: 'Do not show extended information',
          type: 'boolean',
        })
        .option('parseable', {
          alias: 'p',
          describe: 'Show parseable output',
          type: 'boolean',
        })
        .option('toposort', {
          alias: 't',
          describe:
            'Sort packages in topological order (dependencies before dependents) instead of lexical by directory',
          type: 'boolean',
        })
        .option('graph', {
          alias: 'g',
          describe: 'Show dependency graph as a JSON-formatted adjacency list',
          type: 'boolean',
        })
        .option('json', {
          alias: 'j',
          describe: 'Show output in JSON format',
          type: 'boolean',
        })
        .option('changed', {
          alias: 'c',
          describe:
            'Only list packages that have changed since the last publish (dirty or committed but not yet published)',
          type: 'boolean',
        })
        .option('changed-since', {
          describe: 'Only list packages that have changed since the given git commit/hash',
          type: 'string',
        }),
    handler: async args => {
      const items = await ListService.getPackages(repository, {
        ...readPackageFilterOptions(args),
        toposort: args.toposort as boolean,
        changed: args.changed as boolean,
        changedSince: args.changedSince as string | undefined,
      });

      if (args.graph) printGraph(items);
      else if (args.json) console.log(JSON.stringify(items, undefined, 2));
      else if (args.parseable) printParseable(items);
      else if (args.short) for (const it of items) console.log(it.name);
      else printTable(items);
    },
  });
}
