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
 * The case worth pinning is `publish.npm.directory`, because of how it now arrives. It was
 * `publish.directory`, merged into a `RmanConfig.PublishOptionsKeys` the **core** declared - a slot
 * the core had to know npm would want. It merges into `PublishTargetConfigs` instead, the slot
 * rman's `publish` command contributes for *any* target's block, and it is named after the target
 * the way the core's own `publish.docker` is. So this package brings the npm target's flags, its
 * registry check, and its config keys, and none of the three is written down in rman.
 */
describe('interfaces/rman-config', () => {
  it("adds this plugin's keys to the core's own config type", () => {
    const config: RmanNodeConfig = {
      /** `extends`, not `plugins: ['rman-node']` - a package name is not one of `plugins`' forms,
       *  which take the plugin itself or a glob naming modules that export one. This package's
       *  entry point exports a *config*, and `extends` is how a config is inherited. */
      extends: 'rman-node',
      packageManager: 'pnpm',
      '[*]': {
        clean: { include: 'build', exclude: ['keep.js'] },
        publish: { npm: { directory: 'build' } },
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
      /** `npm` from this package, `target` and `docker` from rman's own `publish` command and
       *  docker target - one key, three contributors, no collision. */
      publish: { npm: { directory: 'build' }, target: ['npm'], docker: { image: 'org/app' } },
    };
    expect(config.publish?.npm?.directory).toBe('build');
  });

  /**
   * **`clean.*` is a command contribution now, not a hand-written key.** `skip` is derived from
   * `clean.command.ts`'s own `config` block; `include`/`exclude` come through `Extra`, because a
   * `CommandOption` cannot say "a glob *or* a list of them" - and that union is what a config
   * author actually writes. All three have to survive the move.
   *
   * There is no `'+clean'` here any more: the `+key` prefix is gone, and a closer layer adding to
   * what it inherited asks for `value` instead. Not written out as a function here, because the
   * *type* does not admit one - `include` is `string | string[]`, while at runtime any non-step key
   * may also be a value function. That gap is older than this change and is not what this case is
   * about.
   */
  it('delivers every clean key through the command contribution', () => {
    const config: RmanConfig = {
      clean: { include: 'build', skip: false },
      '[*]': { clean: { include: ['build', '*.tsbuildinfo'], exclude: 'keep.js' } },
    };
    expect(config.clean?.include).toBe('build');
  });

  it('catches a typo inside the contributed clean block', () => {
    // @ts-expect-error `includes` is not a key of `clean`
    const bad: RmanConfig = { clean: { includes: 'build' } };
    expect(bad).toBeDefined();
  });

  it('still catches a typo in one of them', () => {
    // @ts-expect-error `directry` is not a key of `publish.npm`
    const bad: RmanConfig = { publish: { npm: { directry: 'build' } } };
    expect(bad).toBeDefined();
  });

  /** The retired spelling no longer type-checks either - a typed JS config gets the rename at
   *  author time, where a YAML one only finds out when `publish` refuses to run. */
  it('no longer accepts the retired publish.directory', () => {
    // @ts-expect-error `directory` moved to `publish.npm.directory`
    const old: RmanConfig = { publish: { directory: 'build' } };
    expect(old).toBeDefined();
  });

  it('defineConfig returns its argument unchanged - a typing aid, not a transform', () => {
    const config: RmanNodeConfig = { packageManager: 'npm' };
    expect(defineConfig(config)).toBe(config);
  });
});
