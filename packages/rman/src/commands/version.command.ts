import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import type { RunStepValue } from '../core/interfaces/run-step.js';
import type { ConfigValue, RmanConfig } from '../interfaces/rman-config.interface.js';
import { registerCommand } from '../interfaces/rman-config.interface.js';
import type { VersionService } from '../services/version.service.js';
import { VersionPlanService } from '../services/version-plan.service.js';
import { assertAllowedBranch, branchGuardOptions, readBranchGuardOptions } from '../utils/branch-guard.js';
import { packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';
import { isNamedGroupKey, isSoloGroupKey, ROOT_GROUP_KEY } from '../utils/version-group.js';

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
  json: {
    target: 'cli',
    alias: 'j',
    describe:
      'Print the plan as JSON and write nothing - the machine-readable form of --show, and what ' +
      'the removed "changed" command was for.',
    type: 'boolean',
    conflicts: ['interactive', 'yes'],
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
  /** `target: 'both'`: a flag for one prerelease, and `.rmanrc "version.preid"` for a repository
   *  that releases on a prerelease line for good (`4.13.3-rev.N`). */
  preid: {
    target: 'both',
    describe:
      'Make the bump a prerelease with this identifier (e.g. "beta" -> 1.2.3-beta.0). ' +
      'Running again with the same --preid increments it (-> 1.2.3-beta.1); a different ' +
      'identifier keeps the version when it already holds the change (2.19.0-alpha.1 -> ' +
      '2.19.0-beta.0). Ignored when bump is an explicit version. ' +
      'Default: .rmanrc "version.preid", which every member of a group has to agree on.',
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
  cascade: {
    target: 'config',
    describe:
      'The narrowest this repository is willing to release a group: "changed" (only packages with ' +
      'commits of their own, i.e. no floor of your own), "dependents" (those plus in-group ' +
      'packages depending on them), or "group" (every member, so the group stays in lockstep). ' +
      'A floor, not a ceiling: the technology still widens it where a narrower release would ' +
      "leave a dependent's published artifact or range floor behind - under npm that is " +
      '"dependents" for a patch or a minor and the whole group for a major, so "changed" is a ' +
      'no-op there. Per-package cascaded; a group whose members disagree takes the widest.',
    type: 'string',
    choices: ['changed', 'dependents', 'group'] as const,
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
 *
 * **It is also the one interface in the tree holding both kinds of function**, so the value/step
 * split is made here by hand, key by key. `stamp` is a **value**, so it is a `ConfigValue` and may
 * be written as a function evaluated while the config resolves. The three slots are **steps**: they
 * already take a function and it means something else - code `version` calls when the write
 * happens, with a `RunStepContext`. Wrapping one would accept a value function where a step is what
 * actually runs.
 *
 * A new key here goes on one side or the other, and the two mistakes are not symmetric: forgetting
 * `ConfigValue` on a value key is benign (it simply cannot be written as a function yet, which is
 * where every key started), while putting it on a step key is not. That asymmetry is why nothing
 * wraps these automatically - see `CommandConfigFromMetadata` for the half that can be, because an
 * option's value is a value by construction.
 */
export interface VersionExtraKeys {
  /** Files whose hard-coded version is rewritten to the version being written, in the same commit
   *  as the bump - paths relative to the package's own directory (e.g. `["src/constants.ts"]`).
   *  Per-package cascaded; a listed file a package doesn't have is a silent no-op, so one `"[*]"`
   *  declaration covers a repo where only some packages carry one. A file that *exists* and holds
   *  nothing rewritable is an error instead - unless the entry is `{ file, optional: true }`, which
   *  is how a shared preset says "stamp it where there is one".
   *
   *  Stamping the source, not the build output: a build-time rewrite leaves the checked-in file
   *  claiming a placeholder, so anything running from source reports that placeholder, git never
   *  records the released version, and the rewrite has to be redone on every build. */
  stamp?: ConfigValue<VersionStampEntry | VersionStampEntry[]>;
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

/**
 * One `version.stamp` entry: a path, or a path plus the identifier to rewrite when it is not spelled
 * `version` and whether the entry is `optional`.
 *
 * **`optional` marks an entry whose author cannot know whether the file holds a version.** A file
 * that exists and has nothing to rewrite is otherwise an error - that is what catches a typo'd path
 * or a renamed identifier before it silently ships a stale constant on every release. The case it
 * is wrong for is a *shared preset* naming one path for every package of a technology, which is
 * saying "stamp it where there is one" and cannot know which repositories keep a constant there.
 * A bare string still throws; the asker chooses, the way `file.exists()` and `file.resolve()`
 * already split the same question.
 */
export type VersionStampEntry = string | { file: string; constant?: string; optional?: boolean };

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
      /**
       * **The machine-readable plan, and the whole of it.** This replaced `rman changed`, which
       * was `getPlan` filtered to `status === 'bump'` - and that one-line filter produced two
       * silent wrongs at once, measured together on a dirty tree: the entry it returned was the
       * repository **root** (`buildRootEntry` reports `'bump'`, and the fact that it is
       * informational lived only in `reason`), while `pkg-a`, the package that had actually
       * changed, was dropped because a package with uncommitted changes is `'error'`. A CI script
       * reading that array saw one name to release and it was the one name that must never be
       * published.
       *
       * So nothing is filtered here. Every entry carries its own `status`, and `isRoot` is stated
       * rather than left to be inferred from `group === "root"` - a consumer selects what it wants
       * and can see what it is leaving out. Printed **before** the table and before the
       * dirty-package throw, so stdout holds one JSON document and nothing else.
       *
       * **Exit 0 either way, deliberately.** `--show` exits 1 on a dirty package because a person
       * needs stopping; here the same fact is in the data, and overloading the exit code would
       * make a pipeline bail before it could read the very rows that explain why.
       */
      if (args.json) {
        console.log(
          JSON.stringify(
            plan.map(e => ({
              name: e.package.name,
              selector: e.package.selector,
              isRoot: e.package.isRoot,
              /** `rman list --json`'s spelling, so a consumer joins the two on it. */
              groupKey: e.groupKey,
              group: e.group,
              status: e.status,
              from: e.from,
              to: e.to,
              reason: e.reason,
            })),
            undefined,
            2,
          ),
        );
        return;
      }

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
declare module '../interfaces/rman-config.interface.js' {
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
      ? `${colors.green('push')}    pushed the branch` +
          (result.tags.length ? ` and ${result.tags.map(t => t.name).join(', ')}, together` : '')
      : `${colors.gray('push')}    ${colors.gray('not pushed - run with --push, or push it yourself')}`,
  );
}

function printPlan(entries: VersionPlanService.Entry[]): void {
  const table = new EasyTable();
  let first = true;
  for (const { members } of planBlocks(entries)) {
    if (!first) table.pushDelimeter(PLAN_COLUMNS);
    first = false;
    for (const e of members) printPlanRow(table, e);
  }
  console.log(table.toString().trim());
}

/**
 * The plan, split into the blocks a delimiter is drawn between: the **repository root** first, then
 * every shared version line with its members together, then the packages that share a line with
 * nobody.
 *
 * `getPlan` returns entries in *package* order, which is the order the workspace found them in -
 * so two members of one group are adjacent only by luck. That matters more than it looks: a group
 * releases as one version line, so "these four numbers move together" is the single fact the table
 * exists to convey, and scattering the members leaves the `Group` column as the only thing saying
 * so. Read top to bottom instead, each block now *is* a release.
 *
 * **The root is first, and it is the one row that is not a release.** Its number is the
 * repository's identity - what the GitHub Release is named after, and on a calendar version a
 * number no package shares - so it is the heading the rest of the table sits under rather than a
 * footnote to it. `buildRootEntry` appends it, which is why it is pulled out by hand here; leaving
 * it where the plan put it made it the last singleton, indistinguishable from a package that
 * happens to be grouped with no one.
 *
 * **Solo packages are one block, not one block each.** `group: false` makes every package its own
 * group of one, so a delimiter per group would draw a line between every row in exactly the
 * repository that has nothing to group - noise standing in for structure. They share a block
 * because what they have in common is real: none of them is tied to anyone else.
 *
 * The Group column is decided per row from the group key (`groupCell`), not from the block: both ask
 * the same key the same question - is this package in a group, and did anybody name it - so they
 * cannot disagree.
 */
function planBlocks(entries: VersionPlanService.Entry[]): PlanBlock[] {
  /**
   * `package.isRoot` is by **directory**, which is the only reliable test - `Repository extends
   * Package` while holding a separate `rootPackage` instance for the same directory, so an identity
   * check answers `false` for one of the two objects that are both the root.
   *
   * In a single-package repository that one package *is* the root and `getPlan` pushes no root
   * entry of its own, so it lands here and prints alone - one row, and no delimiter to draw.
   */
  const root = entries.filter(e => e.package.isRoot);
  const members = entries.filter(e => !e.package.isRoot);

  const byGroup = new Map<string, VersionPlanService.Entry[]>();
  for (const e of members) {
    const group = byGroup.get(e.groupKey);
    if (group) group.push(e);
    else byGroup.set(e.groupKey, [e]);
  }

  /**
   * **Classified by the key, not by how many members a group has.** This was `group.length > 1`,
   * which stands in for "is this a group" and is wrong in exactly one case: a group the repository
   * *named* that happens to have a single member. Reported on a real repository - a package alone in
   * `group: "abisena-iomt"` landed among the ungrouped and printed an empty Group cell, reading
   * exactly like a package that had opted out. Its name decides its changelog file and its tag, so
   * it is a line of its own whatever its size.
   */
  const shared: PlanBlock[] = [];
  const solo: VersionPlanService.Entry[] = [];
  for (const [key, group] of byGroup) {
    if (isSoloGroupKey(key)) solo.push(...group);
    else shared.push({ members: group });
  }

  return [...(root.length ? [{ members: root }] : []), ...shared, ...(solo.length ? [{ members: solo }] : [])];
}

interface PlanBlock {
  members: VersionPlanService.Entry[];
}

/** The column names in the order `printPlanRow` writes them - `pushDelimeter` has to be handed the
 *  same set, or the dashes appear under a column that does not exist yet. */
const PLAN_COLUMNS = ['Status', 'Package', 'Group', 'From', '', 'To', 'Reason'];

function printPlanRow(table: EasyTable, e: VersionPlanService.Entry): void {
  table.cell('Status', statusLabel(e.status));
  table.cell('Package', colors.cyan(e.package.name));
  table.cell('Group', groupCell(e));
  table.cell('From', e.from);
  /**
   * Gated on `to`, not on `status === 'bump'`, which is what kept the column blank on the one
   * command whose whole job is to fill it: a dirty package aborts the run, and "you cannot
   * release this" is only half of what the reader came for - the other half is which version it
   * would have got. `getPlan` sets `to` on exactly the entries that earned one, so asking whether
   * there is a version to show is the honest test. Dimmed rather than yellow when the entry is
   * not a bump, because that number is a hypothetical and nothing is going to write it.
   */
  table.cell('', e.to ? '->' : '');
  table.cell('To', e.to ? (e.status === 'bump' ? colors.yellow(e.to) : colors.gray(e.to)) : '');
  table.cell('Reason', e.status === 'error' ? colors.red(e.reason ?? '') : colors.gray(e.reason ?? ''));
  table.newRow();
}

/**
 * What the Group column says for one row - a **name** where the repository gave the group one, a
 * **description** in grey parentheses where it did not, and nothing where there is no group at all.
 */
/* **A name and a description are different kinds of thing, and the cell says which.** `(default)`
 * and `(root)` are not names anybody wrote - the default group is the line every package is on until
 * told otherwise, and `root` is what the row *is*: the repository's release identity rather than a
 * release. Both are notes about the row, so they read as notes. A named group (`group: "core"`) is a
 * value the repository chose, decides its changelog file and its tag, and is printed as a value -
 * bare, in the ordinary colour. Asked for directly: printed `(abisena-iomt)` in grey, a real group
 * read like an annotation beside the default one.
 *
 * **Decided by the group key, never by the label.** A group may be *named* `default` or `root` - both
 * pass `assertGroupName` - and testing the label would print it as the description it is spelling.
 *
 * **Blank for a package in no group** (`group: false`): its group of one is named after the package,
 * so the cell would repeat the Package column - a word that looks like information and carries none.
 *
 * **Blank for a single-package repository's one package** too, which is the root and is in the
 * default group: there is nothing there to group, and `(default)` on the only row would be noise. It
 * was blank before this cell distinguished names from descriptions, and stays so. */
function groupCell(e: VersionPlanService.Entry): string {
  if (e.groupKey === ROOT_GROUP_KEY) return colors.gray(`(${e.group})`);
  if (e.package.isRoot || isSoloGroupKey(e.groupKey)) return '';
  if (isNamedGroupKey(e.groupKey)) return e.group;
  /** The default group - and any key a custom planner's `resolveGroupKey` returns, which is a
   *  description of its own making rather than a name the repository wrote. */
  return colors.gray(`(${e.group})`);
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
