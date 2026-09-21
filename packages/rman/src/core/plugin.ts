import type { RunService } from '../services/run.service.js';
import type { VersionPlanService } from '../services/version-plan.service.js';
import type { BinPath } from '../utils/bin-path.js';
import type { RmanApplication } from './application.js';
import type { Manifest, ManifestProvider } from './manifest.js';
import type { Workspace } from './workspace.js';

/**
 * **One technology, as a whole** - Node, Cargo, Maven. Everything rman needs in order to treat a
 * directory as a package of that technology, plus an `init` for anything that is not a seam.
 *
 * These were six independent fields on a plugin, each with its own registry, and declaring one
 * without the others type-checked. It is not a shape that admits sense: `getRunSteps` reads
 * `pkg.manifest.raw?.scripts`, so contributing npm's step source without npm's manifest reader
 * leaves it parsing whatever another technology produced. The coupling was already real; only the
 * type failed to say so.
 *
 * **`RmanPlugin` and `TechStack` used to be two types and are now one.** The plugin existed solely to
 * *register* the stack - its whole `init` was `ctx.addTechStack(...)` plus a command or two - and
 * once a config carries commands and publish targets itself, that registration step has nothing
 * left to do. What remains of a plugin is the technology, so that is what the type is.
 *
 * **`manifestProvider` stays grouped rather than flattened in here**, and it was tried the other
 * way first: nine members about one file - reading it, writing it, what it declares, how its
 * versions are numbered, stamped and looked up on a registry - are more legible as a named group
 * than as nine siblings of `getBinPaths`. The name also keeps its distance from `Package.manifest`,
 * which is the *data* this produces rather than the reader.
 *
 * **Everything optional is answered by its absence**, never by a default rman invented - see
 * `basePlugin`.
 */
export interface Plugin {
  /**
   * **The ecosystem this speaks for**, surfaced on every package it reads as `Package.provider` -
   * `'node'` for `rman-node`. Short and about the technology, not about the file:
   * `manifestProvider.fileName` already says `package.json`, and a name repeating it would tell a
   * caller nothing it did not have.
   *
   * This is what lets code that *does* know one ecosystem check before acting on a package -
   * `if (pkg.provider === 'node')` - which matters most in a repository holding more than one,
   * since a manifest is read per directory and two packages can legitimately answer to different
   * technologies. It is also the de-duplication key: registering twice under one name is refused,
   * because it would define the same commands twice and yargs does not survive that.
   */
  name: string;

  /** Where this technology's packages keep their identity, and how to change it - reading and
   *  writing the manifest, what it declares as dependencies, how its versions are numbered,
   *  stamped, and looked up on a registry. */
  manifestProvider: ManifestProvider;

  /** Where this technology's packages are, given the repository root - npm reads `workspaces`,
   *  Cargo a `[workspace] members`. `undefined` when it does not recognize the root. */
  getWorkspace?: Workspace.Provider;

  /** Directories to put in front of a child process's PATH, so a command an author wrote
   *  (`eslint .`) runs the repository's pinned copy - `node_modules/.bin` walked up the tree, for
   *  npm. Every plugin contributes, unlike the seams above where the first answer wins: a PATH is
   *  a list, and a polyglot repository wants both ecosystems' binaries reachable. */
  getBinPaths?: BinPath.Provider;

  /**
   * What the *package itself* declares for a lifecycle script, from this technology's own files -
   * npm's `package.json` `scripts`, with `pre<script>`/`<script>`/`post<script>`.
   *
   * **A query, not a hook, and not build-specific** - which is why it is `getRunSteps` rather than
   * anything beginning `on`. It returns what the package declares and rman decides what to do with
   * it; `run`/`build`/`test` ask, and so does `version`, whose `preversion`/`version`/`postversion`
   * are the same shape (`runLifecycleSlot` -> `contributedSlots`). A name mentioning `build` would
   * have been wrong about half its callers.
   */
  getRunSteps?: RunService.StepSource;

  /** How this technology's releases are planned - where a package's change boundary comes from
   *  when it has no release tag, and how far into its group a bump reaches. */
  versionPlanner?: VersionPlanService;

  /**
   * Anything this plugin contributes that is not one of the seams above, run once when it is
   * registered.
   *
   * **The escape hatch, not the front door.** Commands and publish targets are `.rmanrc` keys
   * (`commands`, `publishTargets`), so a plugin contributing only those declares them in its own
   * config and needs no `init` at all. What is left for `init` is whatever the seams do not name
   * yet, reached through `ctx.app`.
   *
   * **It runs inside `Repository.create`**, before any package is known, so `ctx.app.repository`
   * throws there. Anything wanting the repository belongs in a command's factory instead, which
   * runs once there is one.
   */
  init?(ctx: PluginContext): void | Promise<void>;
}

/**
 * What `Plugin.init` is handed.
 *
 * Only the application today. An object rather than a bare parameter so a member added later
 * breaks nothing already written against it - the same reason `CommandContext` is one, which has
 * already paid for itself twice.
 */
export interface PluginContext {
  app: RmanApplication;
}

/** Identity helper, so a plugin can be written as an object literal and still be checked - the
 *  same shape `defineConfig` has. Returns `plugin` unchanged. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/**
 * The plugin a package gets when **none** claimed its directory - a repository naming no plugin,
 * or a directory none of the named ones recognized.
 *
 * It exists so `Package.plugin` need not be optional. `Package.provider` was an empty string for
 * exactly this case, and every reader had to know that; an object with an empty `name` says the
 * same thing without a guard, and `pkg.provider === 'node'` - the check CLAUDE.md prescribes -
 * reads the same either way.
 *
 * **Every documented behaviour of "no plugin" survives unchanged**, because the absences are the
 * behaviour:
 *
 * - a reader that recognizes nothing -> `Manifest.read` falls through to its own empty manifest,
 *   exactly as it does when no plugin answers;
 * - no `getWorkspace` -> a repository naming no plugin has no packages beyond itself, which is the
 *   boundary working rather than failing (`workspaces` in a `package.json` is npm's idea);
 * - no `getBinPaths` -> nothing is prepended to a child process's PATH, so the inherited one
 *   stands on its own rather than being guessed at;
 * - no `getRunSteps` -> a package's steps come from its `.rmanrc` alone, the core's only source;
 * - no `versionPlanner` -> `version`/`changed` fail naming the key, rather than releasing a
 *   plausible but untrue set of packages from a default nobody chose.
 */
export const basePlugin: Plugin = {
  name: '',
  manifestProvider: {
    name: '',
    fileName: '',
    /** Recognizes nothing, which is the point: `Manifest.read` falls through to its own empty
     *  manifest exactly as it does when no plugin answers. */
    read: (): Manifest | undefined => undefined,
    write: (): void => undefined,
  },
};
