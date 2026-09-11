import path from 'path';
import type { Repository } from '../core/repository.js';

export namespace ListService {
  export interface Options {
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
  }

  /** `list`: every package in the repository (or, with `changed`/`changedSince`, only the ones
   *  that have actually changed), each with its version, location, private flag, and change
   *  status relative to upstream. Pure data - no console output; `rman list`'s own command
   *  decides how to present it (table, JSON, parseable, names only, or a dependency graph). */
  export async function getPackages(repository: Repository, options: Options = {}): Promise<Item[]> {
    const packages = repository.getPackages({ toposort: options.toposort });
    const status = await repository.listStatus({ hash: options.changedSince });

    let items: Item[] = packages.map(p => ({
      name: p.name,
      version: p.version,
      location: path.relative(repository.dirname, p.dirname) || '.',
      private: p.isPrivate,
      status: status[p.name],
      dependencies: [...p.dependencies],
    }));

    if (options.changed || options.changedSince) items = items.filter(it => it.status !== 'clean');
    return items;
  }
}
