import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { ChangelogService } from '../services/changelog.service.js';
import { Logger, type LogLevel, resolveRootLogLevel } from '../utils/logger.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'changelog',
    describe: 'Generates a changelog per package from unreleased commits',
    builder: cmd =>
      applyPackageFilterOptions(cmd)
        .example('$0 changelog', "# Auto-detects each package's last published version on npm")
        .example('$0 changelog --from <hash> --write', '# Since a specific commit, written to file')
        .option('from', {
          describe:
            'Generate the changelog since this commit/hash, applied the same way to every package. ' +
            'Default (also "npm" explicitly): auto-detect per package from its published npm version, ' +
            "falling back to not-yet-pushed commits for a package that can't be resolved this way",
          type: 'string',
        })
        .option('write', {
          describe: "Prepend the entry into each package's own changelog file instead of printing it",
          type: 'boolean',
        })
        .option('file-path', {
          describe:
            "With --write, the file to prepend into, relative to each package's own directory " +
            '(default: "CHANGELOG.md", or .rmanrc "changelog.filePath")',
          type: 'string',
        })
        .option('root', {
          alias: 'r',
          describe:
            'Generate for the whole repository even when the current directory is inside a single ' +
            'package (which otherwise scopes it to just that package). No effect elsewhere.',
          type: 'boolean',
        }),
    handler: async args => {
      const from = args.from as string | undefined;
      const write = args.write as boolean | undefined;
      const logger = new Logger((args.logLevel as LogLevel | undefined) ?? resolveRootLogLevel(repository));

      if (!from || from === 'npm') {
        // A network round trip per package, even run concurrently, can still take a visible
        // moment - without this, the command looks hung for that stretch instead of just busy.
        logger.info(colors.gray('Checking published npm versions...'));
      }

      const options = {
        ...readPackageFilterOptions(args),
        from,
        filePath: args.filePath as string | undefined,
        root: args.root as boolean | undefined,
      };
      const entries = args.write
        ? await ChangelogService.generateToFile(repository, options)
        : await ChangelogService.getEntries(repository, options);

      if (!entries.length) {
        logger.info(colors.gray('No unreleased changes.'));
        return;
      }
      for (const entry of entries) {
        if (write) logger.info(colors.green('updated'), colors.cyan(entry.label), entry.filePath);
        else console.log(entry.content);
      }
    },
  });
}
