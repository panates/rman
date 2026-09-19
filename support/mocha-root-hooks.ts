import { RmanApplication } from '../packages/rman/src/core/application.js';

/**
 * A fresh application before every case.
 *
 * This used to be five `clear*()` calls - `Manifest`, `Workspace`, `RunService`, `BinPath` and
 * `VersionPlanService` each kept their contributions in a module-scope array, so two repositories
 * in one process shared them. Without the clearing, whichever spec registered first decided the
 * answer for every later one: `Manifest.read` takes the first provider that recognizes a directory,
 * so `rman-node`'s answered for core specs that had registered nothing, and the core *appeared* to
 * work in tests that never set it up.
 *
 * One line now, and it is a different statement: not "empty the five things I remembered to list"
 * but "nothing from the last case survives". A registry added later is covered without anyone
 * having to come back here.
 */
export const mochaHooks = {
  beforeEach(): void {
    RmanApplication.reset();
  },
};
