import path from 'path';
import type { RmanConfig } from '../core/config.js';
import type { Repository } from '../core/repository.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';

export namespace ListService {
  export interface Options extends PackageFilterOptions {
    /** Topological order (dependencies before dependents) instead of lexical by directory. */
    toposort?: boolean;
    /** Only include packages that have changed since the last publish (dirty or committed but
     *  not yet published) - or, with `changedSince`, since that specific commit/hash. */
    changed?: boolean;
    changedSince?: string;
  }

  export interface Item {
    name: string;
    version: string;
    location: string;
    private: boolean;
    status: Repository.PackageStatus;
    /** In-repo package names this one depends on - enough to build a dependency graph without a
     *  second call, e.g. `Object.fromEntries(items.map(i => [i.name, i.dependencies]))`. */
    dependencies: string[];
    /** This package's own (cascaded) `.rmanrc "publish.target"` - `["npm"]` when unset, same
     *  default `publish` itself uses. */
    publishTargets: RmanConfig.PublishTarget[];
    /** Present only when `"docker"` is one of `publishTargets` and `publish.docker` is configured -
     *  the raw `.rmanrc` config, unresolved (no namespace prefixing - see `DockerPublishService`). */
    docker?: RmanConfig.DockerPublishOptions;
  }

  /** `list`: every package in the repository (or, with `changed`/`changedSince`, only the ones
   *  that have actually changed), each with its version, location, private flag, and change
   *  status relative to upstream. Pure data - no console output; `rman list`'s own command
   *  decides how to present it (table, JSON, parseable, names only, or a dependency graph). */
  export async function getPackages(repository: Repository, options: Options = {}): Promise<Item[]> {
    const packages = filterPackages(repository.getPackages({ toposort: options.toposort }), options);
    const status = await repository.listStatus({ hash: options.changedSince });

    let items: Item[] = packages.map(p => {
      const target = p.config.publish?.target;
      const publishTargets: RmanConfig.PublishTarget[] = Array.isArray(target) ? target : target ? [target] : ['npm'];
      return {
        name: p.name,
        version: p.version,
        location: path.relative(repository.dirname, p.dirname) || '.',
        private: p.isPrivate,
        status: status[p.name],
        dependencies: [...p.dependencies],
        publishTargets: [...publishTargets],
        docker: publishTargets.includes('docker') ? p.config.publish?.docker : undefined,
      };
    });

    if (options.changed || options.changedSince) items = items.filter(it => it.status !== 'clean');
    return items;
  }
}
