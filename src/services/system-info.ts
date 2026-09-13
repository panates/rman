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

  /** Whatever `envinfo` reports (OS/CPU/Memory/Shell, Node + the resolved package manager, git,
   *  installed rman/typescript versions), grouped by category - shape is `envinfo`'s own, not ours. */
  export type SystemInfo = Record<string, Record<string, unknown>>;

  /** `.rmanrc "packageManager"` value -> the `Binaries` key `envinfo` recognizes for it (`npm`/
   *  `pnpm`/`bun` are lowercase, `Yarn` isn't - envinfo's own naming, not ours). */
  const PACKAGE_MANAGER_BINARY: Record<'npm' | 'yarn' | 'pnpm' | 'bun', string> = {
    npm: 'npm',
    yarn: 'Yarn',
    pnpm: 'pnpm',
    bun: 'bun',
  };

  /**
   * `packageManager` (the repository's resolved `.rmanrc "packageManager"`, default `'npm'`)
   * decides which package manager's version actually gets queried/reported - a pnpm-configured
   * repo has no real use for npm's own version, since every package-manager-aware command
   * (`ci`/`publish`) already shells out to pnpm, not npm, for it.
   */
  export async function getSystemInfo(
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun',
    options?: envinfo.RunConfig,
  ): Promise<SystemInfo.SystemInfo> {
    return JSON.parse(
      await envinfo.run(
        {
          System: ['OS', 'CPU', 'Memory', 'Shell'],
          Binaries: ['Node', PACKAGE_MANAGER_BINARY[packageManager ?? 'npm']],
          Utilities: ['Git'],
          npmPackages: ['rman', 'typescript'],
          npmGlobalPackages: ['typescript'],
          ...options,
        },
        // showNotFound: without it, envinfo *omits* a configured-but-uninstalled package manager
        // from Binaries entirely (indistinguishable from never having asked) instead of reporting
        // "Not Found" - worth surfacing, since it means .rmanrc "packageManager" points at
        // something that isn't actually on this machine.
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
