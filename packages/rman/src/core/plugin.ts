import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { RunService } from '../services/run.service.js';
import { VersionPlanService } from '../services/version-plan.service.js';
import { BinPath } from '../utils/bin-path.js';
import type { CustomCommand, LoadedCommand } from './custom-command.js';
import { Manifest, type ManifestProvider } from './manifest.js';
import { resolveConfigTarget } from './resolve-target.js';
import { Workspace } from './workspace.js';

/** The `.rmanrc` key naming plugin packages to load. */
export const PLUGINS_KEY = 'plugins';

/**
 * What a plugin package hands rman.
 *
 * An object rather than a bare array of commands, for the reason `CommandContext` is one: a plugin
 * will eventually contribute more than commands (config defaults, publish targets, a package
 * provider for a non-Node repository), and nothing written against this should have to change when
 * it does.
 */
export interface RmanPlugin {
  /** For error messages and `--help` grouping. Conventionally the package's own name. */
  name: string;
  commands?: CustomCommand[];
  /**
   * Where `run` can find a package's steps besides its `.rmanrc` - `rman-node` contributes
   * `package.json#scripts` here, with npm's `pre`/`post` lifecycle.
   *
   * Registered in `plugins` declaration order, and only for plugins the repository actually named:
   * what a script resolves to is then a function of the config rather than of what happened to be
   * imported.
   */
  runSteps?: RunService.StepSource;
  /**
   * How this ecosystem's repositories are laid out - `rman-node` reads `workspaces` from the root
   * `package.json` here.
   *
   * Loaded **before any package is known**, since this is what finds them: `Repository.create`
   * reads the root config, loads the plugins it names, and only then asks. A repository naming no
   * plugin therefore has no packages beyond itself.
   */
  workspace?: Workspace.Provider;
  /**
   * Where a package's name and version are written, and how it is numbered - `rman-node`
   * contributes `package.json` here.
   *
   * Registered before any package is constructed, since `Package` reads through it. A repository
   * naming no plugin therefore gets packages named after their own directories at version
   * `0.0.0` - see `readManifest`.
   */
  manifest?: ManifestProvider;
  /**
   * How a release is planned - which packages have changed since their last release and what
   * version each gets. `rman-node` contributes `NodeVersionPlanService` here.
   *
   * **`VersionPlanService` is abstract, so `version`/`changed` do not work without one** (they fail
   * naming this key). Unlike `manifest` and `workspace`, which degrade to honest defaults, a plan is
   * either right or it quietly releases the wrong set of packages - see `VersionPlanService`.
   *
   * Consulted when a command asks, not at load time, so this is declared and nothing else has to
   * happen as the plugin's module is imported.
   */
  versionPlanner?: VersionPlanService;
  /**
   * Where this ecosystem keeps a repository's locally installed executables - `rman-node`
   * contributes npm's `node_modules/.bin`, walked up the directory chain.
   *
   * Prepended to PATH for every `exec`/`runBin` child process, so a command an author wrote runs
   * against the repository's own pinned tools. **Every plugin's entries are used**, not just the
   * first - see `BinPath`.
   */
  binPaths?: BinPath.Provider;
}

/**
 * Identity helper for authoring a plugin with full type-checking - the `defineConfig`/
 * `defineCommand` pattern again, for the same reason. Returns `plugin` unchanged.
 *
 * **A plugin package's entry point exports a *config*, not this**, so that a package is an
 * `.rmanrc` like any other and can carry a second plugin later without changing shape:
 *
 * ```js
 * // rman-node's entry point
 * import { defineConfig, definePlugin } from 'rman';
 * import publishCommand from './commands/publish.js';
 *
 * export const nodePlugin = definePlugin({ name: 'rman-node', commands: [publishCommand] });
 * export default defineConfig({ plugins: [nodePlugin] });
 * ```
 *
 * **A module exporting the plugin itself is refused**, with a message saying so. Accepting both
 * would mean telling a plugin from a config at runtime, and `name` is a key either may have - the
 * test would be a guess, and guessing "plugin" registers nothing while reporting success.
 */
