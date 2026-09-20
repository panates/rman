import { expect } from 'expect';
import type { RmanConfig } from 'rman';
import { defineConfig, type RmanNodeConfig } from '../../src/interfaces/rman-config.interface.js';

/**
 * **What this package adds to `.rmanrc`, pinned at the type level.**
 *
 * Checked by `tsc --noEmit -p packages/node/test/tsconfig.json`, not by mocha - `npm test`
 * transpiles without type-checking, so a config type can be wrong indefinitely and every assertion
 * below still "passes". That is precisely the hole `npm run typecheck` exists to close.
 *
 * The case worth pinning is `publish.directory`, because of how it now arrives. It used to merge
 * into a `RmanConfig.PublishOptionsKeys` the **core** declared - a slot the core had to know npm
 * would want. It merges into `PublishTargetConfigs` instead, the slot rman's `publish` command
 * contributes for *any* target's block, beside the `docker` one the core's own target declares.
 * So this package now brings the npm target's flags, its registry check, and its config keys, and
 * none of the three is written down in rman.
 */
describe('interfaces/rman-config', () => {
  it("adds this plugin's keys to the core's own config type", () => {
    const config: RmanNodeConfig = {
      plugins: ['rman-node'],
      packageManager: 'pnpm',
      '[*]': {
        clean: { include: 'build', exclude: ['keep.js'] },
        publish: { directory: 'build' },
      },
    };
    expect(config.packageManager).toBe('pnpm');
  });

  /**
   * **And they reach the *core's* `RmanConfig` too, which is the point of augmenting rather than
   * declaring a second type.** `pkg.config` is typed by the core's, so `CleanService` reading
   * `pkg.config.clean` without a cast depends on exactly this.
   */
  it("merges into the core's RmanConfig, which is what pkg.config is typed by", () => {
    const config: RmanConfig = {
      packageManager: 'yarn',
      clean: { skip: true },
      /** `directory` from this package, `target` and `docker` from rman's own `publish` command and
       *  docker target - one key, three contributors, no collision. */
      publish: { directory: 'build', target: ['npm'], docker: { image: 'org/app' } },
    };
    expect(config.publish?.directory).toBe('build');
  });

  it('still catches a typo in one of them', () => {
    // @ts-expect-error `directry` is not a key of `publish`
    const bad: RmanConfig = { publish: { directry: 'build' } };
    expect(bad).toBeDefined();
  });

  it('defineConfig returns its argument unchanged - a typing aid, not a transform', () => {
    const config: RmanNodeConfig = { packageManager: 'npm' };
    expect(defineConfig(config)).toBe(config);
  });
});
