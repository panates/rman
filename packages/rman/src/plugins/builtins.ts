import type { Platform } from '../core/plugin.js';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import { nodeBuiltin, nodePlatform } from './node/index.js';

/**
 * **The plugins rman ships in the box, by the name a config calls them.**
 *
 * `plugins: ['node']` is the whole of it - no new key, because there is no new concept. A
 * repository was always able to say which technologies it holds; this is that same statement with
 * a name instead of an instance, which is the form a YAML config and a zero-config repository both
 * need.
 *
 * **Bundled is not the same as always on, and keeping those apart is the point.** Nothing an entry
 * contributes exists until a repository names it or detection finds it, so the core still assumes
 * no ecosystem and `rman clean` is still `Unknown argument` in a repository that is not a Node one.
 * What changed is only where the code is shipped from - one install instead of two, which is what
 * `extends: 'rman-node'` was costing every Node repository for a benefit that belonged to polyglot
 * ones.
 *
 * The key is `Plugin.name`, so what a config writes is what `${{ pkg.provider }}` reads back.
 *
 * **A published package is still not one of these.** `plugins: ['rman-node']` names a package, whose
 * config reaches a repository through `extends`; it is refused, saying so. The two are different
 * statements and a built-in name is neither of them - it is the plugin itself, called by name.
 */
export const BUILTIN_PLUGINS: Record<string, Builtin> = {
  node: { platform: () => nodePlatform, contribute: nodeBuiltin },
};

/**
 * One built-in, in the two halves that must not be the same call.
 *
 * **`plugin` answers questions; `contribute` changes the run.** Detection asks a platform whether a
 * directory is its own, which has to be possible without registering anything - and registering is
 * what `contribute` does: it hands over commands, publish targets and (for `node`) an augmentation
 * that rewrites the core's `SystemInfo` in place. One call for both would have "is this a Node
 * repository?" print npm's tooling in a Cargo one, which is exactly the line between *bundled* and
 * *on*.
 */
export interface Builtin {
  /** The platform itself, for asking - constructed, registered nowhere, with no side effect. */
  platform: () => Platform;
  /** Everything this built-in adds to a repository that asked for it. */
  contribute: () => RmanConfig;
}

/** Whether `name` is one rman ships - the check `plugins` makes before treating a string as a glob. */
export function isBuiltinPlugin(name: string): boolean {
  return Object.hasOwn(BUILTIN_PLUGINS, name);
}

/** The built-in names, for an error message that has to list what a repository could have meant. */
export function builtinPluginNames(): string[] {
  return Object.keys(BUILTIN_PLUGINS).sort();
}
