import './augmentation/rman.augmentation.js';
import { definePlugin } from 'rman';
import { augmentManifest, packageJsonManifest } from './augmentation/manifest.augmentation.js';
import { augmentRun, packageJsonSteps } from './augmentation/run.augmentation.js';
import { augmentSystemInfo } from './augmentation/system-info.augmentation.js';
import { augmentWorkspace, npmWorkspace } from './augmentation/workspace.augmentation.js';
import * as ciCommand from './commands/ci.command.js';
import * as cleanCommand from './commands/clean.command.js';
import * as publishCommand from './commands/publish.command.js';
import { defineConfig } from './interfaces/rman-config.interface.js';
import { augmentVersionPlan, nodeVersionPlanner } from './services/version-plan.service.js';
import { augmentBinPath, npmBinPaths } from './utils/npm-run-path.js';

export { augmentManifest, DEPENDENCY_KEYS, packageJsonManifest } from './augmentation/manifest.augmentation.js';
export { augmentRun, packageJsonSteps } from './augmentation/run.augmentation.js';
export { augmentSystemInfo } from './augmentation/system-info.augmentation.js';
export { augmentWorkspace, npmWorkspace } from './augmentation/workspace.augmentation.js';
export type { NodeConfigKeys, RmanNodeConfig } from './interfaces/rman-config.interface.js';
export { defineConfig } from './interfaces/rman-config.interface.js';
export { CiService } from './services/ci.service.js';
export { CleanService } from './services/clean.service.js';
export { PublishService } from './services/publish.service.js';
export { augmentVersionPlan, nodeVersionPlanner, NodeVersionPlanService } from './services/version-plan.service.js';
export { augmentBinPath, npmBinPaths } from './utils/npm-run-path.js';
export type { ParsedWorkspaceRange } from './utils/workspace-range.js';
export { parseWorkspaceRange, resolveWorkspaceRange } from './utils/workspace-range.js';

/** The version this package reports. Rewritten into `build/index.js` by `support/postbuild.cjs`. */
export const version = '1';

/**
 * Node.js support for rman, as a plugin:
 *
 * ```yaml
 * # .rmanrc.yml
 * plugins: ['@rman/node']
 * ```
 *
 * rman's core is about repositories - packages, versions, changelogs, releases, branches. These
 * three commands are about *npm*, which is a different thing that happens to be true of most
 * repositories rman has been used on so far:
 *
 * - **`publish`** asks an npm registry whether a version is already out there, and pushes it -
 *   including the manifest it generates in a build directory, the `"workspace:"` ranges it
 *   resolves, and the `devDependencies` it strips.
 * - **`ci`** deletes `node_modules` and a lockfile, and reinstalls with npm/yarn/pnpm/bun.
 * - **`clean`** deletes TypeScript's output - a compiled `.js`/`.js.map`/`.d.ts` beside its `.ts`
 *   source, a `*.tsbuildinfo`, skipping `node_modules` while it looks. Every one of those is a
 *   TypeScript fact, so a core `clean` was a command that only looked general: nothing in it would
 *   fire for a Cargo or Go repository, which have `cargo clean` and `go clean` of their own. The
 *   `clean.include`/`clean.exclude` globs came along because splitting them off would leave two
 *   commands with one name.
 *
 * `.rmanrc "packageManager"` is **this package's** config key, declared in `NodeConfigKeys` and
 * merged into `RmanConfig` by declaration - `ci`/`publish` read it to decide which one to shell out
 * to, and the `SystemInfo` augmentation reads it to decide which version to report. It was core
 * "because `info` reads it", and that stopped being true when `SystemInfo`'s npm half moved here:
 * measured, nothing in the core read it at all, only the declaration was left behind.
 *
 * **Docker stayed in the core**, where it belongs - any language's project can publish an image.
 * What is still wrong is that this command *drives* it: `publish --target docker` in a repository
 * that is not a Node one would have to install this plugin to reach it. Fixing that means making a
 * publish target something a plugin contributes to a core `publish`, which is the next step rather
 * than this one.
 */
/** Applied as the plugin module loads - before any command runs, since `loadPlugins` imports this
 *  during CLI startup. Augmentations go here rather than inside a command so that `rman info`,
 *  which is a *core* command, is affected too. */
augmentManifest();
augmentSystemInfo();
augmentRun();
augmentWorkspace();
augmentVersionPlan();
augmentBinPath();

/** Everything this package contributes to rman, as one plugin. Exported by name as well, for code
 *  registering it directly instead of through a config. */
export const nodePlugin = definePlugin({
  name: '@rman/node',
  commands: [publishCommand.command, ciCommand.command, cleanCommand.command],
  /** Declared as well as registered by `augmentRun()` above - `addStepSource` is idempotent per
   *  source, and a plugin loaded through `plugins` should not need an import side effect to work. */
  runSteps: packageJsonSteps,
  /** What finds the packages at all - see `Repository.create` for why this has to be declared
   *  rather than only registered by an import. */
  workspace: npmWorkspace,
  /** What a package's name and version even are - read before anything else. */
  manifest: packageJsonManifest,
  /** What `version`/`changed` compute a release with. `VersionPlanService` is abstract, so without
   *  this the two commands have nothing to ask - see `NodeVersionPlanService`. */
  versionPlanner: nodeVersionPlanner,
  /** `node_modules/.bin` on PATH for every `exec`/`runBin`, so a repository's pinned `eslint`/`tsc`
   *  is the one that runs. */
  binPaths: npmBinPaths,
});

/**
 * **An `.rmanrc` config, not a plugin** - which is what a package naming itself in `plugins` should
 * hand over. A package exposing exactly one plugin was the shape of the plugin it happens to
 * contain today: adding a second, or anything else a config can say, would have changed what every
 * repository importing it receives. As a config it is the same kind of thing as the file that names
 * it, and `plugins` accepts an object entry precisely so this works.
 *
 * Only `plugins` is read out of it by `loadPlugins` - a config's other keys reach a repository
 * through `extends`, the key that means "merge this underneath mine".
 */
export default defineConfig({ plugins: [nodePlugin] });
