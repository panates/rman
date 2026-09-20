import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RmanConfig as CommandDeclaration } from '../interfaces/rman-cfg.interface.js';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { RmanApplication } from './application.js';
import type { CustomCommand } from './custom-command.js';
import { resolveConfigTarget } from './resolve-target.js';
import type { TechStack } from './tech-stack.js';

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
  /**
   * **One entry point, called once, with the application.** Everything a plugin contributes it
   * registers here.
   *
   * This replaced a growing list of declared fields - `manifest`, `workspace`, `runSteps`,
   * `binPaths`, `versionPlanner`, then `techStacks`, then `commands`. Each new extensible thing
   * meant another field on an interface every plugin is written against, and a plugin could never
   * offer an extension point of its own: only rman's fields could be contributed to.
   *
   * Called during `Repository.create`, **before any package is known** - plugins are what find
   * them. `ctx.app.repository` therefore throws here; a plugin deciding something per package does
   * it inside its own provider, which is asked later.
   *
   * A plugin whose `init` throws fails the whole load rather than leaving what it managed to
   * register in place: a half-installed technology answers some questions and not others, which is
   * worse than not being there.
   */
  init(ctx: PluginContext): void | Promise<void>;
}

/**
 * What a plugin registers through - the application, plus the two helpers that need to know *which*
 * plugin is asking.
 *
 * `addCommand` is one of those: a command carries the label and specifier it came from, so a broken
 * one can be reported by name. `ctx.app` is everything else - `setService` to replace one of the
 * core's, `techStacks` directly, and whatever the application grows later without this interface
 * having to grow with it.
 */
export interface PluginContext {
  readonly app: RmanApplication;
  /** Adds a technology, and its version planner if it brings one. */
  addTechStack(stack: TechStack): void;
  /**
   * Adds a command, tagged with the plugin it came from.
   *
   * **Two forms, and the first is the one to write.** `declareCommand(app => ({ ... }))` is the
   * same declaration the built-ins use - options as data, checked for typos, with `--config` keys
   * and `ArgsOf` typing falling out of it. The older `CustomCommand` object (a hand-written
   * `builder`, a handler taking a context) still works and is what a `.rman/*.mjs` command is.
   */
  addCommand(command: CustomCommand | CommandDeclaration.CommandRegisterFunction): void;
}

/**
 * One command a plugin contributed, in whichever form it was declared, plus who contributed it.
 *
 * The plugin and specifier travel with it because every message about a command is keyed by them -
 * which plugin declared the one that clashes, which one failed to register. `cli.ts` is what turns
 * either form into a yargs registration; nothing between here and there has to tell them apart.
 */
export type PluginCommand = { plugin: string; file: string } & (
  | { register: CommandDeclaration.CommandRegisterFunction; custom?: undefined }
  | { custom: CustomCommand; register?: undefined }
);

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
export async function loadPlugins(
  app: RmanApplication,
  rootDir: string,
  rootConfig: RmanConfig,
): Promise<PluginCommand[]> {
  const commands: PluginCommand[] = [];
  /** Resolved against the repository root, where the `.rmanrc` declaring them lives. */
  await loadInto(app, commands, rootConfig, path.join(rootDir, '.rmanrc'), { files: new Set(), names: new Set() });
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
async function loadInto(
  app: RmanApplication,
  commands: PluginCommand[],
  config: RmanConfig,
  from: string,
  seen: Seen,
): Promise<void> {
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
      await register(app, commands, entry as RmanPlugin, entry.name, from, seen);
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
    await loadInto(app, commands, exported as RmanConfig, file, seen);
  }
}

/**
 * Runs one plugin's `init`, with a context that knows which plugin it is.
 *
 * **One registration per plugin name.** `plugins` appends at every layer, so the same plugin
 * arriving twice is an ordinary consequence of `extends` rather than a mistake to report - and
 * running `init` twice would define its commands twice, which yargs does not survive.
 */
async function register(
  app: RmanApplication,
  commands: PluginCommand[],
  plugin: RmanPlugin,
  label: string,
  specifier: string,
  seen: Seen,
): Promise<void> {
  if (seen.names.has(plugin.name)) return;
  seen.names.add(plugin.name);
  await plugin.init({
    app,
    addTechStack(stack) {
      app.techStacks.add(stack);
      /** Still one answer per application rather than one per stack: `getPlanner()` is asked
       *  without a package in places, so per-package planning waits for those call sites. */
      if (stack.versionPlanner) app.versionPlanner = stack.versionPlanner;
    },
    addCommand(command) {
      const from = label || specifier;
      /**
       * **A declarative command is stored, not run.** Its factory needs `app.repository`, and this
       * runs inside `Repository.create` - before the packages are known, since plugins are what
       * find them. `cli.ts` runs it where the built-ins' own factories run, and checks it there.
       */
      if (typeof command === 'function') {
        commands.push({ plugin: from, file: specifier, register: command });
        return;
      }
      commands.push({ plugin: from, file: specifier, custom: checkCustomCommand(command, from) });
    },
  });
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

const PLUGIN_SEAMS = ['init', 'name'] as const;

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

/**
 * A plugin's `CustomCommand`, checked the same way a `.rman/*.mjs` one is - the name it answers to
 * comes from its own `command` string, since a plugin has no file name to fall back on.
 *
 * Exported because `cli.ts` runs the identical checks on what a *declarative* command's factory
 * returns, and they must not drift: a plugin written in JavaScript reaches both forms with no type
 * checker in the way.
 */
export function checkCustomCommand<T extends { command?: string; describe?: unknown; handler?: unknown }>(
  command: T,
  pluginName: string,
): T & { command: string } {
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
  return { ...command, command: declared };
}
