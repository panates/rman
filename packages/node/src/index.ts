import './augmentation/rman.augmentation.js';
import { definePlugin, RmanApplication, type TechStack } from 'rman';
import { packageJsonManifest } from './augmentation/manifest.augmentation.js';
import { packageJsonSteps } from './augmentation/run.augmentation.js';
import { augmentSystemInfo } from './augmentation/system-info.augmentation.js';
import { npmWorkspace } from './augmentation/workspace.augmentation.js';
import * as ciCommand from './commands/ci.command.js';
import * as cleanCommand from './commands/clean.command.js';
import * as publishCommand from './commands/publish.command.js';
import { defineConfig } from './interfaces/rman-config.interface.js';
import { nodeVersionPlanner } from './services/version-plan.service.js';
import { npmBinPaths } from './utils/npm-run-path.js';

export { DEPENDENCY_KEYS, packageJsonManifest } from './augmentation/manifest.augmentation.js';
export { packageJsonSteps } from './augmentation/run.augmentation.js';
export { augmentSystemInfo } from './augmentation/system-info.augmentation.js';
export { npmWorkspace } from './augmentation/workspace.augmentation.js';
export type { NodeConfigKeys, RmanNodeConfig } from './interfaces/rman-config.interface.js';
export { defineConfig } from './interfaces/rman-config.interface.js';
export { CiService } from './services/ci.service.js';
export { CleanService } from './services/clean.service.js';
export { PublishService } from './services/publish.service.js';
export { nodeVersionPlanner, NodeVersionPlanService } from './services/version-plan.service.js';
export { npmBinPaths } from './utils/npm-run-path.js';
export type { ParsedWorkspaceRange } from './utils/workspace-range.js';
export { parseWorkspaceRange, resolveWorkspaceRange } from './utils/workspace-range.js';

/** The version this package reports. Rewritten into `build/index.js` by `support/postbuild.cjs`. */
export const version = '1';

/**
 * Node.js support for rman, as a plugin:
 *
 * ```yaml
 * # .rmanrc.yml
 * plugins: ['rman-node']
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
augmentSystemInfo();

/** Everything this package contributes to rman, as one plugin. Exported by name as well, for code
 *  registering it directly instead of through a config. */
/**
 * **Node, as one technology.** What a package's name and version are, where the packages are, where
 * its scripts come from, where its binaries live, and how its releases are planned - five answers
 * that only make sense together. `packageJsonSteps` reads `pkg.manifest.raw?.scripts`, so it is
 * meaningless without `packageJsonManifest` having produced that manifest; the old five independent
 * plugin fields let them be declared apart.
 */
export const nodeTechStack: TechStack = {
  name: 'node',
  manifestProvider: packageJsonManifest,
  workspaceProvider: npmWorkspace,
  runSteps: packageJsonSteps,
  binPathsProvider: npmBinPaths,
  versionPlanner: nodeVersionPlanner,
};

/** Everything this package contributes to rman, as one plugin. Exported by name as well, for code
 *  registering it directly instead of through a config. */
export const nodePlugin = definePlugin({
  name: 'rman-node',
  init(ctx) {
    ctx.addTechStack(nodeTechStack);
    for (const command of [publishCommand.command, ciCommand.command, cleanCommand.command]) {
      ctx.addCommand(command);
    }
  },
});

/**
 * Registers the stack for a programmatic caller that never goes through `plugins` - replacing the
 * four `augmentRun`/`augmentWorkspace`/`augmentVersionPlan`/`augmentBinPath` calls, which is what
 * declaring the technology as a whole buys.
 *
 * **Not called as this module loads**, unlike `augmentSystemInfo()` above. Those four were, and a
 * technology cannot be: the application is reset between runs (and between tests), so a
 * registration performed once at import would be gone by the time anything asked - and an import
 * side effect is the wrong shape anyway, since which technologies a repository has is what its
 * `plugins` says. A caller outside the CLI calls this itself.
 */
export function augmentTechStack(app: RmanApplication): void {
  app.techStacks.add(nodeTechStack);
  app.versionPlanner = nodeVersionPlanner;
}

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
