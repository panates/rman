import { expect } from 'expect';
import type {
  ArgsOf,
  CommandOption,
  Plugin,
  PluginContext,
  PositionalOption,
  PublishTarget,
  RmanConfig,
  ServiceMap,
} from '../src/index.js';
import {
  basePlugin,
  ChangelogService,
  declareCommand,
  defineConfig,
  definePlugin,
  DockerPublishService,
  ExecService,
  filterPackages,
  GithubReleaseService,
  ImportService,
  isCalendarVersion,
  ListService,
  LOG_LEVELS,
  Logger,
  Package,
  packageFilterOptions,
  Registry,
  Repository,
  resolveRootLogLevel,
  RmanApplication,
  ROOT_SELECTOR,
  RunService,
  Service,
  shipsTo,
  SystemInfo,
  targetsOf,
  VersionPlanService,
  VersionService,
} from '../src/index.js';

/**
 * **What `docs/rman.md` claims the package exports, checked against what it does.**
 *
 * The API docs went stale across an entire refactor - services became classes, the plugin seams
 * became one `Plugin`, `RmanApplication` appeared - and nothing noticed, because nothing looks:
 * mocha transpiles without type-checking and no spec imported the names the docs advertise. This
 * file is that missing reader. It is checked by `npm run typecheck`; the assertions below only keep
 * mocha from reporting an empty file.
 *
 * **Keep it in step with `docs/rman.md`'s Installation import block.** A name removed from the
 * package fails here at compile time, which is the point; a name *added* to the package does not,
 * so this is a floor rather than a contract.
 */
describe('docs/rman.md: the documented API surface', () => {
  it('exports every value its Installation block imports', () => {
    for (const exported of [
      RmanApplication,
      Repository,
      Package,
      Registry,
      Service,
      defineConfig,
      definePlugin,
      declareCommand,
      basePlugin,
      targetsOf,
      shipsTo,
      VersionService,
      VersionPlanService,
      DockerPublishService,
      GithubReleaseService,
      ChangelogService,
      RunService,
      ExecService,
      ListService,
      ImportService,
      SystemInfo,
      filterPackages,
      ROOT_SELECTOR,
      isCalendarVersion,
      Logger,
      LOG_LEVELS,
      resolveRootLogLevel,
    ]) {
      expect(exported).toBeDefined();
    }
  });

  /** `ROOT_SELECTOR` is a documented *value*, not just a name - `docs/rman.md` and the CLI pages
   *  spell it `/`, and a repository writes the literal rather than importing it. */
  it('ROOT_SELECTOR is the "/" the docs and the CLI pages spell out', () => {
    expect(ROOT_SELECTOR).toBe('/');
  });

  /**
   * And that the command-declaration example in "Declaring a command" type-checks **as written** -
   * the two hoisted consts, `satisfies Record<string, CommandOption>`, and an `ArgsOf`-annotated
   * handler. Copying it out of the page is the first thing a plugin author does.
   */
  it('type-checks the documented command declaration', () => {
    const COMMAND = 'deploy [stage]' as const;
    const config = {
      ...packageFilterOptions,
      wait: { target: 'cli', describe: 'block until healthy', type: 'boolean' },
      registry: { target: 'config', describe: 'where images are pushed from', type: 'string' },
    } satisfies Record<string, CommandOption>;
    type Args = ArgsOf<typeof config, typeof COMMAND>;

    const deployCommand = declareCommand(app => ({
      command: COMMAND,
      describe: 'Ships the current versions',
      configKeys: ['publish'],
      config,
      positionals: { stage: { describe: 'which cluster', type: 'string' } },
      handler: async (args: Args) => void [app, args.stage, args.wait],
    }));
    expect(typeof deployCommand).toBe('function');
  });

  /** The types the page names in its `import type` block. Nothing to assert at runtime - the
   *  annotation either compiles or it does not, which is what `npm run typecheck` is for. */
  it('exports every type its Installation block imports', () => {
    const named: [RmanConfig, Plugin, PluginContext | undefined, PublishTarget | undefined, ServiceMap] = [
      {},
      basePlugin,
      undefined,
      undefined,
      {} as ServiceMap,
    ];
    /** `PositionalOption` beside `CommandOption`, because `positionals` is the other half of a
     *  command's surface - and the half that could not be typed without importing yargs until it
     *  was exported. */
    const positionals = {
      stage: { describe: 'where to ship', type: 'string' },
    } satisfies Record<string, PositionalOption>;
    expect([named.length, Object.keys(positionals)]).toEqual([5, ['stage']]);
  });
});