export function definePlugin(plugin: RmanPlugin): RmanPlugin {
  return plugin;
}

/**
 * Loads every plugin the repository's `.rmanrc "plugins"` declares, in declaration order.
 *
 * This is what lets a *package* contribute commands. `.rman/*.mjs` covers one repository's own
 * commands (see `loadCustomCommands`); a plugin covers a whole class of repository - `rman-node`
 * carrying everything that only means something because the repository is a Node one, so rman's
 * core does not have to.
 *
 * An entry is a package name, a path, or a plugin object - and a named package's entry point
 * exports a **config**, whose own `plugins` are then loaded the same way (see `loadInto`).
 *
 * Names resolve relative to the repository root's own `node_modules`, the way `extends` resolves -
 * a plugin is the repository's dependency, not rman's.
 *
 * **A plugin that cannot be loaded throws**, unlike a broken `.rman/*.mjs` file, which is warned
 * about and skipped. The two differ because the consequence does: a skipped local command affects
 * only itself, while a missing plugin silently removes commands the repository is built around -
 * `rman publish` would simply not exist, and "not a known command" sends the reader looking in the
 * wrong place entirely.
 */
export async function loadPlugins(rootDir: string, rootConfig: RmanConfig): Promise<LoadedCommand[]> {
  const commands: LoadedCommand[] = [];
  /** Resolved against the repository root, where the `.rmanrc` declaring them lives. */
  await loadInto(commands, rootConfig, path.join(rootDir, '.rmanrc'), { files: new Set(), names: new Set() });
  return commands;
}

/**
 * One config's `plugins`, in declaration order.
 *
 * Recursive because a plugin package **exports a config**, not a plugin: `rman-node`'s entry point
 * is `export default defineConfig({ plugins: [ ... ] })`, so resolving a name lands on another
 * config whose own `plugins` are the ones to register. That also means a plugin package can name a
 * plugin of its own and it simply works.
 *
 * `from` is the file the entries are resolved against, and it changes as it descends - an entry in
 * `rman-node`'s config resolves through *its* `node_modules`, not the repository's, the same rule
 * `extends` follows.
 *
 * **Only `plugins` is read out of an imported config.** Its other keys are not merged: a config's
 * way into a repository is `extends`, which is the key that says "merge this underneath mine".
 * Reading them here would make a plugin able to configure a repository by being installed.
 */
async function loadInto(commands: LoadedCommand[], config: RmanConfig, from: string, seen: Seen): Promise<void> {
  const declared = (config as Record<string, unknown> | undefined)?.[PLUGINS_KEY];
  if (declared === undefined) return;

  for (const entry of Array.isArray(declared) ? declared : [declared]) {
    /**
     * The object form: a JS config handing a plugin over directly, and what a plugin package's own
     * config holds. Nothing to resolve or import.
     *
     * An object here **is** a plugin - it is not guessed at. The one thing checked is that it has a
     * `name`, because everything downstream (the registration guard, `--help` grouping, every error
     * message) is keyed by it.
     */
    if (isPlainObject(entry)) {
      if (typeof entry.name !== 'string' || !entry.name) {
        throw new Error(`A plugin object in "${PLUGINS_KEY}" has no "name" - every other message is keyed by it.`);
      }
      register(commands, entry as RmanPlugin, entry.name, from, seen);
      continue;
    }
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(
        `"${PLUGINS_KEY}" takes a package name, a path, or a plugin object - not ${JSON.stringify(entry)}`,
      );
    }

    const file = resolveConfigTarget(entry, from, PLUGINS_KEY);
    /** A config naming itself, or two naming each other, would otherwise recurse forever. Keyed by
     *  resolved file, so the same package reached by two names is still loaded once. */
    if (seen.files.has(file)) continue;
    seen.files.add(file);

    const mod: any = await import(pathToFileURL(file).href);
    const exported = mod?.default ?? mod?.plugin;

    /**
     * **A module exports one thing: an rman config.** Not a plugin, and not either-or.
     *
     * Accepting both meant having to *tell them apart*, and there is no reliable way to - `name` is
     * a key a config may have as well, so the test came down to "a name plus at least one of the
     * things a plugin contributes", which is a guess. Guess wrong in the direction of "plugin" and
     * nothing is registered while the command reports success, which is the worst outcome on offer.
     * One shape, one rule, one error.
     */
    if (!isPlainObject(exported) || (exported as RmanConfig).plugins === undefined) {
      throw new Error(
        `Plugin "${entry}" must export an rman config - \`export default defineConfig({ plugins: [ ... ] })\`. ` +
          describeExport(exported),
      );
    }
    await loadInto(commands, exported as RmanConfig, file, seen);
  }
}

