import colors from 'ansi-colors';
import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import { ChangeHashService } from '../services/change-hash.service.js';
import { Logger, resolveRootLogLevel } from '../utils/logger.js';
import { fromRootOption, packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

const COMMAND = 'changelog' as const;

const config = {
  ...packageFilterOptions,
  ...fromRootOption('Generate'),
  from: {
    target: 'cli',
    describe:
      'Generate the changelog since this commit/hash, applied the same way to every package. ' +
      'Default (also "auto" explicitly): auto-detect per package from its own most recent release ' +
      'tag - same as "version"/"changed" - falling back to the version its own ecosystem\'s ' +
      "registry reports (no tag yet), then to its whole history for a package that's never been " +
      'released at all',
    type: 'string',
  },
  write: {
    target: 'cli',
    describe: "Prepend the entry into each package's own changelog file instead of printing it",
    type: 'boolean',
  },
  /** The one option here that is also a config key - hence `'both'`, and hence this command
   *  contributing `changelog.filePath` to `RmanConfig`. */
  filePath: {
    target: 'both',
    cliName: 'file-path',
    describe:
      "With --write, the file to prepend into, relative to each package's own directory " +
      '(default: "CHANGELOG.md", or .rmanrc "changelog.filePath")',
    type: 'string',
  },
  includeSkipped: {
    target: 'cli',
    cliName: 'include-skipped',
    describe: 'Also generate for a package with .rmanrc "publish.skip" - excluded by default',
    type: 'boolean',
  },
  releaseVersion: {
    target: 'cli',
    cliName: 'release-version',
    describe:
      'The version these notes are for - what the entry heading shows. Default: read back from ' +
      "each package's own latest release tag, which is only right once that release is tagged. " +
      'Pass it when generating notes ahead of the bump (e.g. from "changed --json" in CI), ' +
      'otherwise the heading shows the previous release.',
    type: 'string',
  },
  /**
   * Config-only, from here down - `.rmanrc "changelog.*"` keys with no reason to be a flag. All
   * three are plain strings or a string list, so this command needs no `Extra` at all: its whole
   * config block is derived from what is declared here.
   */
  ignoreTypes: {
    target: 'config',
    describe: 'Conventional-commit types to leave out of the notes entirely (e.g. ["chore", "ci"])',
    type: 'string',
    array: true,
  },
  template: {
    target: 'config',
    describe:
      "Path to a template file for one package's entry, relative to the repository root. Its own " +
      "{{package}}/{{version}} placeholders are that file's content, not config expressions.",
    type: 'string',
  },
  tagPattern: {
    target: 'config',
    describe:
      "The release tag naming scheme each package's changelog boundary is detected from - " +
      '"{name}" is replaced with the package name (e.g. "{name}@*" for independent versioning). ' +
      'Default "v*", one repo-wide tag resolved through git describe.',
    type: 'string',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const changelogCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Generates a changelog per package from unreleased commits',
    /** Read, not owned: `publish.skip` is `publish`'s key, reused here on purpose - a package that is
     *  never distributed gets no release notes either. */
    configKeys: ['publish.skip'],
    config,
    examples: [
      { command: '$0 changelog', description: "# Auto-detects each package's own last release tag (or npm version)" },
      { command: '$0 changelog --from <hash> --write', description: '# Since a specific commit, written to file' },
    ],
    handler: async (args: Args) => {
      const from = args.from;
      const write = args.write;
      const logger = new Logger(args.logLevel ?? resolveRootLogLevel(repository));

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
        filePath: args.filePath,
        fromRoot: args.fromRoot,
        includeSkipped: args.includeSkipped,
        version: args.releaseVersion,
      };
      const changelog = app.getService('changelog');
      const entries = write ? await changelog.generateToFile(options) : await changelog.getEntries(options);

      if (!entries.length) {
        logger.info(colors.gray('No unreleased changes.'));
        return;
      }
      for (const entry of entries) {
        if (write) logger.info(colors.green('updated'), colors.cyan(entry.label), entry.filePath);
        else console.log(entry.content);
      }
    },
  };
});

export default changelogCommand;

declare module '../interfaces/rman-config.interface.js' {
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<ReturnType<typeof changelogCommand>> {}
  }
}
