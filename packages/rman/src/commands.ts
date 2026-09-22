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
 * being hand-written centrally, in what is now `rman-config.interface.ts`).
 */
import './commands/build.command.js';
import './commands/changed.command.js';
import './commands/changelog.command.js';
import './commands/config.command.js';
import './commands/diff.command.js';
import './commands/exec.command.js';
import './commands/github-release.command.js';
import './commands/import.command.js';
import './commands/info.command.js';
import './commands/list.command.js';
import './commands/publish.command.js';
import './commands/run.command.js';
import './commands/test.command.js';
import './commands/version.command.js';

/** The config shapes a command declares by hand, where an option cannot describe them - see
 *  `RmanConfig.CommandContribution`'s `Extra`. Exported so a plugin can name one. */
export type { PublishExtraKeys, PublishTargetConfigs } from './commands/publish.command.js';
export type { VersionExtraKeys, VersionStampEntry } from './commands/version.command.js';