/**
 * Everything a plugin contributes, in one place - so the object and the imported forms cannot drift
 * apart in what they support.
 *
 * **One registration per plugin name.** `plugins` appends at every layer now, so the same plugin
 * arriving twice is an ordinary consequence of `extends` rather than a mistake to report - and
 * registering it twice would define its commands twice, which yargs does not survive. The config
 * merge already drops an identical entry; this catches the rest, including two objects claiming one
 * name and an object that duplicates a named package.
 */
function register(commands: LoadedCommand[], plugin: RmanPlugin, label: string, specifier: string, seen: Seen): void {
  if (seen.names.has(plugin.name)) return;
  seen.names.add(plugin.name);
  if (plugin.runSteps) RunService.addStepSource(plugin.runSteps);
  if (plugin.manifest) Manifest.addProvider(plugin.manifest);
  if (plugin.workspace) Workspace.addProvider(plugin.workspace);
  if (plugin.binPaths) BinPath.addProvider(plugin.binPaths);
  if (plugin.versionPlanner) VersionPlanService.setPlanner(plugin.versionPlanner);
  for (const command of plugin.commands ?? []) {
    commands.push(toLoadedCommand(command, label || specifier, specifier));
  }
}

/**
 * The second half of the error above - what the module *did* export, so the author can see how far
 * off it was.
 *
 * It recognizes a plugin object only to **say so in a message**. That is the one safe use for this
 * shape test: it decides nothing, so a wrong guess costs a slightly less helpful sentence rather
 * than a plugin that silently does not load.
 */
function describeExport(exported: unknown): string {
  if (exported === undefined) return 'It has no default export.';
  if (!isPlainObject(exported)) return `Its default export is a ${typeof exported}.`;
  const looksLikePlugin = PLUGIN_SEAMS.some(seam => exported[seam] !== undefined);
  return looksLikePlugin
    ? `Its default export looks like the plugin itself - put it in a config's "${PLUGINS_KEY}".`
    : `Its default export has no "${PLUGINS_KEY}".`;
}

const PLUGIN_SEAMS = ['commands', 'runSteps', 'workspace', 'manifest', 'versionPlanner', 'binPaths'] as const;

/** A config object, as opposed to an array or anything with its own prototype. */
function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** What has already been loaded during one `loadPlugins` walk - resolved config files, so recursion
 *  terminates, and plugin names, so nothing registers twice. */
interface Seen {
  files: Set<string>;
  names: Set<string>;
}

/** A plugin's command, checked the same way a `.rman/*.mjs` one is - the name it answers to comes
 *  from its own `command` string, since a plugin has no file name to fall back on. */
function toLoadedCommand(command: CustomCommand, pluginName: string, specifier: string): LoadedCommand {
  const declared = command?.command?.trim();
  if (!declared) {
    throw new Error(`Plugin "${pluginName}" has a command with no "command" name - it cannot be registered.`);
  }
  if (typeof command.handler !== 'function') {
    throw new Error(`Plugin "${pluginName}" command "${declared}" has no "handler" function.`);
  }
  if (typeof command.describe !== 'string' || !command.describe) {
    throw new Error(
      `Plugin "${pluginName}" command "${declared}" has no "describe" - \`rman --help\` would have ` +
        `nothing to list it by.`,
    );
  }
  return { ...command, command: declared, name: declared.split(/\s+/)[0], file: specifier };
}
