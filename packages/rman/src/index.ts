/**
 * Programmatic API - the same logic the CLI commands run, importable directly without going
 * through yargs/argv. Each domain's logic lives in a `<Name>` namespace under `./services/*.ts`
 * (e.g. `ChangelogService`, `ListService`, `RunService`, `VersionService`),
 * re-exported here via `./services.js`. Purpose-specific functions, not one generic `run`/`get`
 * per domain - CLI-only concerns (argv parsing, `--help` text, and all console/file presentation)
 * stay in `cli.ts` and the individual `commands/*.command.ts` modules, which are not exported here.
 *
 * **This is also the plugin contract.** A third-party plugin is an ordinary package that imports
 * from here, so everything a command needs in order to live outside rman has to be exported - the progress panel, the package filter, the branch guard, the git helper. What is
 * *not* exported is deliberately private: config resolution internals, the expression evaluator,
 * the command registry.
 */
/**
 * **The `node` built-in's type augmentation, imported for the same reason `commands.ts` is.**
 *
 * A `declare module` augmentation applies only where the module declaring it is part of the
 * program. The node plugin's lives in `plugins/node/augmentation/rman.augmentation.ts` and is
 * imported by the *plugin's* entry point - which nothing here reached, so `clean`, `publish.npm`
 * and the rest existed for rman itself and for nobody else.
 *
 * **Measured on a real consumer**, `@panates/rman-node`, a config package annotated with these
 * types: `Object literal may only specify known properties, and 'clean' does not exist in type
 * 'RmanConfig'`, plus `Property 'npm' does not exist` - ten errors across its config and its own
 * suite. It is the identical failure the core's command keys caused when they stopped being
 * hand-written centrally, and it reappeared the moment the plugin moved *inside* rman: until then
 * a consumer imported `rman-node` and got the augmentation with the package.
 *
 * Type-only, so the emitted module is empty - imported for what it declares, not for what it does.
 * Pinned in `docs-api.spec.ts`, which imports only from this file.
 */
import './builtins/platforms/node/augmentation/rmanrc.augmentation.js';
import type { RmanConfig as CommandDeclaration } from './interfaces/rman-config.interface.js';

export { defineConfig } from './interfaces/rman-config.interface.js';
/**
 * Merges `source` onto `target` the way rman layers an `extends` base, a directory level or a
 * `"[selector]"` block - returning `target`, mutated.
 */
/* **Exported for a config assembled in JavaScript**, which `@panates/rman-preset` is: it composes
 * one config from a platform-neutral part and a Node one, and a plain object spread gets that
 * wrong in two ways a reader would not expect.
 *
 * A spread is shallow, so two objects both declaring `changelog` keep only the later one's -
 * silently, and wholesale. A deep merge from a general-purpose library fixes that half and breaks
 * the other: measured with `@jsopen/objects`' `merge({deep: true})`, `commands: ['a','b']` merged
 * with `['c']` gives `['c']`, while rman appends those - `commands`, `plugins`, `platforms` and
 * `publishTargets` are `ALWAYS_APPEND` keys precisely because naming one of your own never means
 * "and drop the ones my base brought". A generic merge would drop a preset's commands the day
 * anything else declared one.
 *
 * `origin` is the file `source` was read from, recorded per key so a failing expression can name
 * it. A caller merging an object it built rather than read passes nothing, and the error then
 * names whatever file the surrounding config came from.
 *
 * **`extends` remains the better answer where it fits**, and it is worth trying first: a config
 * module can carry `extends: ['./other.js']` and let rman do the merging, which costs no API
 * surface at all and keeps the origins exact. Measured to work for a JS module extending a JS
 * module, nested inside a config that is itself an `extends` target. This export is for the case
 * where one module has to hand back a single finished object. */
export { mergeConfig } from './core/config/merge-config.js';
/**
 * **A config value written as a function**, and the scope it is handed. Exported because a config
 * author could not name either: `interpolateConfig` calls a function wherever a `${{ }}` could
 * stand, but the only function form the types admitted was a *step* - so the primary spelling of
 * `value` was unexpressible.
 *
 * `ConfigValueContext` is what a value function receives; `ConfigScope` is the same thing without
 * `value`, i.e. what an expression sees. Not to be confused with `RunStepContext`, which is what a
 * step gets, later, with a working directory and a `runBin`.
 */
export type { CommandContext, CustomCommand } from './core/interfaces/custom-command.js';
export { defineCommand } from './core/interfaces/custom-command.js';
export type { ConfigScope, ConfigValueContext, FileScope, PackageScope } from './interfaces/config-scope.interface.js';
export type { ConfigValue, Resolved, ResolvedConfig } from './interfaces/rman-config.interface.js';
/** Both the shape and the registry: `const m: Manifest` and `Manifest.read(dir)` - merged onto one
 *  name so a plugin can augment it the way it augments `SystemInfo`. */
