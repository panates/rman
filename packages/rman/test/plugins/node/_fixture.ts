import fs from 'node:fs';
import path from 'node:path';
import { runCli as rmanRunCli } from '../../../src/cli.js';
import {
  basePlugin,
  Repository,
  RmanApplication,
  type ServiceMap,
  VersionPlanService,
  Workspace,
} from '../../../src/index.js';
/**
 * The **plugin**, by name - not the module's default export, which is an rman *config* that carries
 * it (`{ plugins: [new NodePlugin()] }`).
 *
 * Reading the default export was right until the entry point became a config, and then it silently
 * registered nothing: `plugin.manifestProvider` and friends were simply `undefined`, so a spec calling a
 * service directly got no manifest provider, no version planner and - the dangerous one - no
 * `BinPath` provider, which left `exec` resolving the **real** `npm` from the inherited PATH.
 */
/** The plugin's own module, not the package entry point: `index.ts` exports what a *user*
 *  needs, and a test reaching for something it does not export is asking the wrong file. */
import { NodePlugin } from '../../../src/plugins/node/node.plugin.js';
import { NpmPublishTarget } from '../../../src/plugins/node/npm-publish-target.js';

/**
 * Declares this package as a plugin of the fixture repository at `dir`, so its commands exist at
 * all - `rman publish` is no longer built in, and a repository that does not name the plugin does
 * not have it.
 *
 * The entry point is named by **absolute path** rather than as `"rman-node"`: a fixture is a bare
 * temporary directory with no `node_modules`, and `plugins` resolves a bare specifier through the
 * repository's own dependencies (the same rule `extends` follows), which is exactly right in a real
 * repository and unusable here. `resolveConfigTarget` accepts a path for this reason.
 *
 * Merges into an existing `.rmanrc` rather than replacing it, since most fixtures write one of their
 * own.
 */
export function declarePlugin(dir: string): void {
  /**
   * Written at the **repository root**, not at `dir`.
   *
   * `runCli` is often called from inside a package (that is how the cwd-scoping specs work), and
   * an entry dropped there would never be read: `Workspace.findRoot` takes the *outermost*
   * `.rmanrc` in the chain, so the root's - which says nothing about the plugin - would win and
   * the commands would simply not exist. Measured as `Unknown argument: clean`.
   *
   * **`plugins: ['node']`, which is what a real repository writes now.** It used to be an
   * `extends` naming this package's entry point by absolute path, because the plugin shipped
   * separately and a bare temporary directory has no `node_modules` to resolve `'rman-node'`
   * through. Bundled, the built-in is reachable by name from anywhere, so the fixture and a real
   * repository finally write the same line.
   */
  const file = path.join(Workspace.findRoot(dir), '.rmanrc');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  const declared: unknown[] = Array.isArray(config.plugins) ? config.plugins : config.plugins ? [config.plugins] : [];
  if (!declared.includes('node')) declared.push('node');
  config.plugins = declared;
  fs.writeFileSync(file, JSON.stringify(config));
}

/**
 * `runCli`, with this package declared as a plugin of whatever repository the call names.
 *
 * Wrapping the entry point rather than every fixture: a fixture writes its own `.rmanrc` after
 * creating the directory, so declaring the plugin at creation time would be overwritten. Here it
 * happens immediately before the CLI reads the config, which is the only moment that is always
 * late enough.
 */
export function runCli(options?: { argv?: string[]; cwd?: string; app?: RmanApplication }): Promise<void> {
  if (options?.cwd) declarePlugin(options.cwd);
  return rmanRunCli(options);
}

/**
 * An application carrying a **bin-only plugin** that offers `dir` - so a stub binary there beats
 * everything `NodePlugin` contributes.
 *
 * `BinPath.env` concatenates providers in registration order and appends the *inherited* PATH last,
 * and `NodePlugin.getBinPaths` ends with the running `node`'s own directory. So a stub reached by
 * prepending `process.env.PATH` loses to any real binary sitting beside `node` - which on a
 * version-managed machine is all of `npm`, `yarn` and `pnpm`. Measured: `ci --package-manager yarn`
 * ran the **real** yarn from nvm's bin directory, and the spec asserting on its stub failed while
 * reporting only "expected true, received false".
 *
 * Passed to `runCli` so `loadPlugins` registers `NodePlugin` *after* this one, which is what puts
 * `dir` first. The same shape as the core fixture's `useLocalBin`, and the same reason it exists.
 */
export function appWithStubBin(dir: string): RmanApplication {
  const app = new RmanApplication();
  app.plugins.add({ name: 'stub-bin', manifestProvider: basePlugin.manifestProvider, getBinPaths: () => [dir] });
  return app;
}

/**
 * Registers this plugin's providers for every test in the enclosing `describe` - for a spec that
 * calls a **service** directly instead of going through the CLI.
 *
 * `declarePlugin`/`runCli` cover the command path, where `loadPlugins` does this from the
 * repository's own config. A service call has no config to read, and each `createRepository`
 * builds its own `RmanApplication` - which starts empty, since the plugin's technologies live on
 * an application rather than in a module-global registry. Declaring them here is what puts them
 * on the application a test's repository is going to be built on.
 *
 * Reads them off the `definePlugin` object rather than calling `augment*()` again, so the specs
 * exercise exactly what a repository naming `rman-node` in `plugins` would get.
 */
export function useNodeEcosystem(): void {
  beforeEach(() => {
    lastApp = undefined;
  });
}

/**
 * A repository on an application carrying **this plugin's** technology - what a spec calls instead
 * of `Repository.create`.
 *
 * It registers the plugin itself rather than reading a second list of what it contributes, so
 * the specs exercise exactly what a repository naming `rman-node` in `plugins` would get. Commands
 * are dropped: a spec calling a service directly has no CLI to register them with, and
 * `declarePlugin()` is what covers the command path.
 */
export function createRepository(root?: string, options?: { deep?: number }): Promise<Repository> {
  const app = new RmanApplication();
  /** Registered the way a config's `plugins`/`publishTargets` would - the plugin *is* the
   *  technology now, so there is no `init` to call for it. Commands are left out: a spec calling a
   *  service directly has no CLI to register them with, and `declarePlugin()` covers that path. */
  const plugin = new NodePlugin();
  app.plugins.add(plugin);
  if (plugin.versionPlanner) app.versionPlanner = plugin.versionPlanner;
  app.publishTargets.add(new NpmPublishTarget());
  lastApp = app;
  return Repository.create(root, { ...options, app });
}

/** The version planner the last `createRepository()`'s application carries. */
export function planner(): VersionPlanService {
  if (!lastApp) throw new Error('No application yet - call createRepository() first.');
  return VersionPlanService.getPlanner(lastApp);
}

/** The service a spec is exercising, from the application the last `createRepository()` built. */
export function service<K extends keyof ServiceMap>(name: K): ServiceMap[K] {
  if (!lastApp) throw new Error('No application yet - call createRepository() first.');
  return lastApp.getService(name);
}

let lastApp: RmanApplication | undefined;
