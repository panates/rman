import type { PublishFilesKeys, PublishTarget } from '../../../core/interfaces/publish-target.js';
import type { ConfigValue, ScopedVars } from '../../../interfaces/rman-config.interface.js';
import { SPM_TARGET, type SpmPublishService } from './spm-publish.service.js';

/**
 * **`publish.spm.*`** - this target's own config block, reaching `RmanConfig` through the
 * `PublishTargetConfigs` slot `publish.command.ts` exports, as `publish.docker.*` does.
 */
export interface SpmPublishOptions extends SpmPublishOptionsKeys, ScopedVars {}

export interface SpmPublishOptionsKeys extends PublishFilesKeys {
  /** Who may see the package: `"public"` or `"private"`. spm's own default - a new package is
   *  private - applies when unset. `--spm-access` overrides it. */
  access?: ConfigValue<'public' | 'private'>;
  /** The registry's address. spm's own default - `SB_REGISTRY_URL`, else registry.syncbridge.io -
   *  applies when unset. `--spm-registry` overrides it. */
  registry?: ConfigValue<string>;
}

/**
 * **The SyncBridge registry, as a publish target** - through `spm`, the way the `npm` target goes
 * through `npm`.
 *
 * Opt-in, so no `claims`: a package ships here by naming `"spm"` in its own `publish.target`. `spm`
 * itself comes from the repository - `@syncbridge/syncbuild` installed there - and is run from its
 * `node_modules/.bin`.
 */
/* **Built in rather than shipped by syncbuild - the user's call**: rman already carries the npm
 * registry's whole half (`npm view`, `npm publish`), and the SyncBridge registry is the same kind of
 * thing and ours. What is spm's stays in spm: the lookup is `spm view`, the publish `spm publish`,
 * and anything rman needs that spm cannot answer is asked of spm rather than reimplemented here. */
export const spmPublishTarget: PublishTarget = {
  name: SPM_TARGET,
  describe: 'Publish to the SyncBridge registry (spm publish)',
  options: {
    spmAccess: {
      target: 'cli',
      cliName: 'spm-access',
      describe:
        'Who may see a package published to the SyncBridge registry: public or private - over "publish.spm.access".',
      type: 'string',
    },
    spmRegistry: {
      target: 'cli',
      cliName: 'spm-registry',
      describe: 'The SyncBridge registry to publish to - over "publish.spm.registry" and SB_REGISTRY_URL.',
      type: 'string',
    },
  },
  getPlan(ctx) {
    return ctx.app.getService('spmPublish').getPlan(optionsOf(ctx));
  },
  applyPlan(ctx, plan) {
    /** The entries are this target's own - `getPlan` produced them. */
    return ctx.app.getService('spmPublish').applyPlan(plan as SpmPublishService.Entry[]);
  },
};

/** The shared filters plus this target's two flags - read here so the service takes a plain
 *  options object and stays callable without a CLI. */
function optionsOf(ctx: PublishTarget.Context): SpmPublishService.Options {
  return {
    ...ctx.options,
    access: ctx.args.spmAccess as SpmPublishService.Options['access'],
    registry: ctx.args.spmRegistry as string | undefined,
  };
}
