import path from 'path';
import type { DockerPublishOptions } from '../builtins/publish-targets/docker/docker.target.js';
import type { Package } from '../core/classes/package.js';
import type { Repository } from '../core/classes/repository.js';
import { Service } from '../core/classes/service.js';
import { type PublishTargetName, skipReasonFor, targetsOf } from '../core/interfaces/publish-target.js';
import { filterPackages, type PackageFilterOptions } from '../utils/package-filter.js';
import { groupKeyOf, isNamedGroupKey, isSoloGroupKey, ROOT_GROUP_KEY } from '../utils/version-group.js';

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
    const status = await repository.listStatus({ hash: options.changedSince, includeRoot: options.includeRoot });

    const item = (p: Package): ListService.Item => {
      /** **Asked, not assumed.** This read the config key directly and defaulted to `['npm']`, so a
       *  Cargo package in a polyglot repository was reported as shipping to npm - which is what
       *  `PublishTarget.claims` exists to answer, per target, from the ecosystem that knows. */
      /** **A monorepo's root ships nowhere**: `publish` never makes it a candidate
       *  (`repository.getPackages()` leaves it out), so listing the target a root *would* claim
       *  says something no command does. */
      const monorepoRoot = p === repository.rootPackage && repository.monorepo;
      const targets = monorepoRoot ? [] : targetsOf(this.app, p);
      /** The root's own key, as in `version`'s plan: a monorepo's root is never a group member - its
       *  number is the repository's identity. */
      const groupKey = monorepoRoot ? ROOT_GROUP_KEY : groupKeyOf(p);
      const publishTargets = targets.map(t => t.name);
      const skippedTargets: Record<string, string> = {};
      const targetLabels: Record<string, string> = {};
      for (const target of targets) {
        const reason = skipReasonFor(p, target);
        if (reason) skippedTargets[target.name] = reason;
        const label = target.labelFor?.(p);
        if (label && label !== target.name) targetLabels[target.name] = label;
      }
      return {
        name: p.name,
        selector: p.selector,
        version: p.version,
        platform: p.provider,
        depth: depthOf(p),
        groupKey,
        group: groupNameOf(groupKey),
        isRoot: p === repository.rootPackage,
        location: path.relative(repository.dirname, p.dirname) || '.',
        private: p.isPrivate,
        status: status[p.selector]!,
        dependencies: p.dependencies.map(d => d.name),
        publishTargets: [...publishTargets],
        skippedTargets,
        targetLabels,
        docker: publishTargets.includes('docker') ? p.config.publish?.docker : undefined,
      };
    };

    let items: ListService.Item[] = packages.map(item);

    if (options.changed || options.changedSince) items = items.filter(it => it.status !== 'clean');
    /**
     * **The root goes on the front, after filtering, and is never filtered out.** It is the tree's
     * own row - what the members' indentation hangs from - so a `--scope` that narrows the members
     * still leaves it standing rather than removing the thing they are nested under. A glob never
     * matches the root anyway (`ROOT_SELECTOR`), so there is no filter here to respect.
     *
     * Not in a single-package repository, where `repository.packages` already *is* `[rootPackage]`
     * and it would appear twice.
     */
    if (options.includeRoot && repository.monorepo) items.unshift(item(repository.rootPackage));
    return items;
  }
}

export namespace ListService {
  export interface Options extends PackageFilterOptions {
    /** Topological order (dependencies before dependents) instead of lexical by directory. */
    toposort?: boolean;
    /**
     * Also report the **root package**, first, as the row the members' `depth` is measured from.
     *
     * Opt-in rather than always, because it changes what the answer *is*: `repository.packages` is
     * the workspace members, so every other reader of this list - and the count `rman list` prints -
     * is about them. `rman list`'s table asks for it because a tree needs a root to hang from; its
     * `--json`, `--parseable` and `--short` forms do not, and a consumer parsing them sees exactly
     * what it saw before.
     */
    includeRoot?: boolean;
    /** Only include packages the developer has touched but not pushed (dirty, or committed and not
     *  yet on the upstream branch) - or, with `changedSince`, since that specific commit/hash.
     *  **Question C, never a release question**: after a push `git cherry` is empty and everything
     *  reads `clean`, which does not mean there is nothing left to release. */
    changed?: boolean;
    changedSince?: string;
  }

  export interface Item {
    name: string;
    /** What addresses this package - `"[glob]"` and `--scope` match it. The same as `name` wherever
     *  the technology names its packages, which is every Node repository; see `Package.selector`. */
    selector: string;
    version: string;
    /** The technology that claimed this package's directory - `Package.provider`. Empty when none
     *  did, which is a repository naming no plugin. */
    platform: string;
    /**
     * How far below the **root package** this one sits: `0` for the root itself, `1` for an ordinary
     * member, more for a package nested inside another.
     *
     * A fact about the package rather than about this list's order, so it is still right under
     * `--toposort` - which reorders the rows and leaves the nesting where it is.
     */
    depth: number;
    /**
     * Which release group the package versions with - `.rmanrc group`, the key `version` batches its
     * plan by: `default` for the implicit repo-wide group, `named:<name>` for a named one,
     * `solo:<package>` for `group: false`, and `__root__` for a monorepo's root, which belongs to
     * none. The same spelling `version --json` reports.
     */
    groupKey: string;
    /** `groupKey`'s name - the group's own name, `default`, the package's for a solo one, `root`. */
    group: string;
    /** Whether this row *is* the root package - present only when `includeRoot` asked for it, or in
     *  a single-package repository where the root is the one member. */
    isRoot: boolean;
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
    /** The entries of `publishTargets` that `publish` would leave this package alone for, each with
     *  why - `.rmanrc "publish.skip"`, or the target's own rule (npm's `private`). Decided without the
     *  registry, so `{}` means "a candidate", not "will publish": whether the version is already out
     *  there is `publish --dry-run`'s answer. */
    skippedTargets: Record<PublishTargetName, string>;
    /** What the table shows in place of a target's name, where the target says more for this
     *  package - npm's registry host when `publishConfig.registry` names one other than npm's own
     *  (`{ npm: 'npm.pkg.github.com' }`). A label only: `publishTargets` and `--target` keep the name. */
    targetLabels: Record<PublishTargetName, string>;
    /** Present only when `"docker"` is one of `publishTargets` and `publish.docker` is configured -
     *  the raw `.rmanrc` config, unresolved (no namespace prefixing - see `DockerPublishService`). */
    docker?: DockerPublishOptions;
  }
}

declare module '../core/classes/service.js' {
  interface ServiceMap {
    list: ListService;
  }
}

/**
 * How far below the root `pkg` sits, by walking `parent` - `0` for the root itself.
 *
 * From the tree edge rather than by counting path segments, which would be a different number: a
 * package in `packages/a` is two directories down and one *package* down, and it is the second that
 * the indentation is about.
 */
function depthOf(pkg: Package): number {
  let depth = 0;
  for (let at = pkg.parent; at; at = at.parent) depth++;
  return depth;
}

/** The name behind a group key - the same reading `VersionPlanService.groupLabel` makes. */
function groupNameOf(key: string): string {
  if (key === ROOT_GROUP_KEY) return 'root';
  if (isNamedGroupKey(key)) return key.slice('named:'.length);
  if (isSoloGroupKey(key)) return key.slice('solo:'.length);
  return key;
}
