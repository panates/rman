import envinfo from 'envinfo';
import type { Repository } from '../core/repository.js';

export namespace SystemInfo {
  export interface RepositoryInfo {
    type: 'monorepo' | 'package';
    name: string;
    version: string;
    root: string;
    packageCount: number;
  }

  /** Whatever `envinfo` reports, grouped by category - shape is `envinfo`'s own, not ours. */
  export type SystemInfo = Record<string, Record<string, unknown>>;

  /**
   * **Deliberately empty of anything language-specific.** A plugin adds what its own ecosystem
   * needs by augmenting this interface - see `@rman/node`, which adds `packageManager` and turns it
   * into `envinfo` categories. There is no `packageManager` here, and that is the point: the core
   * has no opinion about npm, so a repository in another language cannot end up reporting
   * "npm: Not Found", which is a wrong answer rather than a missing feature.
   */
  export interface Options {
    /**
     * The repository the report is about. The core uses it for nothing - `getRepositoryInfo` is a
     * separate call - and it is here **for augmentations**, which need somewhere to read a setting
     * from: `@rman/node` takes `.rmanrc "packageManager"` off it.
     */
    repository?: Repository;
    /** Extra `envinfo` categories, merged **over** the defaults - so an augmentation can replace
     *  `Binaries` rather than only append to it. */
    envinfo?: envinfo.RunConfig;
  }

  /** The shape of `getSystemInfo` - named so a plugin can wrap it without restating the signature
   *  (see `@rman/node`'s system-info augmentation). */
  export type GetSystemInfo = (options?: Options) => Promise<SystemInfo.SystemInfo>;

  /** What this machine is, in terms true of any repository: OS, CPU, memory, shell, Node, git. */
  export async function getSystemInfo(options?: Options): Promise<SystemInfo.SystemInfo> {
    return JSON.parse(
      await envinfo.run(
        {
          System: ['OS', 'CPU', 'Memory', 'Shell'],
          Binaries: ['Node'],
          Utilities: ['Git'],
          ...options?.envinfo,
        },
        // showNotFound: without it, envinfo *omits* a configured-but-uninstalled binary from
        // Binaries entirely (indistinguishable from never having asked) instead of reporting
        // "Not Found" - worth surfacing, since it means something a config points at isn't
        // actually on this machine.
        { json: true, showNotFound: true },
      ),
    );
  }

  export function getRepositoryInfo(repository: Repository): SystemInfo.RepositoryInfo {
    return {
      type: repository.monorepo ? 'monorepo' : 'package',
      name: repository.rootPackage.name,
      version: repository.rootPackage.version,
      root: repository.dirname,
      packageCount: repository.getPackages().length,
    };
  }
}
