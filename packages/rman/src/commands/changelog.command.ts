import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { ChangeHashService } from '../services/change-hash.service.js';
import { ChangelogService } from '../services/changelog.service.js';
import { Logger, type LogLevel, resolveRootLogLevel } from '../utils/logger.js';
import { applyPackageFilterOptions, applyRootOption, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'changelog',
    configKeys: ['changelog', 'publish.skip'],
    describe: 'Generates a changelog per package from unreleased commits',
    builder: cmd =>
      applyRootOption(applyPackageFilterOptions(cmd), 'Generate')
        .example('$0 changelog', "# Auto-detects each package's own last release tag (or npm version)")
        .example('$0 changelog --from <hash> --write', '# Since a specific commit, written to file')
        .option('from', {
          describe:
            'Generate the changelog since this commit/hash, applied the same way to every package. ' +
            'Default (also "auto" explicitly): auto-detect per package from its own most recent release ' +
            'tag - same as "version"/"changed" - falling back to the version its own ecosystem\'s ' +
            "registry reports (no tag yet), then to its whole history for a package that's never been " +
            'released at all',
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
        .option('include-skipped', {
          describe: 'Also generate for a package with .rmanrc "publish.skip" - excluded by default',
          type: 'boolean',
        })
        .option('release-version', {
          describe:
            'The version these notes are for - what the entry heading shows. Default: read back from ' +
            "each package's own latest release tag, which is only right once that release is tagged. " +
            'Pass it when generating notes ahead of the bump (e.g. from "changed --json" in CI), ' +
            'otherwise the heading shows the previous release.',
          type: 'string',
        }),
    handler: async args => {
      const from = args.from as string | undefined;
      const write = args.write as boolean | undefined;
      const logger = new Logger((args.logLevel as LogLevel | undefined) ?? resolveRootLogLevel(repository));

      if (!from || from === ChangeHashService.AUTO) {
        // Auto-detection is mostly local git work, but the registry fallback it can reach for
        // (only when a package has no tag at all, and only if the package's own ecosystem provides
        // one) is a network round trip per package - without this, the command looks hung for that
        // stretch instead of just busy.
        logger.info(colors.gray("Detecting each package's last release..."));
      }

      const options = {
        ...readPackageFilterOptions(args),
        from,
        filePath: args.filePath as string | undefined,
        root: args.root as boolean | undefined,
        includeSkipped: args.includeSkipped as boolean | undefined,
        version: args.releaseVersion as string | undefined,
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
