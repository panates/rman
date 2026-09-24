import { dockerPublishTarget } from '../targets/docker.target.js';
import type { RmanApplication } from './application.js';

/**
 * Every publish target the core brings, registered as an application is built - `registerCoreServices`
 * for the other half of what a fresh application starts with.
 *
 * Exactly one today, and that is the point: `docker` is the target that belongs to no ecosystem, so
 * it is the only one the core can honestly ship. `npm` arrives with the `node` built-in, and a Cargo or
 * Maven target would arrive from its own plugin the same way.
 *
 * A separate file from `core-services.ts` rather than a second call inside it: a target is not a
 * service (it is a contribution summed with others, not one replaceable answer), and a function
 * called `registerCoreServices` that also registered targets would have to be read to be believed.
 */
export function registerCoreTargets(app: RmanApplication): void {
  app.publishTargets.add(dockerPublishTarget);
}
