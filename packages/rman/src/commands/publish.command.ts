import readline from 'node:readline/promises';
import colors from 'ansi-colors';
import type { RmanApplication } from '../core/application.js';
import type { Package } from '../core/package.js';
import { type PublishTarget, unknownTargets } from '../core/publish-target.js';
import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import type { DockerPublishOptions } from '../targets/docker.target.js';
import { assertAllowedBranch, branchGuardOptions, readBranchGuardOptions } from '../utils/branch-guard.js';
import { packageFilterOptions, readPackageFilterOptions } from '../utils/package-filter.js';

/** Hoisted for `ArgsOf` - see `version.command.ts` and `RmanConfig.ArgsOf` for why. */
const COMMAND = 'publish' as const;

/**
 * **The options that belong to publishing, rather than to any one registry.**
 *
 * Everything npm-shaped that used to sit beside them - `--access`, `--tag`, `--otp`, `--registry`,
 * `--userconfig`, `--contents`, `--package-manager` - is declared by the `npm` target now, and
 * `--docker-namespace` by the `docker` one. They are merged in at build time (see below), so
 * `rman publish --help` lists exactly the flags the targets this repository actually has.
 */
const config = {
  ...packageFilterOptions,
  ...branchGuardOptions,
  yes: {
    target: 'cli',
    alias: 'y',
    describe: 'Skip the confirmation prompt and publish immediately',
    type: 'boolean',
  },
  dryRun: {
    target: 'cli',
    cliName: 'dry-run',
    describe: 'Only show the plan - never publishes, regardless of --yes',
    type: 'boolean',
  },
  json: {
    target: 'cli',
    alias: 'j',
    describe:
      'Print the plan as JSON instead of text - one entry per package and target. Combine with ' +
      '--dry-run to ask "is there anything to publish?" without publishing (e.g. a CI release gate).',
    type: 'boolean',
  },
  ignoreDirty: {
    target: 'cli',
    cliName: 'ignore-dirty',
    describe: 'Exclude a package with uncommitted local changes instead of aborting the whole run',
    type: 'boolean',
  },
  /**
   * `target: 'both'` because it is genuinely both: `--target docker` for one run, `publish.target`
   * in a `.rmanrc` for a package's standing answer. Its `choices` cannot be written here - which
   * targets exist is whatever the repository's plugins contribute - so they are filled in from the
   * registry where the command is built.
   */
  target: {
    target: 'both',
    describe:
      'Restrict this run to just these publish target(s) (repeatable) - default: every target ' +
      'each package itself is configured for (.rmanrc "publish.target"), or the targets that claim ' +
      "it when it configures none. A package that opts into a target but leaves out that target's " +
      'own config errors clearly instead of being silently skipped.',
    type: 'array',
  },
  skip: {
    target: 'config',
    describe:
      'Excludes this package from publish entirely (every target), regardless of "target" or ' +
      '"private" - a single, explicit "never published" statement. "changelog" honours it too.',
    type: 'boolean',
  },
} satisfies Record<string, RmanConfig.CommandOption>;

/**
 * The rest of `publish.*`: **one block per target, contributed by the target**.
 *
 * `PublishTargetConfigs` is an empty interface on purpose - an extension point rather than a list.
 * `docker` below is the core's own target declaring its block; `rman-node` adds `directory` from
 * its own package the same way. Neither could be written here: which targets exist is whatever the
 * repository's plugins contribute.
 *
 * **It had to be a slot, not two declarations of `publish`.** A key that arrives from two places is
 * `Interface 'RmanConfig' cannot simultaneously extend types ... Named property 'publish' of types
 * ... are not identical` (measured) - so `publish` is contributed once, here, and everything under
 * it merges into this one interface first.
 */
export interface PublishExtraKeys extends PublishTargetConfigs {}

/** Where a target declares its own `publish.<target>` config block. Augmented, never edited. */
export interface PublishTargetConfigs {
  /** Required once `"docker"` is one of a package's `publish.target`s - `publish --target docker`
   *  errors clearly on a package that opts in here but leaves this out. */
  docker?: DockerPublishOptions;
}

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

/**
 * `rman publish` - the repository's half of question B: which packages' current version is not out
 * there yet, and pushing the ones that are not.
 *
 * **This was `rman-node`'s command until the targets became contributions**, and that had the
 * ownership backwards. Everything here is about a repository - which packages are candidates, what
 * order to push them in (dependencies first), the plan/confirm/apply shape, `--dry-run`, the JSON a
 * CI gate reads - and none of it is npm's. What *is* npm's is one answer to "is this version on the
 * registry, and how do I push it", which is `PublishTarget`. The measured consequence of the old
 * arrangement: `publish --target docker` in a repository with no JavaScript in it required
 * installing a Node plugin to reach a Docker push the core had implemented all along.
 *
 * Never looks at whether `version` ran - it inspects what is on disk and on each registry, so it
 * behaves the same right after a bump or days later, and re-running is safe.
 */
