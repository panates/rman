import type { Package } from '../../../core/classes/package.js';
import type { PublishTarget } from '../../../core/interfaces/publish-target.js';
import { CiService } from '../../platforms/node/services/ci.service.js';
import { PublishService } from '../../platforms/node/services/publish.service.js';

/** The name this target answers to in `publish.target` and `--target`. */
export const NPM_TARGET = 'npm';

/**
 * **npm, as a publish target** - what is left of the old `rman-node` `publish` command once the command
 * itself went back to the core where it belonged.
 *
 * The split is worth stating, because it is the whole point of the move: everything about
 * *publishing a repository* - which packages are candidates, dependency order, the plan/confirm/
 * apply shape, `--dry-run`, the JSON a CI gate reads - is the core's and always was. What is npm's
 * is this file: seven flags, one registry question, and one push. A Cargo or Maven target is the
 * same size.
 *
 * **`claims` is the other half, and it fixes a real bug.** The core used to default a package with
 * no `publish.target` to `['npm']`, which is a statement only an ecosystem can make - so a Cargo
 * package beside a Node one was reported by `rman list --json` as shipping to npm, and treated by
 * `publish` as an npm candidate. Asking `pkg.provider === 'node'` puts the answer where the
 * knowledge is: this plugin read that manifest, so this plugin is the one that can say so.
 *
 * A class, like `NodePlugin` and `NodeManifestProvider`: a config declares it as
 * `publishTargets: [new NpmPublishTarget()]`, which is one shape for everything a plugin package
 * contributes rather than an object literal here and a class there.
 */
export class NpmPublishTarget implements PublishTarget {
  name = NPM_TARGET;
  describe = 'Publish to an npm registry (npm/yarn/pnpm/bun publish)';

  /** npm's alone: a package rman read through the `node` platform. */
  platforms = ['node'];

  options = {
    packageManager: {
      target: 'cli',
      cliName: 'package-manager',
      describe: 'Package manager to publish with (default: .rmanrc "packageManager.node", else npm)',
      choices: CiService.PACKAGE_MANAGERS,
    },
    access: {
      target: 'cli',
      describe: 'npm publish --access <public|restricted> - required by the registry for a new scoped package',
      choices: ['public', 'restricted'],
    },
    tag: {
      target: 'cli',
      describe:
        'npm publish --tag <tag> - overrides the dist-tag. A prerelease already publishes under its ' +
        'own identifier (2.0.0-beta.1 -> "beta") and a release under "latest", so this is rarely needed',
      type: 'string',
    },
    otp: {
      target: 'cli',
      describe: 'npm publish --otp <otp> - a 2FA one-time password, for registries that require it',
      type: 'string',
    },
    staged: {
      target: 'cli',
      describe:
        "npm stage publish - hold each version in npm's staging queue instead of publishing it, " +
        'until a maintainer runs "npm stage approve" with 2FA. --no-staged forces a direct publish ' +
        'over .rmanrc "publish.npm.staged"',
      type: 'boolean',
    },
    registry: {
      target: 'cli',
      describe:
        'Registry to check against and publish to, for every package in this run. Overrides each ' +
        'package\'s own "publishConfig.registry"; with neither, npm resolves .npmrc itself',
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
  } satisfies PublishTarget['options'];

  /** npm's `private` rule, the same function `getPlan` asks. */
  skipReason(pkg: Package) {
    return PublishService.skipReason(pkg);
  }

  /** The registry's host where `publishConfig.registry` names one other than npm's own. */
  labelFor(pkg: Package) {
    return PublishService.registryLabel(pkg);
  }

  getPlan(ctx: PublishTarget.Context) {
    return PublishService.getPlan(ctx.repository, this.planOptions(ctx));
  }

  applyPlan(ctx: PublishTarget.Context, plan: PublishTarget.Entry[]) {
    return PublishService.applyPlan(ctx.repository, plan as PublishService.Entry[], {
      ...this.planOptions(ctx),
      packageManager: ctx.args.packageManager,
      access: ctx.args.access,
      otp: ctx.args.otp,
    });
  }

  /** The shared filters plus the two flags both halves need - read here rather than in the
   *  service, which keeps taking a plain options object and stays callable without a CLI. */
  waitUntilAvailable(ctx: PublishTarget.Context, published: PublishTarget.Entry[]) {
    return PublishService.waitUntilAvailable(published as PublishService.Entry[], {
      registry: ctx.args.registry as string | undefined,
      userconfig: ctx.args.userconfig as string | undefined,
    });
  }

  protected planOptions(ctx: PublishTarget.Context): PublishService.Options {
    return {
      ...ctx.options,
      registry: ctx.args.registry as string | undefined,
      userconfig: ctx.args.userconfig as string | undefined,
      /** Read at *plan* time too, not only where the publish command is built: the plan is what
       *  decides the dist-tag and refuses the two cases with nothing to derive, so `--dry-run` and
       *  the JSON a pipeline gates on have to see the flag. */
      tag: ctx.args.tag as string | undefined,
      /** Plan-time for the same reason, and a stronger one: whether a run leaves the version live
       *  or waiting for an approval is the thing a reader is confirming. Left `undefined` when the
       *  flag was not given, so each package's own `publish.npm.staged` still decides - `false`
       *  here would mean `--no-staged` and silently overrule the config. */
      staged: ctx.args.staged as boolean | undefined,
      /** The plan decides from the manifest in the directory being published, so it has to know
       *  which directory that is. */
      contents: ctx.args.contents as string | undefined,
    };
  }
}
