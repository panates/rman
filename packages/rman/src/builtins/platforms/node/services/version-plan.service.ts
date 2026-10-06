import type { Package } from '../../../../core/classes/package.js';
import { ChangeHashService } from '../../../../services/change-hash.service.js';
import { VersionPlanService } from '../../../../services/version-plan.service.js';
import type { GitHelper } from '../../../../utils/git.js';
/**
 * How a release is planned for an npm repository.
 *
 * rman's core holds the parts that are true of any repository - groups, conventional-commit
 * severities, the cascade mechanics, the monorepo root's release identity - and leaves two decisions
 * abstract because they are statements about an *ecosystem* rather than about releases. This is
 * npm's pair of answers.
 *
 * Registered through the plugin's `versionPlanner`, so `rman version` works in a
 * repository that registered the `node` built-in and say what is missing in one that did not.
 */
export class NodeVersionPlanService extends VersionPlanService {
  /**
   * The shared `ChangeHashService.detect`, unmodified: this package's own latest release tag, and failing
   * that whatever `Plugin.publishedVersion` reports, mapped back onto a tag name.
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
   * - **patch** - the changed packages **and** every transitive in-group dependent.
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
  /* **`patch` answered `'changed'` until 2.4, on reasoning that is correct and too narrow.** The
   * range argument holds: `^1.2.0` resolves to `1.2.1`, so a consumer receives the fix with no
   * dependent republished, and the floor a dependent declares stays true. What it leaves out is
   * that a dependent's *published artifact* was built against the old code - anything that bundles,
   * vendors, or type-checks against its dependency ships the pre-fix version until it is released
   * again, and under this default nothing ever released it.
   *
   * So the two answers differ in which failure they prefer, and the cheaper one is now the default:
   * releasing a dependent that strictly did not need it is visible churn, while not releasing one
   * that did is invisible - the same asymmetry `cascade`'s own doc states and `cascadeFor` already
   * resolves by taking the widest.
   *
   * **`patch` and `minor` are now the same answer, and that is a real loss of resolution**, not a
   * tidy-up: the table no longer distinguishes them, so a future reason to treat a patch
   * differently has nowhere to live. It is kept as two entries rather than collapsed for exactly
   * that reason.
   *
   * **It also makes `'changed'` unreachable under npm.** Nothing here returns it any more, and a
   * repository writing `version.cascade: changed` gets no narrowing, because that key is a floor
   * and never a ceiling. The value stays meaningful - it says "no floor of my own", which is what
   * an ecosystem answering `'changed'` would still honour - but in a Node repository it is a no-op.
   *
   * A repository wanting the whole group on a patch writes `version.cascade: group`; one wanting
   * the old narrow behaviour cannot ask for it, and has to say so if that turns out to matter. */
  protected cascade(bump: string): VersionPlanService.Cascade {
    /** Only semver's three can arrive - `getPlan` validates against `bumpNames` and
     *  `packageJsonManifest` leaves the scheme at the semver default. The fallback is for a scheme
     *  someone swaps in underneath this planner, and it over-reaches on purpose: releasing a package
     *  that did not need it is noise, while under-reaching ships a dependent whose published range
     *  floor is wrong, which is a broken install. */
    return CASCADE_BY_BUMP[bump] ?? 'group';
  }
}

/** semver's bump names against how far each has to reach - see `NodeVersionPlanService.cascade`. */
const CASCADE_BY_BUMP: Record<string, VersionPlanService.Cascade> = {
  patch: 'dependents',
  minor: 'dependents',
  major: 'group',
};