const publishCommand = registerCommand(app => {
  const repository = app.repository;
  const targets = app.publishTargets.all;

  return {
    command: COMMAND,
    describe: 'Publishes every package to its configured target(s) - see .rmanrc "publish.target"',
    /** `group` is not read here, but `allowBranch`/`ignoreBranch` are - through the shared
     *  branch-guard group, which only exposes them as flags. */
    configKeys: ['allowBranch', 'ignoreBranch'],
    config: {
      ...config,
      /** Filled in from the registry: `--target` can only offer what this repository installed. */
      target: { ...config.target, choices: targets.map(t => t.name) },
      ...targetOptions(targets),
    },
    examples: [
      { command: '$0 publish', description: '# Show the plan, then ask for confirmation' },
      { command: '$0 publish --yes', description: '# Publish immediately, no confirmation' },
      { command: '$0 publish --dry-run', description: '# Only show the plan, never publish' },
      ...(targets.length > 1
        ? [
            {
              command: `$0 publish --target ${targets[targets.length - 1]!.name}`,
              description: '# Only the packages configured for that one target',
            },
          ]
        : []),
    ],
    handler: async (args: Args) => {
      await assertAllowedBranch(repository, readBranchGuardOptions(args));
      const requested = args.target as string[] | undefined;
      const selected = selectTargets(targets, requested);
      const ctx: PublishTarget.Context = {
        app,
        repository,
        options: { ...readPackageFilterOptions(args), ignoreDirty: args.ignoreDirty },
        args: args as Record<string, any>,
      };

      assertDeclaredTargetsExist(app, repository.getPackages());

      const plans = new Map<PublishTarget, PublishTarget.Entry[]>();
      for (const target of selected) plans.set(target, await target.getPlan(ctx));

      if (args.json) {
        console.log(JSON.stringify(jsonPlan(plans), undefined, 2));
      } else {
        for (const [target, plan] of plans) printPlan(plan, target.name);
      }

      /** An explicitly requested target that matched nothing is a mistake worth reporting: the run
       *  asked for something by name and silently got an empty plan back. */
      if (requested?.length) {
        const empty = [...plans].filter(([, plan]) => !plan.length).map(([target]) => target.name);
        if (empty.length) {
          throw logged(
            `--target ${empty.join(', ')} was given, but no package ships there ` + '(see .rmanrc "publish.target").',
          );
        }
      }

      const all = [...plans.values()].flat();
      const errors = all.filter(e => e.status === 'error');
      if (errors.length) {
        const allDirty = errors.every(e => e.reason === 'uncommitted local changes');
        throw logged(
          allDirty
            ? `${errors.length} package(s) have uncommitted local changes ` +
                '(pass --ignore-dirty to exclude them instead of aborting)'
            : `${errors.length} package(s) failed to prepare for publish - see the errors above`,
        );
      }

      if (!all.some(e => e.status === 'publish')) {
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

      let failed = false;
      for (const [target, plan] of plans) {
        const applied = await target.applyPlan(ctx, plan);
        if (printApplied(applied, plan, target.name)) failed = true;
      }
      if (failed) throw logged('"publish" failed');
    },
  };
});

export default publishCommand;

/**
 * `publish`'s own keys on `RmanConfig`: `target` and `skip` derived from the `config` block, plus
 * every target's own block through `PublishExtraKeys`.
 *
 * So a target contributes its config type as well as its flags now - `publish.docker.*` is declared
 * by the core's docker target and `publish.npm.directory` by `rman-node`'s npm one, each from its own
 * package, and neither can collide with the other or with what the command derives.
 */
declare module '../interfaces/rman-config.interface.js' {
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<
      ReturnType<typeof publishCommand>,
      PublishExtraKeys
    > {}
  }
}

/**
 * Every registered target's own flags, flattened into one block.
 *
 * **A collision is refused rather than resolved.** Two targets both wanting `--registry` is a real
 * possibility (npm has one, so does a hypothetical Cargo), and any rule for picking a winner -
 * registration order, prefixing, last wins - produces a flag that silently means the other
 * target's thing. Naming it for the target (`--docker-namespace`) is the fix, and the error says so.
 */
