import type { PublishFilesKeys, PublishTarget } from '../../../core/interfaces/publish-target.js';
import type { ConfigValue, ScopedVars } from '../../../interfaces/rman-config.interface.js';
import { CLOUDFLARE_TARGET, type CloudflarePublishService } from './cloudflare-publish.service.js';

/**
 * **`publish.cloudflare.*`** - this target's own config block, declared beside it and reaching
 * `RmanConfig` through the `PublishTargetConfigs` slot `publish.command.ts` exports, as
 * `publish.docker.*` does.
 *
 * Required once `"cloudflare"` is one of a package's `publish.target`s.
 */
export interface CloudflarePublishOptions extends CloudflarePublishOptionsKeys, ScopedVars {}

export interface CloudflarePublishOptionsKeys extends PublishFilesKeys {
  /**
   * What the package deploys as: `"pages"` - a directory of static files uploaded to a Pages
   * project (`wrangler pages deploy`) - or `"workers"` - a Worker, static assets included, as its
   * own wrangler configuration describes it (`wrangler deploy`).
   */
  kind: ConfigValue<'pages' | 'workers'>;
  /** Pages: the project to deploy to. Required for `"pages"`. */
  project?: ConfigValue<string>;
  /** Pages: the branch the deployment is made for - the project's production branch puts it live.
   *  Default `"main"`. */
  branch?: ConfigValue<string>;
  /** Pages: the directory to upload, relative to the package. Default `"dist"`. */
  directory?: ConfigValue<string>;
  /** Workers: the wrangler configuration file, relative to the package. Default: the first of
   *  `wrangler.jsonc`, `wrangler.json`, `wrangler.toml` in the package. */
  config?: ConfigValue<string>;
  /** Workers: the wrangler environment to deploy (`--env`) - one the configuration declares,
   *  `staging` or `production`. */
  env?: ConfigValue<string>;
  /** Workers: variables the Worker reads from `env` at run time (`--var NAME:value`), over the
   *  configuration's own `vars`. Not for secrets - they show in the dashboard; those are
   *  `wrangler secret`'s. Pages takes none from the command line: a file through `files` instead. */
  /* **`variables`, not wrangler's `vars`**: `vars` is reserved at every level of an rman config -
   * it is the `${{ vars.x }}` scope, consumed by the interpolator - so a key by that name here would
   * never reach the target. The type said so first: it cannot extend both this and `ScopedVars`. */
  variables?: ConfigValue<Record<string, string>>;
}

/**
 * **Cloudflare, as a publish target** - a static site on Pages, or a Worker with its assets.
 *
 * Opt-in like `docker`, so no `claims`: a package deploys here only by naming `"cloudflare"` in
 * its own `publish.target`. What that buys over a workflow running `wrangler` on its own is what
 * every target gets from `publish`: `publish.skip`, `--dry-run` and `--json`, and a deploy that
 * happens once per version rather than once per merge.
 */
/* **Last, with `docker`.** A site's build installs from the registries the other targets publish
 * to, so it waits for what they published - the same reason `docker` runs last. */
export const cloudflarePublishTarget: PublishTarget = {
  name: CLOUDFLARE_TARGET,
  describe: 'Deploy to Cloudflare Pages or Workers (wrangler)',
  publishesLast: true,
  getPlan(ctx) {
    return ctx.app.getService('cloudflarePublish').getPlan(ctx.options);
  },
  applyPlan(ctx, plan) {
    /** The entries are this target's own - `getPlan` produced them. */
    return ctx.app.getService('cloudflarePublish').applyPlan(plan as CloudflarePublishService.Entry[]);
  },
};
