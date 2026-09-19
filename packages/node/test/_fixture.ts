import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repository, RmanApplication, type ServiceMap, VersionPlanService, Workspace } from 'rman';
import { runCli as rmanRunCli } from 'rman/cli';
/**
 * The **plugin**, by name - not the module's default export, which is an rman *config* that carries
 * it (`{ plugins: [nodePlugin] }`).
 *
 * Reading the default export was right until the entry point became a config, and then it silently
 * registered nothing: `nodePlugin.manifest` and friends were simply `undefined`, so a spec calling a
 * service directly got no manifest provider, no version planner and - the dangerous one - no
 * `BinPath` provider, which left `exec` resolving the **real** `npm` from the inherited PATH.
 */
import { nodePlugin } from '../src/index.js';

/**
 * This package's plugin entry point, as an absolute path to the **source** file.
 *
 * `.ts`, not `.js`: `resolveConfigTarget` checks the filesystem, and the only entry point that
 * exists before a build is the TypeScript one. Its extension list deliberately has no `.ts` (rman
 * cannot import one at runtime), but a target naming its own extension is taken as written - and
 * under mocha's swc register the import works. Pointing at `build/index.js` instead would make
 * every spec here depend on a build having run.
 */
const PLUGIN_ENTRY = path.resolve(fileURLToPath(import.meta.url), '../../src/index.ts');

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
   * `runCli` is often called from inside a package (that is how the cwd-scoping specs work), and a
   * `plugins` entry dropped there would never be read: `Workspace.findRoot` takes the *outermost*
   * `.rmanrc` in the chain, so the root's - which says nothing about plugins - would win and the
   * commands would simply not exist. Measured as `Unknown argument: clean`.
   */
  const file = path.join(Workspace.findRoot(dir), '.rmanrc');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  config.plugins = [PLUGIN_ENTRY];
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
export function runCli(options?: { argv?: string[]; cwd?: string }): Promise<void> {
  if (options?.cwd) declarePlugin(options.cwd);
  return rmanRunCli(options);
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
 * It runs `nodePlugin.init` rather than reading a second list of what the plugin contributes, so
 * the specs exercise exactly what a repository naming `rman-node` in `plugins` would get. Commands
 * are dropped: a spec calling a service directly has no CLI to register them with, and
 * `declarePlugin()` is what covers the command path.
 */
export function createRepository(root?: string, options?: { deep?: number }): Promise<Repository> {
  const app = new RmanApplication();
  void nodePlugin.init({
    app,
    addTechStack(stack) {
      app.techStacks.add(stack);
      if (stack.versionPlanner) app.versionPlanner = stack.versionPlanner;
    },
    addCommand() {},
  });
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
