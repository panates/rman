import type { Package, PublishTarget } from 'rman';
import { CiService } from '../services/ci.service.js';
import { PublishService } from '../services/publish.service.js';

/** The name this target answers to in `publish.target` and `--target`. */
export const NPM_TARGET = 'npm';

/**
 * **npm, as a publish target** - what is left of `rman-node`'s `publish` command once the command
 * itself went back to the core where it belonged.
 *
 * The split is worth stating, because it is the whole point of the move: everything about
 * *publishing a repository* - which packages are candidates, dependency order, the plan/confirm/
 * apply shape, `--dry-run`, the JSON a CI gate reads - is the core's and always was. What is npm's
 * is this file: seven flags, one registry question (`npm view`), and one push. A Cargo or Maven
 * target is the same size.
 *
 * **`claims` is the other half, and it fixes a real bug.** The core used to default a package with
 * no `publish.target` to `['npm']`, which is a statement only an ecosystem can make - so a Cargo
 * package beside a Node one was reported by `rman list --json` as shipping to npm, and treated by
 * `publish` as an npm candidate. Asking `pkg.provider === 'node'` puts the answer where the
 * knowledge is: this plugin read that manifest, so this plugin is the one that can say so.
 */
export const npmPublishTarget: PublishTarget = {
  name: NPM_TARGET,
  describe: 'Publish to an npm registry (npm/yarn/pnpm/bun publish)',
  claims(pkg: Package): boolean {
    return pkg.provider === 'node';
  },
  options: {
    packageManager: {
      target: 'cli',
      cliName: 'package-manager',
      describe: 'Package manager to publish with (default: npm, or .rmanrc "packageManager")',
      choices: CiService.PACKAGE_MANAGERS,
    },
    access: {
      target: 'cli',
      describe: 'npm publish --access <public|restricted> - required by the registry for a new scoped package',
      choices: ['public', 'restricted'],
    },
    tag: {
      target: 'cli',
      describe: 'npm publish --tag <tag> - the dist-tag this version is published under (default "latest")',
      type: 'string',
    },
    otp: {
      target: 'cli',
      describe: 'npm publish --otp <otp> - a 2FA one-time password, for registries that require it',
      type: 'string',
    },
    registry: {
      target: 'cli',
      describe: 'Registry to check against and publish to (default: whatever .npmrc already configures)',
      type: 'string',
    },
    userconfig: {
      target: 'cli',
      describe: 'Path to a custom .npmrc to use for both the registry check and the actual publish',
      type: 'string',
    },
    contents: {
      target: 'cli',
      describe:
        "Subdirectory to publish from, relative to each package's own directory - only consulted when a " +
        'package has no "publishConfig.directory" of its own (that always wins when present)',
      type: 'string',
    },
  },
  getPlan(ctx) {
    return PublishService.getPlan(ctx.repository, planOptions(ctx));
  },
  applyPlan(ctx, plan) {
    return PublishService.applyPlan(ctx.repository, plan as PublishService.Entry[], {
      ...planOptions(ctx),
      packageManager: ctx.args.packageManager,
      access: ctx.args.access,
      tag: ctx.args.tag,
      otp: ctx.args.otp,
      contents: ctx.args.contents,
    });
  },
};

/** The shared filters plus the two flags both halves need - read here rather than in the service,
 *  which keeps taking a plain options object and stays callable without a CLI. */
function planOptions(ctx: PublishTarget.Context): PublishService.Options {
  return {
    ...ctx.options,
    registry: ctx.args.registry as string | undefined,
    userconfig: ctx.args.userconfig as string | undefined,
  };
}
