/**
 * Programmatic API - the same logic the CLI commands run, importable directly without going
 * through yargs/argv. Each domain's logic lives in a `<Name>` namespace under `./services/*.ts`
 * (e.g. `ChangelogService`, `ListService`, `RunService`, `VersionService`),
 * re-exported here via `./services.js`. Purpose-specific functions, not one generic `run`/`get`
 * per domain - CLI-only concerns (argv parsing, `--help` text, and all console/file presentation)
 * stay in `cli.ts` and the individual `cmd/*.command.ts` modules, which are not exported here.
 *
 * **This is also the plugin contract.** A plugin (`rman-node`, say) is an ordinary package that
 * imports from here, so everything a command needs in order to live outside rman has to be
 * exported - the progress panel, the package filter, the branch guard, the git helper. What is
 * *not* exported is deliberately private: config resolution internals, the expression evaluator,
 * the command registry.
 */
import type { RmanConfig as CommandDeclaration } from './interfaces/rman-cfg.interface.js';

export { defineConfig } from './core/config.js';
export type { CommandContext, CustomCommand } from './core/custom-command.js';
export { defineCommand } from './core/custom-command.js';
/** The manifest seam: where a package's name and version are written, and how it is numbered.
 *  The core has no provider - `package.json` is npm's answer, and lives in `rman-node`. */
export type { ManifestProvider } from './core/manifest.js';
/** Both the shape and the registry: `const m: Manifest` and `Manifest.read(dir)` - merged onto one
 *  name so a plugin can augment it the way it augments `SystemInfo`. */
export { RmanApplication } from './core/application.js';
export { Manifest } from './core/manifest.js';
export { Package } from './core/package.js';
export type { RmanPlugin } from './core/plugin.js';
export { definePlugin } from './core/plugin.js';
/** The publish seam: where a package's artifact ships. The core brings `docker` (nobody's
 *  ecosystem); npm's target lives in `rman-node`, and any other technology's in its own plugin. */
export { declaredTargets, type PublishTarget, shipsTo, targetsOf, unknownTargets } from './core/publish-target.js';
export { Registry } from './core/registry.js';
export { Repository } from './core/repository.js';
export type { RunConditionFn, RunStepContext, RunStepFn, RunStepValue } from './core/run-step.js';
export { Service, type ServiceFactory, type ServiceMap } from './core/service.js';
export { baseTechStack, type TechStack } from './core/tech-stack.js';
export type { ChangeKind } from './core/version-scheme.js';
/** The numbering seam. `VersionScheme` is abstract - `highestVersion`/`highestBump`/`smallestBump`
 *  are implemented from the members around them, so a scheme states only what it must and still
 *  overrides any of the three. `SemverScheme` is exported to subclass rather than restate. */
export { assertOneScheme, SemverScheme, semverScheme, VersionScheme } from './core/version-scheme.js';
/** The workspace seam: how a repository's packages are found. A plugin contributes a provider
 *  (see `RmanPlugin.workspace`); the core has none, so `workspaces` is npm's idea and lives in
 *  `rman-node`. */
/** `Workspace.Layout`, `Workspace.Provider`, `Workspace.addProvider`, `Workspace.resolve`,
 *  `Workspace.findRoot` - one namespace, so a plugin can augment it. */
export { Workspace } from './core/workspace.js';
/**
 * **How a command is declared** - the same API the built-ins use, so a plugin's command is declared
 * rather than built: options as data (checked for typos), positionals named against the command
 * string, `--config` keys derived from what the command owns, and `ArgsOf` for the handler.
 *
 * `declareCommand`, not `registerCommand`: the latter pushes onto a module-level registry every
 * `runCli` walks, so a plugin using it would give its commands to repositories that never named it.
 * A plugin hands the function to `ctx.addCommand`.
 *
 * **Flat names rather than `RmanConfig.CommandOption`**, and they outlived the reason they were
 * introduced: a second file exported a `RmanConfig` too, so the namespace holding these was
 * unreachable from outside the package. The two are one file now and `RmanConfig` *is* exported -
 * these stay because they are the better names for the job. A plugin author declaring a flag wants
 * `CommandOption`; the config it happens to contribute to is not what they are naming.
 */
export { declareCommand } from './interfaces/rman-cfg.interface.js';
export type CommandOption = CommandDeclaration.CommandOption;
export type CommandMetadata = CommandDeclaration.CommandMetadata;
export type CommandRegisterFunction = CommandDeclaration.CommandRegisterFunction;
/** The argv a command's handler is annotated with - see `RmanConfig.ArgsOf` for why it is annotated
 *  rather than inferred. */
export type ArgsOf<C, Cmd extends string> = CommandDeclaration.ArgsOf<C, Cmd>;
export type GlobalArgs = CommandDeclaration.GlobalArgs;
export * from './commands.js';
export * from './interfaces/rman-cfg.interface.js';
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
/** Where a repository's locally installed binaries live - the core spells the PATH variable, a
 *  plugin says which directories go on it (see `RmanPlugin.binPaths`). */
export { BinPath } from './utils/bin-path.js';
/** A shell command, with the repository's local binaries on PATH - for a command string an author
 *  wrote. `runBin` is the one to reach for when the arguments are assembled in code. */
export type { ExecOptions, ExecResult } from './utils/exec.js';
export { exec } from './utils/exec.js';
export { GitHelper } from './utils/git.js';
export type { LogLevel } from './utils/logger.js';
export { LOG_LEVELS, Logger, resolveRootLogLevel } from './utils/logger.js';
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
} from './utils/progress-panel.js';
/** Version stamping helpers a `ManifestProvider.stampVersion` can delegate to - the quoted-constant
 *  pattern most languages share, and the OCI Dockerfile label (which `version` stamps itself, since
 *  the label's value is by specification the package's version). */
export type { RunBinOptions, RunBinResult } from './utils/run-bin.js';
export { runBin } from './utils/run-bin.js';
export { OCI_VERSION_LABEL, stampVersionConstant, stampVersionLabel } from './utils/version-stamp.js';
