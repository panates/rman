import type cleanCommand from '../commands/clean.command.js';
import type { CleanExtraKeys } from '../commands/clean.command.js';
import type { NodeConfigKeys, RmanNodeConfig } from '../node-config.interface.js';
import type { CiService } from '../services/ci.service.js';

/**
 * **Every type this plugin adds to rman, in one `declare module` block.**
 *
 * **One block was once forced and is now only convenient.** While this shipped as its own package
 * it augmented the *package name* `'rman'`, and a second such block anywhere silently disabled the
 * first - measured, `SystemInfo.PackageManager` went unresolved at four call sites with nothing
 * pointing at the cause. Bundled into rman, these augment a **module path** like every built-in
 * command's own contribution does, and that limit is gone; they stay together because the plugin's
 * types read better in one place, not because they have to.
 *
 * Type-only. The runtime half of each augmentation lives with its own subject
 * (`augmentSystemInfo()`, `augmentManifest()`, ...); this file is imported by the plugin's entry
 * point purely so a consumer's compiler loads it.
 */
declare module '../../../interfaces/rman-config.interface.js' {
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
}

/**
 * **The `npm` target's own `publish.*` block** - declared into the slot `publish` exports, exactly
 * where the core's own `docker` target declares `publish.docker`.
 *
 * A *different* module from the block above, and that is the shape the fold made possible: while
 * this shipped as `rman-node` everything had to augment the one package name `'rman'`, so a slot
 * declared in `publish.command.ts` was reachable only by re-declaring it - which now reads as two
 * interfaces of one name and is refused. Each interface is augmented where it lives.
 */
declare module '../../../commands/publish.command.js' {
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
}

/**
 * **The npm half of `SystemInfo`** - what `rman info` reports once a repository is a Node one. The
 * runtime half is `augmentSystemInfo()` in the file beside this one, called when the built-in is
 * registered rather than at import, so a repository that never named it reports no npm.
 */
declare module '../../../services/system-info.js' {
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
