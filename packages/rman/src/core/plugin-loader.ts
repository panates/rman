import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fastGlob from 'fast-glob';
import type { RmanConfig as CommandDeclaration, RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { RmanApplication } from './application.js';
import type { CustomCommand } from './custom-command.js';
import type { Plugin } from './plugin.js';
import type { PublishTarget } from './publish-target.js';

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
   * `binPaths`, `versionPlanner`, then `plugins`, then `commands`. Each new extensible thing
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
 * core's, `plugins` directly, and whatever the application grows later without this interface
 * having to grow with it.
 */
export interface PluginContext {
  readonly app: RmanApplication;
  /** Adds a technology, and its version planner if it brings one. */
  addTechStack(stack: Plugin): void;
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
 * The repository's plugins and publish targets, registered onto `app`.
 *
 * **Three keys share one shape** - `plugins`, `publishTargets` and `commands` each take an
 * instance or a **glob** naming `.js` modules that `export default` one, and each appends rather
 * than replaces. Two of them are read here; `commands` is read by `cli.ts`, and the split is not
 * arbitrary:
 *
 * - **`plugins` and `publishTargets` are root-level, because they have to be.** This runs inside
 *   `Repository.create` *before* the packages are known, since a plugin's `getWorkspace` is what
 *   finds them - so there are no package configs to read yet. A `plugins` entry in a package's own
 *   `.rmanrc` is never seen, which has always been true and is now true for the same reason.
 * - **`commands` is read at any level**, after the packages exist, which is why `cli.ts` owns it:
 *   it already holds the whole command pipeline - the `.rman/` default, de-duplication by name,
 *   and the built-in shadow check. Reading it here as well would register every config-declared
 *   command twice, and yargs does not survive that.
 *
 * **Order within this function is load-bearing**: plugins first, then targets. rman's own
 * `publish` builds its `--target` choices from `app.publishTargets` when its factory runs, and a
 * target contributed by a plugin's `init` has to be there before the list is read.
 *
 * **A contribution that cannot be loaded throws**, unlike a broken `.rman/*.mjs`, which is warned
 * about and skipped. The consequence differs: a skipped local command affects only itself, while a
 * missing plugin silently removes commands the repository is built around - `rman publish` would
 * simply not exist, and "not a known command" sends the reader looking in the wrong place.
 */
export async function loadPlugins(app: RmanApplication, rootConfig: RmanConfig): Promise<void> {
  const seen = new Set<string>();

  for (const { value, from } of await resolveEntries(rootConfig.plugins, PLUGINS_KEY)) {
    const plugin = value as Plugin;
    if (!isPlainObject(plugin) || typeof plugin.name !== 'string' || !plugin.name) {
      throw new Error(
        `"${PLUGINS_KEY}" takes a plugin or a glob naming modules that export one - ${from} gave ` +
          `${describeExport(plugin)}. Every message about a plugin is keyed by its \`name\`.`,
      );
    }
    /** One registration per name. Twice would define the same commands twice, which yargs does not
     *  survive - and two layers naming one plugin is ordinary rather than a mistake. */
    if (seen.has(plugin.name)) continue;
    seen.add(plugin.name);

    app.plugins.add(plugin);
    /**
     * **The orchestrator, and only that.** A plan is computed for the whole repository at once -
     * groups span packages, the ripple crosses them - so one planner drives the traversal and the
     * last registration wins it.
     *
     * The two decisions that belong to a *technology* are not taken from here: `detectBoundary`
     * and `cascade` are asked of `pkg.plugin.versionPlanner` per package, which is why a plugin
     * still declares one even when it is not the last to register.
     */
    if (plugin.versionPlanner) app.versionPlanner = plugin.versionPlanner;
    await plugin.init?.({ app });
  }

  for (const { value, from } of await resolveEntries(rootConfig.publishTargets, 'publishTargets')) {
    const target = value as PublishTarget;
    if (!isPlainObject(value) || typeof target.name !== 'string' || !target.name) {
      throw new Error(
        `"publishTargets" takes a target or a glob naming modules that export one - ${from} gave ` +
          `${describeExport(target)}.`,
      );
    }
    app.publishTargets.add(target);
  }
}

/** One resolved contribution, with where it came from - a file path for a glob match, or the key
 *  itself for an instance written straight into the config, which is all an error can say. */
interface ResolvedEntry {
  value: unknown;
  from: string;
}

/**
 * The shared half of the three keys: an instance is itself, a string is a glob whose matches are
 * imported and unwrapped.
 *
 * **A glob is already absolute** by the time it gets here - `mergeConfig` anchors it to the file
 * that declared it as the config is read, which is the last moment that is knowable (see
 * `anchorContributions`). Nothing here resolves a path.
 *
 * **`.js` only.** rman imports these in its own process with no loader registered, so a `.ts`
 * module cannot be one; a TypeScript repository compiles first or writes `.mjs`. Stated rather
 * than attempted, because a `.ts` that happens to load under a test runner's loader and not under
 * the CLI is the worst of both.
 */
async function resolveEntries(declared: unknown, key: string): Promise<ResolvedEntry[]> {
  if (declared === undefined) return [];
  const out: ResolvedEntry[] = [];
  for (const entry of (Array.isArray(declared) ? declared : [declared]) as unknown[]) {
    if (typeof entry !== 'string') {
      out.push({ value: entry, from: `"${key}"` });
      continue;
    }
    if (!entry.trim()) throw new Error(`"${key}" has an empty glob.`);
    const files = await fastGlob(entry.split(path.sep).join('/'), { absolute: true, onlyFiles: true });
    /**
     * **A glob matching nothing is an error here**, unlike in `commands`, and the asymmetry is the
     * point. Losing a plugin silently removes commands and seams the repository is built around -
     * `rman publish` would simply not exist, and "not a known command" sends the reader looking in
     * the wrong place. `commands` can match nothing legitimately: `.rman/*.js` is its default, and
     * most repositories have no such directory.
     */
    if (!files.length) {
      throw new Error(`"${key}" glob "${entry}" matched no file. A plugin that does not load is not a plugin.`);
    }
    for (const file of [...new Set(files.map(f => path.resolve(f)))].sort()) {
      const mod: any = await import(pathToFileURL(file).href);
      const exported = mod?.default;
      if (exported === undefined) {
        throw new Error(`"${key}" matched "${file}", which has no default export. ${describeExport(mod)}`);
      }
      out.push({ value: exported, from: file });
    }
  }
  return out;
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
