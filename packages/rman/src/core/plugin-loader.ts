import type { RmanApplication } from './application.js';
import { isPlatform, type Platform, type Plugin } from './interfaces/plugin.js';

/** The `.rmanrc` key naming plugin packages to load. */
export const PLUGINS_KEY = 'plugins';

/**
 * **Puts one contribution onto an application** - a technology, or a plugin - and the only place
 * that knows how.
 *
 * **Exported because a spec must not reimplement it.** A fixture writing the registrations out by
 * hand is a second implementation that drifts, which is exactly how a fixture ends up proving the
 * core works when it does not. A spec brings its own technology through this, the same door a
 * config's does.
 *
 * **Neither hook is called here, and that is deliberate.** `afterInitApplication` and
 * `afterInitRepository` belong to `Repository.create`, which knows when each stage is reached and
 * can await them; this is a synchronous call a fixture makes while building an application.
 */
/* **Two registries and no normalization, which is what the split bought.** A bare `Platform` used
 * to be wrapped in `{ name, platforms: [entry] }` so that everything downstream dealt in one shape
 * - and that shape was `Plugin.platforms`, which is gone: `platforms` is a config key now, so a
 * package shipping a technology declares it there and nothing has to invent a plugin around it.
 * What is left is a question with two honest answers, asked once. */
export function registerPlugin(app: RmanApplication, entry: Plugin | Platform): void {
  if (isPlatform(entry)) {
    app.platforms.add(entry);
    /**
     * **The orchestrator, and only that.** A plan is computed for the whole repository at once -
     * groups span packages, the ripple crosses them - so one planner drives the traversal and the
     * last registration wins it.
     *
     * The two decisions that belong to a *technology* are not taken from here: `detectBoundary`
     * and `cascade` are asked of `pkg.platform.versionPlanner` per package, which is why a platform
     * still declares one even when it is not the last to register.
     */
    if (entry.versionPlanner) app.versionPlanner = entry.versionPlanner;
    return;
  }
  app.plugins.add(entry);
}

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
