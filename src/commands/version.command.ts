import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import EasyTable from 'easy-table';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { VersionService } from '../services/version.service.js';
import { applyBranchGuardOptions, assertAllowedBranch, readBranchGuardOptions } from '../utils/branch-guard.js';
import { applyPackageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'version [bump]',
    describe: 'Bumps versions of changed packages (and their dependents), grouped via .rmanrc "group"',
    builder: cmd =>
      applyBranchGuardOptions(applyPackageFilterOptions(cmd))
        .example('$0 version patch', '# Bump patch severity directly, applied immediately')
        .example('$0 version', "# Auto-detect severity from commits, show the plan, don't write anything")
        .example('$0 version --interactive', '# Show the plan either way, then ask for confirmation')
        .example('$0 version patch --show', '# Preview what an explicit patch bump would do, without applying it')
        .positional('bump', {
          describe:
            'A release-type keyword ("patch"/"minor"/"major") or an explicit semver version. ' +
            'Omit to auto-detect from commits and only preview the plan.',
          type: 'string',
        })
        .option('interactive', {
          alias: 'i',
          describe: 'Show the plan and ask for confirmation before applying (with or without an explicit bump)',
          type: 'boolean',
        })
        .option('show', {
          describe:
            'Show the resulting plan for the given bump without applying it - unlike omitting bump ' +
            'entirely, this still uses the given release-type keyword/version to compute the plan, ' +
            'just never writes it.',
          type: 'boolean',
        })
        .conflicts('show', 'interactive')
        .option('yes', {
          alias: 'y',
          describe:
            'Skip the confirmation prompt and apply the computed plan immediately - auto-detected ' +
            'severity included, no explicit bump keyword required (same idea as "publish --yes").',
          type: 'boolean',
        })
        .conflicts('yes', 'interactive')
        .option('ignore-dirty', {
          describe: 'Exclude a package with uncommitted local changes instead of aborting the whole run',
          type: 'boolean',
        })
        .option('push', {
          describe: 'Push the resulting commit(s) and tag(s) to the remote once applied',
          type: 'boolean',
        })
        .option('message', {
          alias: 'm',
          describe:
            'Override the commit message for every group this run commits (default: .rmanrc ' +
            'version.commitMessage, or "chore(release): v{version}") - "{version}" is substituted ' +
            "when a commit's own group shares one version.",
          type: 'string',
        })
        .option('changelog', {
          describe:
            "Also write each bumped package's CHANGELOG.md (same as running changelog --write " +
            'separately) and fold it into the same commit as its version bump. Default: .rmanrc ' +
            '"version.changelog", or false - --no-changelog forces it off even when that\'s true.',
          type: 'boolean',
        })
        .option('preid', {
          describe:
            'Make the bump a prerelease with this identifier (e.g. "beta" -> 1.2.3-beta.0). ' +
            'Running again with the same --preid increments it (-> 1.2.3-beta.1); a different ' +
            'identifier starts a fresh prerelease line. Ignored when bump is an explicit semver version.',
          type: 'string',
        }),
    handler: async args => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      const bump = args.bump as string | undefined;
      const plan = await VersionService.getPlan(repository, {
        ...readPackageFilterOptions(args),
        bump,
        ignoreDirty: args.ignoreDirty as boolean | undefined,
        preid: args.preid as string | undefined,
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

      const changelog = (args.changelog as boolean | undefined) ?? repository.config?.version?.changelog ?? false;
      const applied = await VersionService.applyPlan(repository, plan, {
        push: args.push as boolean | undefined,
        message: args.message as string | undefined,
        changelog,
      });
      for (const entry of applied) {
        if (entry.status === 'bump') {
          console.log(
            colors.green('updated'),
            colors.cyan(entry.package.name),
            entry.from,
            '->',
            colors.yellow(entry.to!),
          );
        }
      }
    },
  });
}

function printPlan(entries: VersionService.Entry[]): void {
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

function statusLabel(status: VersionService.Entry['status']): string {
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
