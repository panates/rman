import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { CiService } from '../services/ci.service.js';
import { DockerPublishService } from '../services/docker-publish.service.js';
import { GithubReleaseService } from '../services/github-release.service.js';
import { PublishService } from '../services/publish.service.js';
import { applyBranchGuardOptions, assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'publish',
    describe: 'Publishes every package to its configured target(s) (npm by default, or .rmanrc "publish.target")',
    builder: cmd =>
      applyBranchGuardOptions(applyPackageFilterOptions(cmd))
        .example('$0 publish', '# Show the plan, then ask for confirmation')
        .example('$0 publish --yes', '# Publish immediately, no confirmation')
        .example('$0 publish --dry-run', '# Only show the plan, never publish')
        .example('$0 publish --target docker', '# Only the packages configured for the "docker" target')
        .example('$0 publish --target github', '# Only the GitHub Release side of it')
        .option('yes', {
          alias: 'y',
          describe: 'Skip the confirmation prompt and publish immediately',
          type: 'boolean',
        })
        .option('dry-run', {
          describe: 'Only show the plan - never publishes, regardless of --yes',
          type: 'boolean',
        })
        .option('json', {
          alias: 'j',
          describe:
            'Print the plan as JSON instead of text - one entry per package and target. Combine with ' +
            '--dry-run to ask "is there anything to publish?" without publishing (e.g. a CI release gate).',
          type: 'boolean',
        })
        .option('target', {
          describe:
            'Restrict this run to just these publish target(s) ("npm"/"docker"/"github", repeatable) - default: ' +
            'every target each package itself is configured for (.rmanrc "publish.target", "npm" when unset). ' +
            'A package that opts into "docker" but has no "publish.docker" config errors clearly instead of ' +
            'being silently skipped.',
          type: 'array',
          choices: ['npm', 'docker', 'github'],
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
        })
        .option('docker-namespace', {
          describe:
            'Prefixed onto a bare (no "/") "publish.docker.image" - default: the DOCKERHUB_NAMESPACE ' +
            'environment variable.',
          type: 'string',
        })
        .option('github-repository', {
          describe:
            'The "owner/repo" GitHub Releases are created in - default: each package\'s own ' +
            '"publish.github.repository", falling back to the "origin" remote.',
          type: 'string',
        }),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      const targets = resolveTargets(args.target as string[] | undefined);
      const explicitTargets = !!(args.target as string[] | undefined)?.length;
      const explicitDockerTarget = explicitTargets && targets.has('docker');
      const explicitGithubTarget = explicitTargets && targets.has('github');
      const ignoreDirty = args.ignoreDirty as boolean | undefined;

      const npmOptions = {
        ...readPackageFilterOptions(args),
        ignoreDirty,
        registry: args.registry as string | undefined,
        userconfig: args.userconfig as string | undefined,
      };
      const dockerOptions = {
        ...readPackageFilterOptions(args),
        ignoreDirty,
        namespace: args.dockerNamespace as string | undefined,
      };
      // No package filtering: a GitHub Release belongs to the repository, not to a package, so
      // there is nothing for --scope/--ignore to narrow down.
      const githubOptions = { ignoreDirty, repository: args.githubRepository as string | undefined };

      const npmPlan = targets.has('npm') ? await PublishService.getPlan(repository, npmOptions) : [];
      const dockerPlan = targets.has('docker') ? await DockerPublishService.getPlan(repository, dockerOptions) : [];
      const githubPlan = targets.has('github') ? await GithubReleaseService.getPlan(repository, githubOptions) : [];

      if (args.json) {
        console.log(
          JSON.stringify(
            [
              ...npmPlan.map(e => jsonEntry(e, 'npm')),
              ...dockerPlan.map(e => jsonEntry(e, 'docker')),
              ...githubPlan.map(e => jsonEntry(e, 'github')),
            ],
            undefined,
            2,
          ),
        );
      } else {
        printPlan(npmPlan);
        printPlan(dockerPlan, 'docker');
        printPlan(githubPlan, 'github');
      }

      if (explicitDockerTarget && !dockerPlan.length) {
        const message = '--target docker was given, but no package\'s .rmanrc configures "publish.docker".';
        console.log(colors.red(message));
        const err: any = new Error(message);
        err.logged = true;
        throw err;
      }

      if (explicitGithubTarget && !githubPlan.length) {
        const message = '--target github was given, but nothing in .rmanrc opts into the "github" target.';
        console.log(colors.red(message));
        const err: any = new Error(message);
        err.logged = true;
        throw err;
      }

      const errors = [...npmPlan, ...dockerPlan, ...githubPlan].filter(e => e.status === 'error');
      if (errors.length) {
        const allDirty = errors.every(e => e.reason === 'uncommitted local changes');
        const message = allDirty
          ? `${errors.length} package(s) have uncommitted local changes ` +
            '(pass --ignore-dirty to exclude them instead of aborting)'
          : `${errors.length} package(s) failed to prepare for publish - see the errors above`;
        console.log(colors.red(message));
        const err: any = new Error(message);
        err.logged = true;
        throw err;
      }

      if (![...npmPlan, ...dockerPlan, ...githubPlan].some(e => e.status === 'publish')) {
        if (!args.json) console.log(colors.gray('Nothing to publish.'));
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

      const appliedNpm = targets.has('npm')
        ? await PublishService.applyPlan(repository, npmPlan, {
            ...npmOptions,
            packageManager: args.packageManager as CiService.PackageManager | undefined,
            access: args.access as 'public' | 'restricted' | undefined,
            tag: args.tag as string | undefined,
            otp: args.otp as string | undefined,
            contents: args.contents as string | undefined,
          })
        : [];
      const appliedDocker = targets.has('docker') ? await DockerPublishService.applyPlan(repository, dockerPlan) : [];
      const appliedGithub = targets.has('github') ? await GithubReleaseService.applyPlan(repository, githubPlan) : [];

      let failed = false;
      for (const entry of appliedNpm) {
        if (entry.status === 'publish') {
          console.log(colors.green('published'), colors.cyan(entry.package.name), entry.version);
        } else if (entry.status === 'error' && npmPlan.find(e => e.package === entry.package)?.status === 'publish') {
          failed = true;
          console.log(colors.red('failed'), colors.cyan(entry.package.name), colors.red(entry.reason ?? ''));
        }
      }
      for (const entry of appliedDocker) {
        if (entry.status === 'publish') {
          console.log(colors.green('published'), colors.gray('[docker]'), colors.cyan(entry.package.name), entry.image);
        } else if (
          entry.status === 'error' &&
          dockerPlan.find(e => e.package === entry.package)?.status === 'publish'
        ) {
          failed = true;
          console.log(
            colors.red('failed'),
            colors.gray('[docker]'),
            colors.cyan(entry.package.name),
            colors.red(entry.reason ?? ''),
          );
        }
      }
      for (const entry of appliedGithub) {
        if (entry.status === 'publish') {
          console.log(colors.green('released'), colors.gray('[github]'), colors.cyan(entry.tag ?? ''));
        } else if (
          entry.status === 'error' &&
          githubPlan.find(e => e.package === entry.package)?.status === 'publish'
        ) {
          failed = true;
          console.log(
            colors.red('failed'),
            colors.gray('[github]'),
            colors.cyan(entry.package.name),
            colors.red(entry.reason ?? ''),
          );
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

function resolveTargets(input: string[] | undefined): Set<RmanConfig.PublishTarget> {
  if (!input?.length) return new Set(['npm', 'docker', 'github']);
  return new Set(input as RmanConfig.PublishTarget[]);
}

/** Shared shape of both `PublishService.Entry` and `DockerPublishService.Entry` - just enough for
 *  `printPlan` to render either, so npm and docker plans print through the same code. */
interface PrintableEntry {
  package: Package;
  version: string;
  status: 'publish' | 'skip' | 'up-to-date' | 'error';
  reason?: string;
}

/** One `--json` row. `target` is what distinguishes otherwise-identical rows for a package that
 *  ships to several targets at once, so a consumer can tell which one still needs publishing. */
function jsonEntry(entry: PrintableEntry, target: RmanConfig.PublishTarget) {
  return {
    name: entry.package.name,
    target,
    status: entry.status,
    version: entry.version,
    reason: entry.reason,
  };
}

function printPlan(entries: PrintableEntry[], label?: string): void {
  const prefix = label ? colors.gray(`[${label}] `) : '';
  for (const e of entries) {
    const name = prefix + colors.cyan(e.package.name);
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
