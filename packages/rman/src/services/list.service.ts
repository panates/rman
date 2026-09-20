import path from 'path';
import { type PublishTargetName, targetsOf } from '../core/publish-target.js';
import type { Repository } from '../core/repository.js';
import { Service } from '../core/service.js';
import type { DockerPublishOptions } from '../targets/docker.target.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';

/**
 * **A class, and the shape every service follows now.**
 *
 * `repository` is gone from the signature - it comes from the application, which is what always
 * made the parameter redundant: every caller had one and passed it, and no caller ever had two.
 * What a namespace could not do is hold state without holding it *globally*, be subclassed, or be
 * stubbed without mutating the module; `Service` records the three measured consequences.
 *
 * **Declared before the namespace below, which is not style.** A namespace merges *into* a class
 * only when the class comes first - the other order is
 * `Cannot use namespace 'ListService' as a type`. Merged, `ListService.Options` and
 * `ListService.Item` still read exactly as they did, so nothing importing a type had to change.
 */
export class ListService extends Service {
  /**
   * `list`: every package in the repository (or, with `changed`/`changedSince`, only the ones that
   * have actually changed), each with its version, location, private flag, and change status
   * relative to upstream. Pure data - no console output; `rman list`'s own command decides how to
   * present it (table, JSON, parseable, names only, or a dependency graph).
   */
  async getPackages(options: ListService.Options = {}): Promise<ListService.Item[]> {
    const repository = this.repository;
    /** `false`: `list` is the inventory, so a package its own `.rmanrc "skip"` excludes is still
     *  *in* the repository and still listed - hiding it would answer a different question. Every
     *  other caller honours it, being a command that acts rather than reports. */
    const packages = filterPackages(repository.getPackages({ toposort: options.toposort }), options, false);
    const status = await repository.listStatus({ hash: options.changedSince });

    let items: ListService.Item[] = packages.map(p => {
      /** **Asked, not assumed.** This read the config key directly and defaulted to `['npm']`, so a
       *  Cargo package in a polyglot repository was reported as shipping to npm - which is what
       *  `PublishTarget.claims` exists to answer, per target, from the ecosystem that knows. */
      const publishTargets = targetsOf(this.app, p).map(t => t.name);
      return {
        name: p.name,
        version: p.version,
        location: path.relative(repository.dirname, p.dirname) || '.',
        private: p.isPrivate,
        status: status[p.name],
        dependencies: p.dependencies.map(d => d.name),
        publishTargets: [...publishTargets],
        docker: publishTargets.includes('docker') ? p.config.publish?.docker : undefined,
      };
    });

    if (options.changed || options.changedSince) items = items.filter(it => it.status !== 'clean');
    return items;
  }
}

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
    /** Where this package actually ships - its own (cascaded) `.rmanrc "publish.target"` when it
     *  declares one, otherwise every registered target that claims it, which is the same question
     *  `publish` asks. Empty in a repository whose plugins contribute no target the package fits. */
    publishTargets: PublishTargetName[];
    /** Present only when `"docker"` is one of `publishTargets` and `publish.docker` is configured -
     *  the raw `.rmanrc` config, unresolved (no namespace prefixing - see `DockerPublishService`). */
    docker?: DockerPublishOptions;
  }
}

declare module '../core/service.js' {
  interface ServiceMap {
    list: ListService;
  }
}
