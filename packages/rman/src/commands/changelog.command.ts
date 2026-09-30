import colors from 'ansi-colors';
import type { ConfigValue, RmanConfig } from '../interfaces/rman-config.interface.js';
import { registerCommand } from '../interfaces/rman-config.interface.js';
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
  /**
   * **Default `true`, so the flag that does something is `--no-commit-hash`.** GitHub autolinks a
   * bare abbreviated sha wherever it renders Markdown inside a repository, so the plain
   * `(a1b2c3d)` this writes is a link on the page and stays readable in a terminal - which a
   * hand-built `[a1b2c3d](https://.../commit/a1b2c3d)` would not be, and which rman could not build
   * anyway without knowing the forge.
   *
   * `'both'` rather than config-only: it is a lasting preference, and it is also the one thing a
   * caller may want to turn off for a single run - `github-release` bodies are rendered in the same
   * repository, but notes pasted somewhere else lose the autolinking and keep the noise.
   */
  /* **No `default: true` here, and that is the trap `unreleased` already avoids** - the default
   * lives in `withCommitHash`. Declared as a yargs default, an omitted flag arrives as `true`
   * rather than `undefined`, so the flag would win over `.rmanrc changelog.commitHash` on every run
   * and the config key could never turn it off. The precedence rule everywhere is *the flag wins
   * when it was given*, which needs an unset flag to stay unset. */
  commitHash: {
    target: 'both',
    cliName: 'commit-hash',
    describe:
      "Append each commit's short sha to its line (default true) - pass --no-commit-hash for " +
      'notes that are read outside the repository, where GitHub does not autolink it',
    type: 'boolean',
  },
  tagPattern: {
    target: 'config',
    describe:
      "The release tag naming scheme each package's changelog boundary is detected from - " +
      '"{name}" is replaced with the package name (e.g. "{name}@*" for independent versioning). ' +
      'Default "v*", one repo-wide tag resolved through git describe.',
    type: 'string',
  },
  /**
   * **Where a package's history starts being worth documenting**, as one key taking whichever form
   * the answer naturally has - a version or tag, a date, or a commit.
   *
   * `'both'`, because it is a lasting fact about the package ("we do not publish what happened
   * before 2.0"), not a decision per run. That is also what separates it from `--from`, which those
   * three forms would otherwise duplicate: `--from` is this run's boundary and applies identically
   * to every package, while this lives in `.rmanrc`, is cascaded per package, and still holds on
   * the run after next.
   */
  /**
   * **Default `true`, so the flag that does something is `--no-unreleased`** - and that is the one
   * place this deliberately differs from `auto-changelog`, which defaults it off.
   *
   * There, a changelog is generated from a finished history and the unreleased section is the
   * unusual thing to want. Here it is the *ordinary* one: `rman changelog` exists to answer what is
   * not released yet, down to the message it prints when there is nothing ("No unreleased
   * changes."), and `version --changelog` writes the entry for the release it is about to cut -
   * which is that segment. Defaulting it off would make the common case need a flag, and make
   * `version --changelog` silently write nothing.
   *
   * What it *is* for is the other direction, which only became possible once `--write` started
   * backfilling: a changelog of released history, with the work in progress left out.
   */
  unreleased: {
    target: 'both',
    describe:
      'Include the entry for commits that are not released yet (default true) - pass ' +
      '--no-unreleased for a changelog of released history only',
    type: 'boolean',
  },
  startingAt: {
    target: 'both',
    cliName: 'starting-at',
    describe:
      "Where this package's changelog begins: a version or release tag (inclusive), a YYYY-MM-DD " +
      'date, or a commit. Releases older than it are left out - for a package whose early ' +
      'development does not belong in its changelog',
    type: 'string',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

/**
 * **What a `CommandOption` cannot say**, which is the only thing `Extra` is for: `titles` is a map
 * from commit type to section heading, and an option says `type: 'string'`.
 */
export interface ChangelogExtraKeys {
  /**
   * The heading each Conventional Commits type is listed under - `{ feat: 'New Features', dev:
   * 'Development Changes' }`. Per-package cascaded.
   *
   * **Merged over the defaults per key, not replacing them**, the way `vars` merges: naming `dev`
   * adds a section without silently costing you `feat` and `fix`, and renaming `feat` leaves it
   * where it was in the order. The cost, stated rather than hidden - you cannot *remove* a default
   * section by leaving it out; `changelog.ignoreTypes` is the key that drops a type entirely.
   *
   * Two types sharing a heading share one section. `'*'` is the heading for every type that is not
   * named here, and is always rendered last; a subject that is not Conventional Commits at all has
   * no type to key off and lands there too.
   *
   * Sections come out in the order the types were declared, defaults first - so a repository
   * chooses both the wording and the running order.
   */
  titles?: ConfigValue<Record<string, string>>;
  /**
   * The order the sections come out in, as a list of commit **types** - `['fix', 'feat', 'docs']`.
   * Per-package cascaded.
   *
   * Separate from `titles` because they are separate decisions, and letting one key do both was
   * the wrong shape: `titles` patches a heading's *wording*, so a repository renaming `feat` would
   * otherwise also be silently re-deciding where it sits. A type left out keeps its place after the
   * listed ones; `'*'` is always last whatever this says, since a catch-all in the middle swallows
   * the sections after it.
   */
  sortTitles?: ConfigValue<string[]>;
}

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const changelogCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    /** Prints the notes themselves, which a caller redirects into a file. */
    printsDocument: true,
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
        startingAt: args.startingAt,
        unreleased: args.unreleased,
        commitHash: args.commitHash,
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
    interface CommandConfigs extends RmanConfig.CommandContribution<
      ReturnType<typeof changelogCommand>,
      ChangelogExtraKeys
    > {}
  }
}
