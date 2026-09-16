/**
 * Programmatic API - the same logic the CLI commands run, importable directly without going
 * through yargs/argv. Each domain's logic lives in a `<Name>` namespace under `./services/*.ts`
 * (e.g. `ChangelogService`, `CiService`, `CleanService`, `ListService`, `RunService`,
 * `SystemInfo`, `VersionService`), re-exported here via `./services.js`. Purpose-specific functions, not one
 * generic `run`/`get` per domain (see e.g. `SystemInfo.getSystemInfo`/`getRepositoryInfo`, kept
 * separate since they're genuinely independent capabilities, not just steps of one operation) -
 * CLI-only concerns (argv parsing, `--help` text, and all console/file presentation) stay in
 * `cli.ts` and the individual `commands/*.command.ts` modules, which are not exported here.
 */
export { defineConfig } from './core/config.js';
export type { CommandContext, CustomCommand } from './core/custom-command.js';
export { defineCommand } from './core/custom-command.js';
export { Package } from './core/package.js';
export { Repository } from './core/repository.js';
export * from './interfaces/rman-config.interface.js';
export * from './services.js';
export type { DetectChangeHashOptions } from './utils/change-hash.js';
export { detectChangeHash } from './utils/change-hash.js';
export type { LogLevel } from './utils/logger.js';
export { LOG_LEVELS, Logger, resolveRootLogLevel } from './utils/logger.js';
