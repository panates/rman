import { definePlatform, type Platform } from '../../core/interfaces/plugin.js';
import type { RmanConfig } from '../../interfaces/rman-config.interface.js';
import { defineConfig } from '../../interfaces/rman-config.interface.js';
import { augmentSystemInfo, ciCommand, cleanCommand, NodePlatform } from '../platforms/node/index.js';
import { NpmPublishTarget } from '../publish-targets/npm/index.js';

/**
 * **The `node` preset** - everything rman knows about the npm ecosystem, as a config.
 *
 * ```yaml
 * # .rmanrc.yml
 * extends: node
 * ```
 *
 * It contributes the technology (how a `package.json` is read, where `workspaces` point, how
 * versions are planned), the two commands that are npm's alone (`clean`, `ci`), and the `npm`
 * publish target. A polyglot repository names several: `extends: ['node', 'cargo']` holds both,
 * because every key here appends.
 */
/* **A config rather than a plugin, and that is the whole shape of a preset.** `commands` and
 * `publishTargets` were already config keys; `platforms` is one now, so a technology arrives the
 * same way everything else does. What used to need a `Builtin` type, a name that looked like a glob
 * and an expansion step is `extends` and nothing else.
 *
 * **A function, so nothing here happens until a repository asks for it.** `augmentSystemInfo()`
 * mutates the core's own `SystemInfo` in place, so running it at import time would have `rman info`
 * report npm's tooling in a Cargo repository that never named this preset. `extends` imports the
 * module it names and calls this; a repository that names something else never reaches it. */
export function nodePreset(): RmanConfig {
  augmentSystemInfo();
  return defineConfig({
    platforms: [(nodePlatform ??= definePlatform(new NodePlatform()))],
    commands: [ciCommand, cleanCommand],
    publishTargets: [(npmTarget ??= new NpmPublishTarget())],
  });
}

export default nodePreset;

/**
 * **One instance of each across every call, so calling this preset twice contributes one of each.**
 *
 * A repository writing `extends: 'rman:node'` is read *and* gets the same preset laid under it by
 * default, which is ordinary rather than a mistake - the contribution keys append and drop a
 * duplicate **by identity** (`appendList`). The two commands are module consts, so they dedup on
 * their own; anything this factory `new`s does not, and both of these have been that at some point.
 *
 * - **The target announced itself loudly.** Two of them reached `publish`, which refuses two
 *   targets declaring one option name, and it died with `Publish targets "npm" and "npm" both
 *   declare an option named "packageManager"` - the guard working exactly as intended, on a
 *   collision with itself.
 * - **The platform does not, and that is the one to watch.** `_addPlatform` dedups by *name*, so a
 *   second `node` platform never reaches `context.platforms` and nothing resolves differently. What
 *   it does is put the same technology in `config.platforms` twice - visible only in `rman config`
 *   and to whoever iterates the key - plus an `augmentSystemInfo()` and a `new NodePlatform()` per
 *   read. Caught by the identity spec in `docs-api.spec.ts` rather than by anything failing.
 *
 * **A new preset has to do the same for anything it constructs.**
 */
let npmTarget: NpmPublishTarget | undefined;
let nodePlatform: Platform | undefined;
