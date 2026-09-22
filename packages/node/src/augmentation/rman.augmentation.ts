import type cleanCommand from '../commands/clean.command.js';
import type { CleanExtraKeys } from '../commands/clean.command.js';
import type { NodeConfigKeys, RmanNodeConfig } from '../interfaces/rman-config.interface.js';
import type { CiService } from '../services/ci.service.js';

/**
 * **Every type this plugin adds to rman, in one `declare module` block.**
 *
 * One block, and that is not tidiness: a *second* `declare module 'rman'` anywhere in this package
 * silently disables the first. Measured - moving the config keys into their own file left
 * `SystemInfo.PackageManager` unresolved at four call sites in `system-info.augmentation.ts`, with
 * no error pointing at the cause. So a new augmentation goes **here**, beside the others, rather
 * than next to the code it belongs to.
 *
 * Type-only. The runtime half of each augmentation lives with its own subject
 * (`augmentSystemInfo()`, `augmentManifest()`, ...); this file is imported by the plugin's entry
 * point purely so a consumer's compiler loads it.
 */
declare module 'rman' {
  /**
   * The `.rmanrc` keys that only mean something in a Node repository - merged into the core's own
   * key list, so `pkg.config.clean` is typed wherever it is read (`CleanService` included) without
   * a cast, and without the core declaring a key it knows nothing about.
   *
   * The augmentation is evaluated where it is used, so `clean` is typed at the place it is read.
   */
  interface RmanConfigKeys extends NodeConfigKeys {}

  /**
   * **`clean.*`, contributed by the command that reads it**, the way every built-in contributes its
   * own key - `skip` derived from the command's `config` block, `include`/`exclude` hand-written in
   * `CleanExtraKeys` because a `CommandOption` cannot say "a glob *or* a list of them".
   *
   * It is declared here rather than beside the command only because of the one-block rule above.
   * rman's own commands put theirs next to themselves, augmenting a module path instead of a
   * package name, which has no such limit.
   */
  namespace RmanConfig {
    interface CommandConfigs extends RmanConfig.CommandContribution<ReturnType<typeof cleanCommand>, CleanExtraKeys> {}
  }

  /**
   * The `npm` publish target's own `publish.*` block, declared the way the core's `docker` target
   * declares `publish.docker` - through the slot `publish` contributes, rather than into a central
   * `PublishOptionsKeys` that the core owned.
   *
   * That is the config half of a target being a contribution: this package brings the flags, the
   * registry check, *and* the keys, and none of it is written down in rman.
   */
  interface PublishTargetConfigs {
    /** The `npm` target's block, named after the target exactly as the core's `docker` one is. */
    npm?: RmanNodeConfig.NpmPublishOptions;
  }

  namespace SystemInfo {
    type PackageManager = CiService.PackageManager;

    interface Options {
      /**
       * Report this package manager's version under `Binaries`, plus the `npmPackages` sections.
       *
       * Defaults to `.rmanrc "packageManager"` (read off `Options.repository`), then to `npm` -
       * this package being installed is itself the statement that the repository is a Node one.
       */
      packageManager?: PackageManager;
    }
  }
}
