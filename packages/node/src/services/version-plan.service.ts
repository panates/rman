import { ChangeHashService, type GitHelper, type Package, VersionPlanService } from 'rman';

/**
 * How a release is planned for an npm repository.
 *
 * rman's core holds the parts that are true of any repository - groups, conventional-commit
 * severities, the cascade mechanics, the monorepo root's release identity - and leaves two decisions
 * abstract because they are statements about an *ecosystem* rather than about releases. This is
 * npm's pair of answers.
 *
 * Registered through the plugin's `versionPlanner`, so `rman version`/`rman changed` work in a
 * repository that names `rman-node` and say what is missing in one that does not.
 */
export class NodeVersionPlanService extends VersionPlanService {
  /**
   * The shared `ChangeHashService.detect`, unmodified: this package's own latest release tag, and failing
   * that whatever `ManifestProvider.publishedVersion` reports, mapped back onto a tag name.
   *
   * **Nothing npm-specific is passed in any more**, and that is the point of the seam moving: the
   * registry lookup is `packageJsonManifest.publishedVersion`'s now, dispatched per package, so this
   * override exists only because `detectBoundary` is abstract. If the core ever makes it a concrete
   * default, this method can go entirely.
   */
  protected detectBoundary(git: GitHelper, pkg: Package): Promise<string | undefined> {
    return ChangeHashService.detect(git, pkg);
  }

  /**
   * npm's dependency ranges, read as a release policy. What decides each case is whether a
   * dependent's **range floor** has to move for a consumer to get a correct install:
   *
   * - **patch** - only the changed packages. A dependent's `^1.2.0` already resolves to `1.2.1`,
   *   and a patch adds nothing for the dependent to require, so nothing downstream has to ship for
   *   consumers to receive it.
   * - **minor** - also every transitive in-group dependent. A minor adds API; a dependent that uses
   *   it is only correct once its own published range requires the new floor, and a range lives in
   *   a manifest, which only a release puts on the registry.
   * - **major** - the whole group, changed or not. A breaking change restates every member's
   *   compatibility, including the members that merely point at one.
   *
   * None of this is about versions, which is why it is not in the core: an ecosystem that pins exact
   * versions instead has to release every dependent for a patch as well, and one that resolves
   * dependencies from source may not need a release for any of it.
   */
  protected cascade(bump: string): VersionPlanService.Cascade {
    /** Only semver's three can arrive - `getPlan` validates against `bumpNames` and
     *  `packageJsonManifest` leaves the scheme at the semver default. The fallback is for a scheme
     *  someone swaps in underneath this planner, and it over-reaches on purpose: releasing a package
     *  that did not need it is noise, while under-reaching ships a dependent whose published range
     *  floor is wrong, which is a broken install. */
    return CASCADE_BY_BUMP[bump] ?? 'group';
  }
}

/** The instance the plugin registers. One is enough: a planner holds no per-run state, and a test
 *  wanting a different registry answer registers its own `ManifestProvider` instead - which
 *  exercises the real path rather than a bypass. */
export const nodeVersionPlanner = new NodeVersionPlanService();

/** semver's bump names against how far each has to reach - see `NodeVersionPlanService.cascade`. */
const CASCADE_BY_BUMP: Record<string, VersionPlanService.Cascade> = {
  patch: 'changed',
  minor: 'dependents',
  major: 'group',
};
