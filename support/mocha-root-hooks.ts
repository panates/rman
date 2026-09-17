import { BinPath, Manifest, RunService, VersionPlanService, Workspace } from '../packages/rman/src/index.js';

/**
 * Empties every plugin registry before each test.
 *
 * **Mocha runs every package's specs in one process**, and the registries are module-global by
 * design (a repository names its plugins once, at startup). Without this, whichever spec ran first
 * decides the answer for the ones after it: `Manifest.read` takes the *first* provider that
 * recognizes a directory, so `@rman/node`'s `package.json` provider - registered the moment one of
 * its specs calls `runCli` - would answer for rman's core specs too, and the core would appear to
 * work in tests that never registered anything.
 *
 * Clearing rather than isolating processes because it is exactly what the `clear*` members exist
 * for, and because each spec then declares its own ecosystem explicitly: rman's core specs through
 * `useTestEcosystem()`, `@rman/node`'s through `declarePlugin()` and a real `plugins` load.
 */
export const mochaHooks = {
  beforeEach(): void {
    Manifest.clearProviders();
    Workspace.clearProviders();
    RunService.clearStepSources();
    BinPath.clearProviders();
    VersionPlanService.clearPlanner();
  },
};
