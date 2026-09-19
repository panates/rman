import type { RunService } from '../services/run.service.js';
import type { VersionPlanService } from '../services/version-plan.service.js';
import type { BinPath } from '../utils/bin-path.js';
import type { Manifest, ManifestProvider } from './manifest.js';
import type { Workspace } from './workspace.js';

/**
 * **One technology, as a whole.** Node, Cargo, Maven - everything rman needs to know in order to
 * treat a directory as a package of that technology.
 *
 * These were six independent fields on `RmanPlugin`, each with its own registry, and declaring one
 * without the others type-checked. It is not a shape that admits sense: `packageJsonSteps`' first
 * line is `pkg.manifest.raw?.scripts`, so contributing npm's step source without npm's manifest
 * reader leaves it parsing whatever another technology produced. The coupling was already real;
 * only the type failed to say so.
 *
 * **`manifestProvider` is the required one**, and that is the constraint the old shape could not
 * express: a stack that cannot recognize a package has nothing to apply the rest of itself to.
 *
 * Named after the type each one holds (`ManifestProvider`, `Workspace.Provider`,
 * `BinPath.Provider`), which is why `runSteps` and `versionPlanner` carry no `Provider` suffix -
 * neither of their types has one. `manifestProvider` rather than `manifest` also keeps it clear of
 * `Package.manifest`, which is a `Manifest` - the data, not the reader.
 */
export interface TechStack {
  /** What `${{ pkg.techStack.name }}` reads and what a `"[*]"` block tests to address a single
   *  technology in a polyglot repository - `'node'`, `'cargo'`. Empty for the base stack. */
  name: string;
  manifestProvider: ManifestProvider;
  workspaceProvider?: Workspace.Provider;
  binPathsProvider?: BinPath.Provider;
  runSteps?: RunService.StepSource;
  versionPlanner?: VersionPlanService;
}

/**
 * The stack a package gets when **no** technology claimed its directory - a repository naming no
 * plugin, or a directory none of the named ones recognized.
 *
 * It exists so `Package.techStack` need not be optional. `Package.provider` was an empty string for
 * exactly this case, and every reader had to know that; an object with an empty `name` says the
 * same thing without a guard, and `pkg.techStack.name === 'node'` - the check CLAUDE.md already
 * prescribes - reads the same either way.
 *
 * **Every documented behaviour of "no plugin" survives unchanged**, because the absences are the
 * behaviour:
 *
 * - no `workspaceProvider` -> a repository naming no plugin has no packages beyond itself, which is
 *   the boundary working rather than failing (`workspaces` in a `package.json` is npm's idea);
 * - no `binPathsProvider` -> nothing is prepended to a child process's PATH, so the inherited one
 *   stands on its own rather than being guessed at;
 * - no `runSteps` -> a package's steps come from its `.rmanrc` alone, the core's only source;
 * - no `versionPlanner` -> `version`/`changed` fail naming the key, rather than releasing a
 *   plausible but untrue set of packages from a default nobody chose.
 */
export const baseTechStack: TechStack = {
  name: '',
  manifestProvider: {
    name: '',
    fileName: '',
    /** Recognizes nothing, which is the point: `Manifest.read` falls through to its own empty
     *  manifest exactly as it does today when no provider answers. */
    read: (): Manifest | undefined => undefined,
    write: (): void => undefined,
  },
};
