import path from 'node:path';
import colors from 'ansi-colors';
import type { Repository } from '../core/classes/repository.js';
import type { ConfigValue, RmanConfig } from '../interfaces/rman-config.interface.js';
import { registerCommand } from '../interfaces/rman-config.interface.js';
import { ChangeHashService } from '../services/change-hash.service.js';
import type { ChangelogService } from '../services/changelog.service.js';
import { Logger, resolveRootLogLevel } from '../utils/logger.js';
import { fromRootOption, packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';
import { ProgressPanel } from '../utils/progress-panel.js';

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
  /**
   * **What one changelog file is about.** `'package'` gives every package its own; `'group'` gives
   * one to each set of packages that versions and releases together (`.rmanrc group`), written at
   * the repository root - `CHANGELOG.md` for the default group, `CHANGELOG-<name>.md` for a named
   * one. A `group: false` package is a group of itself either way, so its file stays its own.
   *
   * **`'package'` is the default because changing a repository's layout silently is not something a
   * minor release may do**, not because it is the better answer. For a repository releasing along
   * one line it is measurably the worse one: every package is bumped together, so most of them have
   * no commit of their own and get a file that only ever says "Updated dependencies" - measured on
   * `panates/sqb`, fifteen of seventeen. The whole release is then readable nowhere.
   *
   * Read off the repository root and nowhere else - see `changelogGroupBy`.
   */
  /**
   * **The panel is drawn on stderr, not stdout**, which is the whole reason this needed a change
   * rather than a call: `changelog` is `printsDocument`, so `rman changelog > NOTES.md` would
   * otherwise capture the panel's cursor-movement codes into the notes. Same reasoning the status
   * region already carries.
   */
  /**
   * **Implies `--write`, because there is nothing else it could mean.** "Rebuild the changelog"
   * with no file to rebuild would either print (which `rman changelog --from <first-tag>` already
   * does) or silently do nothing; neither is what was asked for.
   */
  rebuild: {
    target: 'cli',
    describe:
      'Regenerate each changelog file from the whole history instead of appending to it - ' +
      'implies --write, and replaces what is in the file rather than prepending to it',
    type: 'boolean',
  },
  progress: {
    target: 'both',
    describe: 'Show a live progress panel (default: true; auto-disabled when stderr is not a TTY)',
    type: 'boolean',
  },
  groupBy: {
    target: 'both',
    cliName: 'group-by',
    describe:
      'What one changelog file covers: "package" (default, one per package) or "group" (one per ' +
      'set of packages released together, at the repository root)',
    type: 'string',
    choices: ['package', 'group'] as const,
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
      const rebuild = !!args.rebuild;
      const write = args.write || rebuild;
      const logger = new Logger(args.logLevel ?? resolveRootLogLevel(repository));

      /**
       * **The panel replaces the static line, and only where it can actually draw.** That line
       * ("Detecting each package's last release...") answered "did it start" and then said nothing
       * for the rest of the run - which is the longer half: measured on a `panates/sqb` backfill,
       * boundary detection is 1.2s and reading the commits is 6.6s, one target at a time.
       *
       * Off it falls back to the line, because the two cases it is off in are exactly the two the
       * line is for: a pipe, and `--no-progress`.
       */
      const panel = new ProgressPanel(
        'CHANGELOG',
        (args.progress ?? resolveProgressConfig(repository)) !== false && !!process.stderr.isTTY,
        process.stderr,
      );
      if (!panel.enabled && (!from || from === ChangeHashService.AUTO)) {
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
        groupBy: args.groupBy,
        rebuild,
        progress: panelReporter(panel),
      };
      const changelog = app.getService('changelog');
      panel.start();
      let entries: ChangelogService.Entry[];
      try {
        entries = write ? await changelog.generateToFile(options) : await changelog.getEntries(options);
      } finally {
        /** In a `finally`, or a throw leaves the redraw interval running and the cursor parked
         *  inside a half-drawn block - the process then prints its error over the panel. */
        panel.stop();
      }

      if (!entries.length) {
        logger.info(colors.gray('No unreleased changes.'));
        return;
      }
      if (!write) {
        for (const entry of entries) console.log(entry.content);
        return;
      }
      /**
       * **One line per file, not one per entry.** An entry is a *release*, so a backfill produces
       * several for the same file and printed per entry the run repeats `updated ... CHANGELOG.md`
       * once per release it found - twelve identical lines on a real repository, saying nothing
       * the first did not.
       *
       * The path is repository-relative and the label is gone with the repetition: `packages/core/
       * CHANGELOG.md` already says which package it belongs to, and under
       * `changelog.groupBy: 'group'` the label names a group while the path names the file that
       * was actually written - which is what the reader is being told about.
       */
      for (const file of new Set(entries.map(e => e.file))) {
        logger.info(colors.green('updated'), path.relative(repository.dirname, file));
      }
    },
  };
});

/** `.rmanrc changelog.progress`, off the **root** - one panel for the run, so one answer for the
 *  repository, the rule `run`'s `concurrency` already follows. */
function resolveProgressConfig(repository: Repository): boolean | undefined {
  const v = repository.rootPackage.config?.changelog?.progress;
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * The panel, driven by what `ChangelogService` reports.
 *
 * A label sits at `pending` between its two phases on purpose: `detect` finishing does not finish
 * the label, and the header's bar counts anything not pending as done - so marking it otherwise
 * would show the run complete while the slow half had not started.
 */
function panelReporter(panel: ProgressPanel): ChangelogService.Progress {
  const items = new Map<string, ReturnType<ProgressPanel['addItem']>>();
  return {
    start(labels) {
      for (const label of labels) items.set(label, panel.addItem(label, 2));
    },
    step(label, phase) {
      const item = items.get(label);
      if (!item) return;
      item.status = 'running';
      item.currentStep = phase === 'detect' ? 'detecting last release' : 'reading commits';
      /** 0-based: the panel renders `stepIndex + 1`, the way `RunService` sets it. */
      item.stepIndex = phase === 'detect' ? 0 : 1;
      item.startedAt ??= Date.now();
      if (phase === 'detect') item.status = 'pending';
    },
    done(label, wrote) {
      const item = items.get(label);
      if (!item) return;
      /** Nothing to document is not a failure and not a success - it is the third thing the panel
       *  already has a word for. */
      item.status = wrote ? 'success' : 'skipped';
      item.finishedAt = Date.now();
    },
  };
}

export default changelogCommand;

declare module '../interfaces/rman-config.interface.js' {
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<
      ReturnType<typeof changelogCommand>,
      ChangelogExtraKeys
    > {}
  }
}