export { RmanApplication } from './core/application.js';
/** The manifest seam, grouped on a plugin as `Plugin.manifestProvider`: where a package's name and
 *  version are written, what it declares, and how it is numbered and stamped. The core has none -
 *  `package.json` is npm's answer, and belongs to the `node` built-in. */
export { Package } from './core/classes/package.js';
export type { ManifestProvider } from './core/interfaces/manifest.js';
export { Manifest } from './core/interfaces/manifest.js';
/** The publish seam: where a package's artifact ships. The core brings `docker` (nobody's
 *  ecosystem); npm's target is the `node` built-in's, and any other technology's is its own plugin's. */
export { Registry } from './core/classes/registry.js';
export { Repository } from './core/classes/repository.js';
export { Service, type ServiceFactory, type ServiceMap } from './core/classes/service.js';
export {
  declaredTargets,
  type PublishTarget,
  shipsTo,
  skipReasonFor,
  targetsOf,
  unknownTargets,
} from './core/interfaces/publish-target.js';
export type {
  RunConditionFn,
  RunStepContext,
  RunStepFn,
  RunStepObject,
  RunStepValue,
} from './core/interfaces/run-step.js';
/**
 * **`Platform` is one technology, whole**; **`Plugin` is whatever a package contributes**, platforms
 * among them.
 *
 * A platform says how its packages are recognized and written, where they live, what goes on a
 * child's PATH and how its releases are planned - `manifestProvider` is what makes one, and it is
 * required. A plugin carries `platforms` and an `init` for anything the seams do not name yet; a
 * bare `Platform` is accepted wherever a `Plugin` is, as sugar for the plugin that provides only it.
 *
 * **Both must be declared through their factory.** `loadPlugins` checks for the mark, because an
 * rman 1.x plugin was `{ name, init }` and so is a 2.x plugin contributing nothing but an `init` -
 * no shape test can tell them apart.
 */
export type { ChangeKind } from './core/classes/version-scheme.js';
export {
  basePlatform,
  definePlatform,
  definePlugin,
  isPlatform,
  type Platform,
  type Plugin,
  type PluginContext,
} from './core/interfaces/plugin.js';
/** The numbering seam. `VersionScheme` is abstract - `highestVersion`/`highestBump`/`smallestBump`
 *  are implemented from the members around them, so a scheme states only what it must and still
 *  overrides any of the three. `SemverScheme` is exported to subclass rather than restate. */
export { assertOneScheme, SemverScheme, semverScheme, VersionScheme } from './core/classes/version-scheme.js';
/** The workspace seam: how a repository's packages are found. A plugin contributes a provider
 *  (see `Plugin.workspace`); the core has none, so `workspaces` is npm's idea and belongs to the
 *  `node` built-in. */
/** `Workspace.Layout`, `Workspace.Provider`, `Workspace.addProvider`, `Workspace.resolve`,
 *  `Workspace.findRoot` - one namespace, so a plugin can augment it. */
export { Workspace } from './core/classes/workspace.js';
/**
 * **How a command is declared** - the same API the built-ins use, so a plugin's command is declared
 * rather than built: options as data (checked for typos), positionals named against the command
 * string, `--config` keys derived from what the command owns, and `ArgsOf` for the handler.
 *
 * `declareCommand`, not `registerCommand`: the latter pushes onto a module-level registry every
 * `runCli` walks, so a plugin using it would give its commands to repositories that never named it.
 * Anything else puts the function in its config's `commands`.
 *
 * **Flat names rather than `RmanConfig.CommandOption`**, and they outlived the reason they were
 * introduced: a second file exported a `RmanConfig` too, so the namespace holding these was
 * unreachable from outside the package. The two are one file now and `RmanConfig` *is* exported -
 * these stay because they are the better names for the job. A plugin author declaring a flag wants
 * `CommandOption`; the config it happens to contribute to is not what they are naming.
 */
export { declareCommand } from './interfaces/rman-config.interface.js';
export type CommandOption = CommandDeclaration.CommandOption;
/** One declared positional, for the same reason `CommandOption` is here: it is the other half of a
 *  command's surface, and it was the half a plugin could not name without importing yargs. */
export type PositionalOption = CommandDeclaration.PositionalOption;
export type CommandMetadata = CommandDeclaration.CommandMetadata;
export type CommandRegisterFunction = CommandDeclaration.CommandRegisterFunction;
/** The argv a command's handler is annotated with - see `RmanConfig.ArgsOf` for why it is annotated
 *  rather than inferred. */