function targetOptions(targets: readonly PublishTarget[]): Record<string, RmanConfig.CommandOption> {
  const merged: Record<string, RmanConfig.CommandOption> = {};
  const owners = new Map<string, string>();
  for (const target of targets) {
    for (const [key, option] of Object.entries(target.options ?? {})) {
      const owner = owners.get(key);
      if (owner) {
        throw new Error(
          `Publish targets "${owner}" and "${target.name}" both declare an option named "${key}" - ` +
            'name it for the target it belongs to (e.g. "docker-namespace").',
        );
      }
      owners.set(key, target.name);
      merged[key] = option;
    }
  }
  return merged;
}

/** `--target` narrows the run; omitting it means every registered target, each of which then
 *  decides for itself which packages are its own. */
function selectTargets(targets: readonly PublishTarget[], requested: string[] | undefined): PublishTarget[] {
  if (!requested?.length) return [...targets];
  const known = new Map(targets.map(t => [t.name, t]));
  return requested.map(name => {
    const target = known.get(name);
    if (!target) {
      throw logged(`Unknown publish target "${name}" - this repository has: ${[...known.keys()].join(', ')}.`);
    }
    return target;
  });
}

/**
 * A package naming a target nothing implements.
 *
 * This used to be impossible to get wrong - `publish.target` was typed `'npm' | 'docker'` and
 * `--target` had those two as `choices`. With targets contributed, the core cannot enumerate them,
 * so the check moves to where the facts are. Silence here would mean a package quietly publishing
 * nowhere, which is the failure mode `publish` exists to rule out.
 */
function assertDeclaredTargetsExist(app: RmanApplication, packages: Package[]): void {
  const offenders = packages
    .map(pkg => ({ pkg, unknown: unknownTargets(app, pkg) }))
    .filter(({ unknown }) => unknown.length);
  if (!offenders.length) return;
  const installed = app.publishTargets.all.map(t => t.name).join(', ') || '(none)';
  throw logged(
    offenders.map(({ pkg, unknown }) => `"${pkg.name}" declares publish target(s) ${unknown.join(', ')}`).join('; ') +
      ` - this repository has: ${installed}.`,
  );
}

/** One `--json` row per package *and target*: a package shipping to two registries needs two, or a
 *  consumer cannot tell which of them still has something to do. */
function jsonPlan(plans: Map<PublishTarget, PublishTarget.Entry[]>) {
  return [...plans].flatMap(([target, plan]) =>
    plan.map(entry => ({
      name: entry.package.name,
      target: target.name,
      status: entry.status,
      version: entry.version,
      detail: entry.detail,
      reason: entry.reason,
    })),
  );
}

function printPlan(entries: PublishTarget.Entry[], label: string): void {
  const prefix = colors.gray(`[${label}] `);
  for (const e of entries) {
    const name = prefix + colors.cyan(e.package.name);
    switch (e.status) {
      case 'publish':
        /** `detail` belongs on this line, not only on the "published" one after the fact: it is
         *  where a target says *where* the package is going - npm's dist-tag, docker's resolved
         *  `<namespace>/<image>` - and the plan is what the reader is being asked to confirm. */
        console.log(
          colors.green('publish'),
          name,
          e.version,
          ...(e.detail ? [colors.cyan(e.detail)] : []),
          colors.gray(e.reason ?? ''),
        );
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

/**
 * What one target actually did. Returns whether anything it was asked to publish failed.
 *
 * An `'error'` is only reported when the *plan* said `'publish'` for that package: an entry that
 * was already an error before anything ran has been printed once by `printPlan`, and printing it
 * again under "failed" would read as a push that was attempted and did not work.
 */
function printApplied(applied: PublishTarget.Entry[], plan: PublishTarget.Entry[], label: string): boolean {
  const prefix = colors.gray(`[${label}] `);
  let failed = false;
  for (const entry of applied) {
    if (entry.status === 'publish') {
      console.log(colors.green('published'), prefix + colors.cyan(entry.package.name), entry.detail ?? entry.version);
    } else if (entry.status === 'error' && plan.find(e => e.package === entry.package)?.status === 'publish') {
      failed = true;
      console.log(colors.red('failed'), prefix + colors.cyan(entry.package.name), colors.red(entry.reason ?? ''));
    }
  }
  return failed;
}

/** The `logged` convention: printed here, so `runCli`'s catch does not print it a second time. */
function logged(message: string): Error {
  console.log(colors.red(message));
  const err: any = new Error(message);
  err.logged = true;
  return err;
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
