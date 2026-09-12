import colors from 'ansi-colors';
import micromatch from 'micromatch';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { GitHelper } from './git.js';

/** Same idea as GitHub Actions' own `branches`/`branches-ignore` workflow filters - restricts a
 *  command to running only from certain branches (or refuses certain ones), instead of any. */
export interface BranchGuardOptions {
  allowBranch?: string | string[];
  ignoreBranch?: string | string[];
}

/** `--allow-branch`/`--ignore-branch`, the same shape and describe text in every command that
 *  supports them - mirrors `package-filter.ts`'s own `applyPackageFilterOptions`. */
export function applyBranchGuardOptions<T>(cmd: Argv<T>): Argv<T> {
  return cmd
    .option('allow-branch', {
      describe:
        'Refuse to run unless the current branch matches this glob (repeatable) - default: .rmanrc ' +
        '"allowBranch", or no restriction at all',
      type: 'string',
    })
    .option('ignore-branch', {
      describe:
        'Refuse to run if the current branch matches this glob (repeatable) - default: .rmanrc ' +
        '"ignoreBranch", or no restriction at all',
      type: 'string',
    });
}

export function readBranchGuardOptions(args: any): BranchGuardOptions {
  return {
    allowBranch: args.allowBranch as string | string[] | undefined,
    ignoreBranch: args.ignoreBranch as string | string[] | undefined,
  };
}

/**
 * Refuses to let the command continue when the current branch doesn't satisfy `options` - an
 * explicit CLI `allowBranch`/`ignoreBranch` replaces the root's own (cascade-free) `.rmanrc`
 * equivalent entirely, same as `packageManager`'s own CLI-over-config precedence; with neither
 * set anywhere, every branch is allowed (this is purely opt-in, same as GitHub Actions' workflows
 * running on every branch until a `branches:` filter is added). A detached HEAD (or a directory
 * that isn't a git repository at all) is never blocked - there's no branch name to check against.
 *
 * Already prints its own message and marks the error `logged` before throwing (matching every
 * other guard check's convention in this codebase, e.g. `version`'s own dirty-check) - callers
 * just need to `await` it before doing anything else.
 */
export async function assertAllowedBranch(repository: Repository, options: BranchGuardOptions = {}): Promise<void> {
  const allow = options.allowBranch ?? repository.config?.allowBranch;
  const ignore = options.ignoreBranch ?? repository.config?.ignoreBranch;
  if (!allow && !ignore) return;

  const git = new GitHelper({ cwd: repository.dirname });
  const branch = await git.currentBranch();
  if (!branch) return;

  if (allow && !micromatch.isMatch(branch, toArray(allow))) {
    fail(`Branch "${branch}" is not allowed to run this command (must match: ${toArray(allow).join(', ')})`);
  }
  if (ignore && micromatch.isMatch(branch, toArray(ignore))) {
    fail(`Branch "${branch}" is not allowed to run this command (blocked by: ${toArray(ignore).join(', ')})`);
  }
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function fail(message: string): never {
  console.log(colors.red(message));
  const err: any = new Error(message);
  err.logged = true;
  throw err;
}
