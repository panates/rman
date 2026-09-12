import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { CiService } from '../services/ci.service.js';
import { PublishService } from '../services/publish.service.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'publish',
    describe: 'Publishes every non-private package whose local version is not already on the registry',
    builder: cmd =>
      cmd
        .example('$0 publish', '# Show the plan, then ask for confirmation')
        .example('$0 publish --yes', '# Publish immediately, no confirmation')
        .example('$0 publish --dry-run', '# Only show the plan, never publish')
        .option('yes', {
          alias: 'y',
          describe: 'Skip the confirmation prompt and publish immediately',
          type: 'boolean',
        })
        .option('dry-run', {
          describe: 'Only show the plan - never publishes, regardless of --yes',
          type: 'boolean',
        })
        .option('ignore-dirty', {
          describe: 'Exclude a package with uncommitted local changes instead of aborting the whole run',
          type: 'boolean',
        })
        .option('package-manager', {
          describe: 'Package manager to publish with (default: npm, or .rmanrc "packageManager")',
          choices: PACKAGE_MANAGERS,
        })
        .option('access', {
          describe: 'npm publish --access <public|restricted> - required by the registry for a new scoped package',
          choices: ['public', 'restricted'],
        })
        .option('tag', {
          describe: 'npm publish --tag <tag> - the dist-tag this version is published under (default "latest")',
          type: 'string',
        })
        .option('otp', {
          describe: 'npm publish --otp <otp> - a 2FA one-time password, for registries that require it',
          type: 'string',
        })
        .option('registry', {
          describe: 'Registry to check against and publish to (default: whatever .npmrc already configures)',
          type: 'string',
        })
        .option('userconfig', {
          describe: 'Path to a custom .npmrc to use for both the registry check and the actual publish',
          type: 'string',
        })
        .option('contents', {
          describe:
            "Subdirectory to publish from, relative to each package's own directory - only consulted when a " +
            'package has no "publishConfig.directory" of its own (that always wins when present)',
          type: 'string',
        }),
    handler: async args => {
      const options = {
        ignoreDirty: args.ignoreDirty as boolean | undefined,
        registry: args.registry as string | undefined,
        userconfig: args.userconfig as string | undefined,
      };
      const plan = await PublishService.getPlan(repository, options);
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

      if (!plan.some(e => e.status === 'publish')) {
        console.log(colors.gray('Nothing to publish.'));
        return;
      }

      if (args.dryRun) return;

      let proceed = !!args.yes;
      if (!proceed) {
        if (!process.stdout.isTTY) {
          console.log(colors.gray('Not a TTY - refusing to prompt. Pass --yes to publish non-interactively.'));
          return;
        }
        proceed = await confirm('Publish these packages?');
      }
      if (!proceed) return;

      const applied = await PublishService.applyPlan(repository, plan, {
        ...options,
        packageManager: args.packageManager as CiService.PackageManager | undefined,
        access: args.access as 'public' | 'restricted' | undefined,
        tag: args.tag as string | undefined,
        otp: args.otp as string | undefined,
        contents: args.contents as string | undefined,
      });

      let failed = false;
      for (const entry of applied) {
        if (entry.status === 'publish') {
          console.log(colors.green('published'), colors.cyan(entry.package.name), entry.version);
        } else if (entry.status === 'error' && plan.find(e => e.package === entry.package)?.status === 'publish') {
          failed = true;
          console.log(colors.red('failed'), colors.cyan(entry.package.name), colors.red(entry.reason ?? ''));
        }
      }
      if (failed) {
        const err: any = new Error('"publish" failed');
        err.logged = true;
        throw err;
      }
    },
  });
}

function printPlan(entries: PublishService.Entry[]): void {
  for (const e of entries) {
    const name = colors.cyan(e.package.name);
    switch (e.status) {
      case 'publish':
        console.log(colors.green('publish'), name, e.version, colors.gray(e.reason ?? ''));
        break;
      case 'up-to-date':
        console.log(colors.gray('up-to-date'), name, e.version);
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

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/N) `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'] as const;