export type ArgsOf<C, Cmd extends string> = CommandDeclaration.ArgsOf<C, Cmd>;
export type GlobalArgs = CommandDeclaration.GlobalArgs;
export * from './commands.js';
export * from './interfaces/rman-config.interface.js';
export * from './services.js';

// --- what a command needs to behave like a built-in one -----------------------------------------

/** Branch guarding: `allowBranch`/`ignoreBranch`, so a plugin's release command refuses to run on
 *  the wrong branch exactly as `publish` and `version` do. */
export {
  applyBranchGuardOptions,
  assertAllowedBranch,
  type BranchGuardOptions,
  branchGuardOptions,
  readBranchGuardOptions,
} from './utils/branch-guard.js';
/**
 * The flags every `run`-shaped command shares - `--parallel`, `--bail`, `--topo`, `--progress`,
 * `--changed`, `--changed-since`, plus the package filters - and the reader that turns them into
 * `RunService.Options`.
 */
/* **Exported because a plugin cannot otherwise write an alias for `run <script>`.** `build` is one
 * (`configKeys: ['run.build']`, a handler that calls `runScript`) and it reaches these through a
 * relative import; a preset adding `compile` or `docs` had no way to, so it would restate the six
 * flags and the reader - two lists free to disagree, which is how a flag ends up meaning one thing
 * on `rman build` and nothing on the alias beside it. */
export { parallelOptions, readParallelOptions, readRunOptions, runOptions } from './utils/run-options.js';
/** Where a repository's locally installed binaries live - the core spells the PATH variable, a
 *  plugin says which directories go on it (see `Plugin.binPaths`). */
export { BinPath } from './utils/bin-path.js';
/** A shell command, with the repository's local binaries on PATH - for a command string an author
 *  wrote. `runBin` is the one to reach for when the arguments are assembled in code. */
export type { LogLevel } from './core/classes/logger.js';
export { LOG_LEVELS, Logger, resolveRootLogLevel } from './core/classes/logger.js';
export type { ExecOptions, ExecResult } from './utils/exec.js';
export { exec } from './utils/exec.js';
export { GitHelper } from './utils/git.js';
/** `--scope`/`--deps`/`--dependents`/`--private`, so a plugin's command filters packages the same
 *  way every built-in does rather than inventing its own flags. */
export {
  applyFromRootOption,
  applyPackageFilterOptions,
  filterPackages,
  fromRootOption,
  type PackageFilterOptions,
  packageFilterOptions,
  readFromRootOption,
  readPackageFilterOptions,
  ROOT_SELECTOR,
} from './utils/package-filter.js';
/** The live panel `run`/`build`/`clean` print - a plugin's per-package command looks like the rest
 *  of rman instead of like a script someone bolted on. */
export {
  formatDuration,
  type ProgressItem,
  ProgressPanel,
  type ProgressStatus,
  type ProgressSummary,
} from './core/classes/progress-panel.js';
/** Version stamping helpers a `Plugin.stampVersion` can delegate to - the quoted-constant
 *  pattern most languages share, and the OCI Dockerfile label (which `version` stamps itself, since
 *  the label's value is by specification the package's version). */
/** A calendar version's time part (`2026.9.15-1430`) is a semver *prerelease identifier* by
 *  construction, so anything asking "is this a preview?" has to rule it out first - `github-release`
 *  does, and so must a publish target deciding whether a version needs its own dist-tag. Exported
 *  because that second caller lives in a plugin. */
/**
 * **The `node` preset's own surface.** It ships inside rman rather than as `rman-node`, so its
 * services and target are named from here - a repository gets the technology from
 * `DEFAULT_PRESETS`, or names it with `extends: "rman:node"`, and never constructs any of this by
 * hand.
 *
 * Its `.rmanrc` *keys* arrive separately, through the bare import at the top of this file - see
 * there for why that import is not tidiness.
 */
export type { NodeConfigKeys, RmanNodeConfig } from './builtins/platforms/node/node-config.interface.js';
export { CiService } from './builtins/platforms/node/services/ci.service.js';
export { CleanService } from './builtins/platforms/node/services/clean.service.js';
export { PublishService } from './builtins/platforms/node/services/publish.service.js';
export { NodeVersionPlanService } from './builtins/platforms/node/services/version-plan.service.js';
export type { ParsedWorkspaceRange } from './builtins/platforms/node/utils/workspace-range.js';
export { NPM_TARGET, NpmPublishTarget } from './builtins/publish-targets/npm/npm-publish-target.js';
export { isCalendarVersion } from './utils/release-version.js';
export type { RunBinOptions, RunBinResult } from './utils/run-bin.js';
export { runBin } from './utils/run-bin.js';
export { OCI_VERSION_LABEL, stampVersionConstant, stampVersionLabel } from './utils/version-stamp.js';
