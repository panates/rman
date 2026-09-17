import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { GithubReleaseService } from '../services/github-release.service.js';
import { applyBranchGuardOptions, assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'github-release',
    configKeys: ['githubRelease', 'version.releaseTagPattern'],
    describe: "Creates the repository's GitHub Release for the version that just shipped",
    builder: cmd =>
      applyBranchGuardOptions(cmd)
        .example('$0 github-release', '# Show what would be released, then ask for confirmation')
        .example('$0 github-release --yes', '# Create it immediately, no confirmation (CI)')
        .example('$0 github-release --dry-run', '# Only show the plan')
        .option('yes', {
          alias: 'y',
          describe: 'Skip the confirmation prompt and create the release immediately',
          type: 'boolean',
        })
        .option('dry-run', {
          describe: 'Only show the plan - never creates anything, regardless of --yes',
          type: 'boolean',
        })
        .option('json', {
          alias: 'j',
          describe: 'Print the plan as JSON instead of text',
          type: 'boolean',
        })
        .option('repository', {
          describe:
            'The "owner/repo" the release is created in - default: .rmanrc "githubRelease.repository", ' +
            'falling back to the "origin" remote.',
          type: 'string',
        })
        .option('ignore-dirty', {
          describe: 'Release anyway when the working tree has uncommitted changes, instead of aborting',
          type: 'boolean',
        }),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));

      // No package filtering: a release belongs to the repository, not to a package, so there is
      // nothing for --scope/--ignore to narrow down.
      const plan = await GithubReleaseService.getPlan(repository, {
        ignoreDirty: args.ignoreDirty as boolean | undefined,
        repository: args.repository as string | undefined,
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
  });
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
