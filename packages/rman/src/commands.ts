/**
 * **Every built-in command, and the one place the list lives.**
 *
 * Imported for their side effect: each module calls `registerCommand`, which pushes its register
 * function onto `commandRegistry`. Nothing reads the modules' exports - `runCli` walks the registry
 * - so this import list *is* the built-in command list.
 *
 * **`index.ts` imports this too, and that is not tidiness.** Each module also carries a
 * `declare module` augmentation contributing its own `.rmanrc` keys, and a type augmentation only
 * applies where the module declaring it is part of the program. Reached only from `cli.ts`, those
 * keys existed for rman itself and for nobody else: `rman-node` reading `pkg.config.publish` got
 * `Property 'publish' does not exist on type 'RmanConfig'` (measured, the moment the keys stopped
 * being hand-written centrally, in what is now `rman-cfg.interface.ts`).
 */
import './cmd/build.command.js';
import './cmd/changed.command.js';
import './cmd/changelog.command.js';
import './cmd/config.command.js';
import './cmd/diff.command.js';
import './cmd/exec.command.js';
import './cmd/github-release.command.js';
import './cmd/import.command.js';
import './cmd/info.command.js';
import './cmd/list.command.js';
import './cmd/publish.command.js';
import './cmd/run.command.js';
import './cmd/test.command.js';
import './cmd/version.command.js';

/** The config shapes a command declares by hand, where an option cannot describe them - see
 *  `RmanConfig.CommandContribution`'s `Extra`. Exported so a plugin can name one. */
export type { PublishExtraKeys, PublishTargetConfigs } from './cmd/publish.command.js';
export type { VersionExtraKeys, VersionStampEntry } from './cmd/version.command.js';
