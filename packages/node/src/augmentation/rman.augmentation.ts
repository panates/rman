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
   * `WithAppend<RmanConfigKeys>` is a mapped type evaluated where it is used, so `+clean` comes
   * along on its own.
   */
  interface RmanConfigKeys extends NodeConfigKeys {}

  namespace RmanConfig {
    /** The npm half of `publish`. `target`, `skip` and `docker` stay in the core: the first two are
     *  read by `list` and by every target's own plan, and Docker publishing is not Node's. */
    interface PublishOptionsKeys extends RmanNodeConfig.PublishOptions {}
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
