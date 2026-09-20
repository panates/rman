import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import type { RunStepValue } from '../core/run-step.js';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import type { VersionService } from '../services/version.service.js';
import { VersionPlanService } from '../services/version-plan.service.js';
import { assertAllowedBranch, branchGuardOptions, readBranchGuardOptions } from '../utils/branch-guard.js';
import { packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

/**
 * Hoisted out of the metadata literal so the handler can be annotated against them - see
 * `RmanConfig.ArgsOf` for why an inferred `argv` and the metadata's own typo checking cannot both
 * work in one signature.
 *
 * `as const` on the command string is load-bearing twice over: the config key is derived from it
 * (`'version'`), and so are the positional names it declares.
 */
const COMMAND = 'version [bump]' as const;

const config = {
  /** The two shared groups, spread rather than applied - this is what
   *  `applyBranchGuardOptions(applyPackageFilterOptions(cmd))` used to say. Spread first, so an
   *  option deliberately overridden below wins. */
  ...packageFilterOptions,
  ...branchGuardOptions,
  interactive: {
    target: 'cli',
    alias: 'i',
    describe: 'Show the plan and ask for confirmation before applying (with or without an explicit bump)',
    type: 'boolean',
  },
  show: {
    target: 'cli',
    describe:
      'Show the resulting plan for the given bump without applying it - unlike omitting bump ' +
      'entirely, this still uses the given bump keyword/version to compute the plan, ' +
      'just never writes it.',
    type: 'boolean',
    conflicts: 'interactive',
  },
  yes: {
    target: 'cli',
    alias: 'y',
    describe:
      'Skip the confirmation prompt and apply the computed plan immediately - an auto-detected ' +
      'bump included, no explicit bump keyword required (same idea as "publish --yes").',
    type: 'boolean',
    conflicts: 'interactive',
  },
  ignoreDirty: {
    target: 'cli',
    cliName: 'ignore-dirty',
    describe: 'Exclude a package with uncommitted local changes instead of aborting the whole run',
    type: 'boolean',
  },
  push: {
    target: 'cli',
    describe: 'Push the resulting commit(s) and tag(s) to the remote once applied',
    type: 'boolean',
  },
  message: {
    target: 'cli',
    alias: 'm',
    describe:
      'Override the commit message for every group this run commits (default: .rmanrc ' +
      'version.commitMessage, or "chore(release): v{version}") - "{version}" is substituted ' +
      "when a commit's own group shares one version.",
    type: 'string',
  },
  changelog: {
    target: 'both',
    describe:
      "Also write each bumped package's CHANGELOG.md (same as running changelog --write " +
      'separately) and fold it into the same commit as its version bump. Default: .rmanrc ' +
      '"version.changelog", or false - --no-changelog forces it off even when that\'s true.',
    type: 'boolean',
  },
  preid: {
    target: 'cli',
    describe:
      'Make the bump a prerelease with this identifier (e.g. "beta" -> 1.2.3-beta.0). ' +
      'Running again with the same --preid increments it (-> 1.2.3-beta.1); a different ' +
      'identifier starts a fresh prerelease line. Ignored when bump is an explicit version.',
    type: 'string',
  },
  /**
   * Config-only, from here down: `.rmanrc "version.*"` keys with no reason to be a flag.
   * `--message` is `commitMessage`'s flag and is declared above; the rest are settings a repository
   * states once, not things a single run overrides.
   */
  commitMessage: {
    target: 'config',
    describe:
      'The commit message for each group this run commits - "{version}" is substituted when a ' +
      'commit\'s own group shares one version. Default "chore(release): v{version}".',
    type: 'string',
  },
  releaseTagPattern: {
    target: 'config',
    describe:
      "Tag naming the repository's own release, as opposed to the per-package tags " +
      '"changelog.tagPattern" names - only created when the root is on a calendar version. ' +
      'Root-level only. Default "release-*". Must **not** match any package\'s own tag pattern, or ' +
      "that package's changelog boundary resolves to the repository release instead of its own.",
    type: 'string',
  },
  stampDockerfile: {
    target: 'config',
    describe:
      "Keep this package's Dockerfile org.opencontainers.image.version label in step with the " +
      'version being written. Per-package cascaded. Default true - the label is by specification ' +
      'the version of the packaged software, so there is only one correct value and "version" is ' +
      'what knows it. Only ever rewrites a label the Dockerfile already declares.',
    type: 'boolean',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

/**
 * The rest of `version.*` - the keys an option **cannot** describe, which is the whole test for
 * belonging here.
 *
 * A `CommandOption` says `type: 'string'` or `type: 'boolean'`. It has no way to say "a path, or
 * `{ file, constant }`" or "a shell command, or a function, or a list of either" - so these four
 * are written out, intersected with the derived ones by `CommandContribution`, and the key still
 * has exactly one owner. Everything above that *is* expressible is declared as an option instead:
 * `Extra` is the escape hatch, not the default.
 */
export interface VersionExtraKeys {
  /** Files whose hard-coded version is rewritten to the version being written, in the same commit
   *  as the bump - paths relative to the package's own directory (e.g. `["src/constants.ts"]`).
   *  Per-package cascaded; a listed file a package doesn't have is a silent no-op, so one `"[*]"`
   *  declaration covers a repo where only some packages carry one.
   *
   *  Stamping the source, not the build output: a build-time rewrite leaves the checked-in file
   *  claiming a placeholder, so anything running from source reports that placeholder, git never
   *  records the released version, and the rewrite has to be redone on every build. */
  stamp?: VersionStampEntry | VersionStampEntry[];
  /** Command(s) run at the version write itself, when the package does not declare a hook for that
   *  slot of its own (`version` in a Node repository's `package.json#scripts`, whatever a plugin's
   *  step source answers elsewhere - the package's own declaration wins, as in `run`). An array
   *  runs them in sequence. `${{ pkg.targetVersion }}` is bound here and in the two below, and
   *  nowhere else.
   *
   *  A `RunStepFn` runs in place of a shell command - but note that `${{ pkg.targetVersion }}` is a
   *  *string* substitution, so a function reads the written version off `pkg` instead. */
  exec?: RunStepValue | RunStepValue[];
  /** Same, before the write (`preversion` in a Node repository). */
  before?: RunStepValue | RunStepValue[];
  /** Same, after it (`postversion` in a Node repository). */
  after?: RunStepValue | RunStepValue[];
}

/** One `version.stamp` entry: a path, or a path plus the identifier to rewrite when it is not
 *  spelled `version`. */
export type VersionStampEntry = string | { file: string; constant?: string };

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const versionCommand = registerCommand(app => {
  const repository = app.repository;
  /** `rman version <bump|version>` is validated by the root's scheme (see `getPlan`), so the help
   *  has to name that scheme's own words rather than semver's - otherwise `--help` in a repository
   *  numbering some other way documents keywords its own planner would reject. A four-part scheme
   *  lists four here. */
  const { name: scheme, bumpNames } = repository.rootPackage.versionScheme;
  const bumps = bumpNames.map(n => `"${n}"`).join('/');
  /** For the examples. Not `smallestBump`, which throws: `--help` must still render for a scheme
   *  that declares none, and the placeholder says what to write there. */
  const smallest = bumpNames[0] ?? '<bump>';

  return {
    /** `as const` so the config key stays derivable from it: `CommandMetadata['command']` is a
     *  plain `string`, so without the assertion inference widens `'version [bump]'` and there is
     *  nothing left to read `'version'` out of. */
    command: COMMAND,
    describe: 'Bumps versions of changed packages (and their dependents), grouped via .rmanrc "group"',
    /**
     * Read, not owned - so they are named here rather than declared in `config`. `group` is a core
     * per-package key that decides which packages move together, `changelog.*` is consulted when
     * `--changelog` folds one into the bump commit, and `allowBranch`/`ignoreBranch` are repo-wide
     * keys the shared branch-guard group only exposes as flags. `version` itself is not listed: it
     * is this command's own key, derived from `command`.
     */
    configKeys: ['changelog', 'group', 'allowBranch', 'ignoreBranch'],
    config,
    examples: [
      {
        command: `$0 version ${smallest} --show`,
        description: `# Bump ${smallest} directly, applied immediately`,
      },
      {
        command: '$0 version',
        description: "# Auto-detect the bump from commits, show the plan, don't write anything",
      },
      {
        command: '$0 version --interactive',
        description: '# Show the plan either way, then ask for confirmation',
      },
      {
        command: `$0 version ${smallest} --show`,
        description: `# Preview what an explicit ${smallest} would do, without applying it`,
      },
    ],
    positionals: {
      bump: {
        describe:
          `A bump keyword (${bumps}) or an explicit ${scheme} version. ` +
          'Omit to auto-detect from commits and only preview the plan.',
        type: 'string',
      },
    },
    /** Annotated rather than inferred - `RmanConfig.ArgsOf` records why, and the casts this
     *  replaces are the reason it is worth two hoisted declarations. */
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      const bump = args.bump;
      const plan = await VersionPlanService.getPlanner(app).getPlan(repository, {
        ...readPackageFilterOptions(args),
        bump,
        ignoreDirty: args.ignoreDirty,
        preid: args.preid,
      });
      printPlan(plan);

      const errors = plan.filter(e => e.status === 'error');
      if (errors.length) {
        const message =
          `${errors.length} package(s) have uncommitted local changes ` +
          '(pass --ignore-dirty to exclude them instead of aborting)';
        console.log(colors.red(message));
        const err: any = new Error(message);
        err.logged = true;
        throw err;
      }

      if (!plan.some(e => e.status === 'bump')) {
        console.log(colors.gray('Nothing to version.'));
        return;
      }

      if (args.show) {
        console.log(colors.gray('Preview only (--show) - nothing was written.'));
        return;
      }

      let apply = !!bump || !!args.yes;
      if (args.interactive) {
        apply = await confirm('Apply these changes?');
      } else if (!apply) {
        console.log(colors.gray('Run again with an explicit bump, --interactive, or --yes, to apply.'));
        return;
      }
      if (!apply) return;

      const changelog = args.changelog ?? repository.config?.version?.changelog ?? false;
      const applied = await app.getService('version').applyPlan(plan, {
        push: args.push,
        message: args.message,
        changelog,
      });
      printApplied(applied);
    },
  };
});

export default versionCommand;

/**
 * `version`'s own keys, on `RmanConfig` - derived from the `config` block above rather than written
 * out again, so an option added there is a config key immediately and one renamed cannot leave a
 * stale interface behind. Only `target: 'config'`/`'both'` options come through, so `--interactive`
 * and the other CLI-only flags stay off the config type.
 */
declare module '../interfaces/rman-cfg.interface.js' {
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<
      ReturnType<typeof versionCommand>,
      VersionExtraKeys
    > {}
  }
}

/**
 * What the run *did* - which is deliberately not the table again.
 *
 * The plan is printed above, so repeating `name from -> to` per package said nothing: `applyPlan`
 * returned the same array it was handed, so the second list could not have differed. What it never
 * reported is everything below - the commits (one per group, plus the root's informational sync),
 * the tags, a tag that already existed and was left alone, and whether any of it was pushed. A
 * release that is committed but not pushed looks identical to one that is, until someone looks.
 */
function printApplied(result: VersionService.ApplyResult): void {
  const count = result.updated.length;
  console.log(`\n${colors.green('updated')} ${count} package${count === 1 ? '' : 's'}`);

  for (const commit of result.commits) {
    console.log(
      `${colors.green('commit')}  ${colors.yellow(commit.sha)}  ${colors.gray(commit.message.split('\n')[0])}`,
    );
  }
  if (result.tags.length) {
    const label = (tag: VersionService.Tag) =>
      colors.cyan(tag.name) + (tag.created ? '' : colors.gray(' (existing, left alone)'));
    const release = result.tags.filter(t => t.release);
    const perPackage = result.tags.filter(t => !t.release);
    if (perPackage.length) console.log(`${colors.green('tags')}    ${perPackage.map(label).join(', ')}`);
    /** Listed on its own line: it belongs to the repository rather than to any package, which is
     *  the whole reason it exists. */
    if (release.length)
      console.log(`${colors.green('tags')}    ${release.map(label).join(', ')} ${colors.gray('(repository release)')}`);
  }
  console.log(
    result.pushed
      ? `${colors.green('push')}    pushed, with tags`
      : `${colors.gray('push')}    ${colors.gray('not pushed - run with --push, or push it yourself')}`,
  );
}

function printPlan(entries: VersionPlanService.Entry[]): void {
  const table = new EasyTable();
  for (const e of entries) {
    table.cell('Status', statusLabel(e.status));
    table.cell('Package', colors.cyan(e.package.name));
    table.cell('Group', colors.gray(`(${e.group})`));
    table.cell('From', e.from);
    table.cell('', e.status === 'bump' ? '->' : '');
    table.cell('To', e.status === 'bump' ? colors.yellow(e.to!) : '');
    table.cell('Reason', e.status === 'error' ? colors.red(e.reason ?? '') : colors.gray(e.reason ?? ''));
    table.newRow();
  }
  console.log(table.toString().trim());
}

function statusLabel(status: VersionPlanService.Entry['status']): string {
  switch (status) {
    case 'bump':
      return colors.green('bump');
    case 'no-change':
      return colors.gray('no-change');
    case 'skip':
      return colors.cyan('skip');
    case 'error':
      return colors.red('error');
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/N) `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
