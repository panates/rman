import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { GithubReleaseService } from '../services/github-release.service.js';
import { assertAllowedBranch, branchGuardOptions, readBranchGuardOptions } from '../utils/branch-guard.js';

const COMMAND = 'github-release' as const;

const config = {
  ...branchGuardOptions,
  yes: {
    target: 'cli',
    alias: 'y',
    describe: 'Skip the confirmation prompt and create the release immediately',
    type: 'boolean',
  },
  dryRun: {
    target: 'cli',
    cliName: 'dry-run',
    describe: 'Only show the plan - never creates anything, regardless of --yes',
    type: 'boolean',
  },
  json: { target: 'cli', alias: 'j', describe: 'Print the plan as JSON instead of text', type: 'boolean' },
  ignoreDirty: {
    target: 'cli',
    cliName: 'ignore-dirty',
    describe: 'Release anyway when the working tree has uncommitted changes, instead of aborting',
    type: 'boolean',
  },
  repository: {
    target: 'both',
    describe:
      'The "owner/repo" the release is created in - default: .rmanrc "githubRelease.repository", ' +
      'falling back to the "origin" remote.',
    type: 'string',
  },
  /** Config-only: details of the release, with no reason to be a flag. `target: 'config'` is what
   *  says so, and it is the whole point of the field - a key can exist in `.rmanrc` without
   *  existing on the command line. */
  draft: { target: 'config', describe: 'Create the release as a draft', type: 'boolean' },
  prerelease: { target: 'config', describe: 'Mark the release as a prerelease', type: 'boolean' },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const githubReleaseCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    /** `githubRelease`, not `github-release`: a config key is camelCase and a command name is
     *  hyphenated, and this is the one command out of the whole set where the two differ. */
    configKey: 'githubRelease' as const,
    describe: "Creates the repository's GitHub Release for the version that just shipped",
    /** Read, not owned - the release tag's pattern is `version`'s key. */
    configKeys: ['version.releaseTagPattern'],
    config,
    examples: [
      { command: '$0 github-release', description: '# Show what would be released, then ask for confirmation' },
      { command: '$0 github-release --yes', description: '# Create it immediately, no confirmation (CI)' },
      { command: '$0 github-release --dry-run', description: '# Only show the plan' },
    ],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));

      // No package filtering: a release belongs to the repository, not to a package, so there is
      // nothing for --scope/--ignore to narrow down.
      const plan = await GithubReleaseService.getPlan(repository, {
        ignoreDirty: args.ignoreDirty,
        repository: args.repository,
      });

      if (args.json) {
        console.log(
          JSON.stringify(
            plan.map(e => ({
              tag: e.tag,
              repository: e.repository,
              status: e.status,
              version: e.version,
              reason: e.reason,
            })),
            undefined,
            2,
          ),
        );
      } else {
        for (const e of plan) {
          const name = colors.cyan(e.tag ?? e.version);
          switch (e.status) {
            case 'publish':
              console.log(colors.green('release'), name, colors.gray(`${e.repository} - ${e.reason ?? ''}`));
              break;
            case 'up-to-date':
              console.log(colors.gray('up-to-date'), name, colors.gray(e.reason ?? ''));
              break;
            case 'skip':
              console.log(colors.cyan('skip'), name, colors.gray(e.reason ?? ''));
              break;
            case 'error':
              console.log(colors.red('error'), name, colors.red(e.reason ?? ''));
              break;
          }
        }
      }

      const error = plan.find(e => e.status === 'error');
      if (error) {
        const err: any = new Error(error.reason ?? 'Unable to prepare the GitHub Release');
        err.logged = true;
        throw err;
      }

      if (!plan.some(e => e.status === 'publish')) {
        if (!args.json) console.log(colors.gray('Nothing to release.'));
        return;
      }

      if (args.dryRun) return;

      let proceed = !!args.yes;
      if (!proceed) {
        if (!process.stdout.isTTY) {
          console.log(colors.gray('Not a TTY - refusing to prompt. Pass --yes to release non-interactively.'));
          return;
        }
        proceed = await confirm('Create this release?');
      }
      if (!proceed) return;

      const applied = await GithubReleaseService.applyPlan(repository, plan);
      const failed = applied.find(e => e.status === 'error');
      if (failed) {
        console.log(colors.red('failed'), colors.cyan(failed.tag ?? ''), colors.red(failed.reason ?? ''));
        const err: any = new Error('"github-release" failed');
        err.logged = true;
        throw err;
      }
      for (const e of applied) {
        if (e.status === 'publish') console.log(colors.green('released'), colors.cyan(e.tag ?? ''));
      }
    },
  };
});

export default githubReleaseCommand;

declare module '../interfaces/rman-cfg.interface.js' {
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<ReturnType<typeof githubReleaseCommand>> {}
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
