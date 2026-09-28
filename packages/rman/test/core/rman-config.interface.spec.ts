import { expect } from 'expect';
import type { Package } from '../../src/core/classes/package.js';
import type { RunStepValue } from '../../src/core/interfaces/run-step.js';
import type { RmanConfig } from '../../src/interfaces/rman-config.interface.js';
import { defineConfig } from '../../src/interfaces/rman-config.interface.js';

/**
 * **The config type, pinned by `tsc` rather than by mocha.** Every case here is an assertion about
 * what `RmanConfig` and `ResolvedConfig` admit; the `expect` calls only give mocha something to
 * run, and the real check is `npm run typecheck`, which is the reason this file exists at all -
 * mocha transpiles without type-checking, so a spec can be wrong about a type indefinitely.
 *
 * It was `core/config.spec.ts`, beside the module that held both the types and the resolving. The
 * resolving is `ConfigInterpolator`'s and `ConfigFileScope`'s now, each with its own spec; what is
 * left is the type, and it lives in `interfaces/`.
 */
describe('interfaces/RmanConfig', () => {
  describe('defineConfig()', () => {
    it('returns the given config object completely unchanged - a typing aid, not a transform', () => {
      /** Core keys only - `packageManager` left with `rman-node`, and a core spec must not need a
       *  plugin loaded to type its own fixture. */
      const config: RmanConfig = { logLevel: 'silent', group: false };
      expect(defineConfig(config)).toBe(config);
    });
  });

  /**
   * **A type-level check, run by `tsc` over the test tree rather than by mocha.** The runtime rule
   * is general - any object node may carry `vars` and scopes its subtree - while a type can only
   * say it one interface at a time, so the two can drift apart in exactly one direction: a nested
   * options interface that forgot to extend `ScopedVars`. It did drift, and the assertion below is
   * what would have caught it - `vars` worked at every level and type-checked at none.
   *
   * `tsc --noEmit -p packages/rman/test/tsconfig.json` is what enforces this; `npm test` does not
   * type-check.
   */
  describe('ScopedVars', () => {
    it('is accepted wherever the runtime scopes it', () => {
      const config: RmanConfig = {
        vars: { x: 1 },
        run: {
          build: { vars: { x: 3 }, exec: 'tsc -b' },
        },
        version: { vars: { x: 4 }, commitMessage: 'release' },
        changelog: { vars: { x: 5 } },
        publish: { vars: { x: 6 } },
        githubRelease: { vars: { x: 7 } },
      };
      /** Nothing to assert at runtime: the declaration above either compiles or it does not. */
      expect(config.run?.build).toEqual({ vars: { x: 3 }, exec: 'tsc -b' });

      /** `run.vars` is the one place the runtime scopes and the type does not - see `RunConfig`
       *  for the measurement behind that. It needs a cast, and the cast is what this pins. */
      const withRunVars: RmanConfig = {
        run: { vars: { x: 2 }, build: { exec: 'tsc' } } as RmanConfig['run'],
      };
      expect((withRunVars.run as Record<string, unknown>).vars).toEqual({ x: 2 });
    });
  });

  /**
   * **Every `run.<script>` key `RunService` actually reads, pinned at the type level.**
   *
   * The two halves drift independently - `run.service.ts` reads a key, `RunScriptOptionsKeys`
   * declares one - and nothing connects them, so a key can exist on exactly one side indefinitely.
   * It did: `changed` was read at runtime (`resolveBool(..., 'changed', false)`) and missing from
   * the type, which meant a typed JS config could not write the thing that already worked.
   *
   * A `satisfies` rather than an annotation, so an excess key fails here instead of widening.
   */
  describe('RunScriptOptions', () => {
    it('accepts every key RunService reads', () => {
      const config = {
        run: {
          build: {
            // read off the root package: one scheduler, one answer for the whole batch
            concurrency: 2,
            progress: false,
            changed: true,
            changedSince: 'abc1234',
            // read both ways - the root's picks the sort, a package's own its dependency waiting
            topo: false,
            bail: false,
            // per package
            logLevel: 'verbose',
            skip: false,
            if: 'changed',
            override: true,
            before: 'node ./gen.js',
            exec: 'tsc -b',
            after: ['node ./copy.js', 'node ./stamp.js'],
          },
        },
      } satisfies RmanConfig;
      expect(config.run.build.changed).toBe(true);
    });

    it('rejects "parallel", which is the CLI flag rather than a config key', () => {
      const config: RmanConfig = {
        // @ts-expect-error `--parallel` is boolean|number on the CLI; the key it feeds is `concurrency`
        run: { build: { parallel: 4 } },
      };
      expect(config.run).toBeDefined();
    });
  });

  /**
   * **What a command contributes to `RmanConfig`, pinned at the type level.**
   *
   * `version`, `changelog`, `githubRelease` and `publish` are no longer written out in
   * `rman-config.interface.ts` - each command declares its own key, and `CommandContribution`
   * assembles the block. Four things have to survive that, and none of them is visible to mocha:
   * the derived keys, the hand-written `Extra` ones, the `+key` append forms, and `vars`.
   *
   * Checked by `tsc --noEmit -p packages/rman/test/tsconfig.json`, like `ScopedVars` above.
   */
  describe('command contributions', () => {
    it('carries the derived keys, the Extra ones, +key and vars alike', () => {
      const config: RmanConfig = {
        version: {
          /** Derived: an ordinary `target: 'config'` option on `version`. */
          commitMessage: 'chore(release): v{version}',
          releaseTagPattern: 'release-*',
          stampDockerfile: true,
          /** Derived from a `target: 'both'` option - the flag is `--changelog`. */
          changelog: true,
          /** `Extra`: no `CommandOption` can say "a path, or `{ file, constant }`". */
          stamp: ['src/constants.ts', { file: 'src/version.go', constant: 'Version' }],
          /** `Extra` again: a shell command, or a function, or a list of either. */
          before: ['echo before', ctx => void ctx.pkg.name],
        },
        /** `changelog` needs no `Extra` at all - every key of it is an option shape. */
        changelog: { tagPattern: '{name}@*', ignoreTypes: ['chore'], template: './tpl.md' },
        /** `array: true` beside `type: 'string'`, which is what keeps `assets` a `string[]`. */
        githubRelease: { assets: ['dist/*.tgz'], draft: false, repository: 'owner/repo' },
        publish: {
          target: ['docker'],
          skip: false,
          /** Contributed by the core's own docker target, through `PublishTargetConfigs`. */
          docker: { image: 'org/app', architectures: ['linux/arm64'] },
        },
      };
      expect(config.version?.commitMessage).toBe('chore(release): v{version}');
    });

    /**
     * The negative control, and the reason the positive one means anything: excess-property
     * checking still fires *inside* a contributed block. Without it the assertions above would pass
     * for a `CommandConfigs` that had quietly widened to `any`.
     */
    it('still catches a typo inside a contributed block', () => {
      // @ts-expect-error `commitMesage` is not a key of `version`
      const bad: RmanConfig = { version: { commitMesage: 'typo' } };
      expect(bad).toBeDefined();
    });
  });

  /**
   * **`RmanConfig` is the author's view, `ResolvedConfig` the reader's - and both halves are pinned
   * here, by `tsc` over the test tree rather than by mocha.**
   *
   * The runtime behaviour has its own specs (`repository.spec.ts`: a function is called per
   * package, `value` chains, a failure names the path). What those cannot catch is the type going
   * quiet: a widening that also widened the reader, or a narrowing that ate something it should not
   * have. Both mistakes compile in one direction only, which is what the controls below turn into
   * failures.
   */
  describe('the author view and the resolved view', () => {
    /** These are `tsc` assertions, but mocha still *runs* them - so the subject has to exist at
     *  runtime. A package with an empty resolved config is enough: every read below is optional. */
    const emptyPackage = () => ({ config: {} }) as unknown as Package;

    it('lets an author write a function wherever rman computes a value', () => {
      const config: RmanConfig = {
        /** Derived from a `target: 'config'` option - the whole derived half is a `ConfigValue`,
         *  which needs no per-key decision (see `CommandConfigFromMetadata`). */
        changelog: { filePath: ({ vars }) => `${vars.notesDir}/NOTES.md` },
        version: {
          commitMessage: ({ pkg }) => `release ${pkg.name}`,
          /** An `Extra` key decided by hand, because that interface also holds steps. */
          stamp: ({ pkg }) => [`src/${pkg.basename}-version.ts`],
          /** A step, unwrapped, still takes its own kind of function. */
          before: [ctx => void ctx.pkg.name],
        },
        /** A publish target's block, contributed through `PublishTargetConfigs`. */
        publish: { docker: { image: ({ pkg }) => `org/${pkg.unscopedName}` } },
        /** And a plain value is still a plain value everywhere. */
        githubRelease: { draft: false },
      };
      expect(typeof config.changelog?.filePath).toBe('function');
    });

    it('hands a reader the value, with the function already gone', () => {
      const pkg = emptyPackage();

      /** No `typeof === 'function'` and no cast: `interpolateConfig` already called it. */
      const filePath: string | undefined = pkg.config.changelog?.filePath;
      const image: string | undefined = pkg.config.publish?.docker?.image;
      expect([filePath, image]).toBeDefined();
    });

    /**
     * **Guard one: a step is not a value.** `ConfigValueContext` carries an index signature, so a
     * `RunStepFn` is assignable to it - without naming the step types first, `Resolved` collapsed
     * `run.<script>.exec` to its *return type* and left `RunService` nothing to call.
     */
    it('leaves a step function alone on the way to the reader', () => {
      const pkg = emptyPackage();
      /** The whole `run` subtree is identical on both views - it holds steps and an `if`, and not
       *  one `ConfigValue`, so anything the transform touched here would show up as a mismatch. */
      const run: RmanConfig['run'] = pkg.config.run;
      const step: RunStepValue = 'tsc -b';
      expect([run, step]).toBeDefined();
    });

    /**
     * **Guard two: `CODE_SUBTREES` is skipped, at every level.** These three hold code all the way
     * down, and the selector index re-enters the config - so a top-level-only guard misses the copy
     * inside a `"[*]"` block. Left out, the walk rewrote `Plugin`'s *methods*:
     * `VersionScheme.smallestBump(): string` became `string`.
     */
    it('leaves the contribution keys byte-identical, nested ones included', () => {
      const pkg = emptyPackage();
      const plugins: RmanConfig['plugins'] = pkg.config.plugins;
      const commands: RmanConfig['commands'] = pkg.config.commands;
      const targets: RmanConfig['publishTargets'] = pkg.config.publishTargets;
      /** And the copy reached through a selector, which is the level a top-level guard misses. */
      const nested: RmanConfig['plugins'] = pkg.config['[*]']?.plugins;
      expect([plugins, commands, targets, nested]).toBeDefined();
    });

    /**
     * The controls. Each fails in the opposite direction from the assertions above: if the reader's
     * view stopped being resolved, a resolved value would still be callable and this directive
     * would go unused - which `tsc` reports as an error of its own.
     */
    it('does not hand the reader something still callable', () => {
      const pkg = emptyPackage();
      // @ts-expect-error `filePath` is resolved by the time anything reads it - a string, not a function
      const wrong = pkg.config.changelog?.filePath?.();
      expect(wrong).toBeUndefined();
    });

    it('still refuses a value function whose return type is wrong', () => {
      // @ts-expect-error `filePath` is a string key, so its function has to return one
      const bad: RmanConfig = { changelog: { filePath: () => 42 } };
      expect(bad).toBeDefined();
    });
  });
});
