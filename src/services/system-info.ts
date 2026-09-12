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

  /** Whatever `envinfo` reports (OS/CPU/Memory/Shell, Node/Yarn/npm, git, installed
   *  rman/typescript versions), grouped by category - shape is `envinfo`'s own, not ours. */
  export type SystemInfo = Record<string, Record<string, unknown>>;

  export async function getSystemInfo(options?: envinfo.RunConfig): Promise<SystemInfo.SystemInfo> {
    return JSON.parse(
      await envinfo.run(
        {
          System: ['OS', 'CPU', 'Memory', 'Shell'],
          Binaries: ['Node', 'Yarn', 'npm'],
          Utilities: ['Git'],
          npmPackages: ['rman', 'typescript'],
          npmGlobalPackages: ['typescript'],
          ...options,
        },
        { json: true },
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
