import type { Logger } from '../utils/logger.js';
import type { RmanApplication } from './application.js';
import type { Repository } from './repository.js';

/**
 * **The one service shape.** Everything that does work on a repository is a class extending this,
 * constructed once per `RmanApplication` and reached through `app.getService(name)`.
 *
 * rman's services were `export namespace` blocks, and the split between those and the two classes
 * (`VersionPlanService`, `VersionScheme`) was historical rather than principled: whatever needed to
 * be *extended* became a class, and the rest stayed a namespace. Three consequences, all of them
 * measured in this repository:
 *
 * - **A namespace that needs state can only have global state.** `RunService` is a namespace and
 *   acquired three module-level variables - `stepSources` and two "already warned" sets - which is
 *   why a warning printed for one repository was suppressed for the next one in the same process.
 * - **A namespace cannot be extended.** The two seams a plugin has to specialize
 *   (`NodeVersionPlanService extends VersionPlanService`) are precisely the two that are classes.
 * - **A namespace has to be stubbed by mutating the module**, and CLAUDE.md records that failing:
 *   a spec that captured a core function at module scope and restored it put the *un-augmented*
 *   version back for the rest of the process and broke a spec two files away. An instance is
 *   rebuilt per application, so a stub dies with it.
 *
 * **`repository` is no longer a parameter.** Nearly every service method took it first; it now
 * comes from the application, which is what made the argument redundant in the first place.
 *
 * Pure functions of their arguments stay plain exported functions rather than becoming services -
 * `ConventionalCommitsService.parseSubject('feat: x')` parses a string and will never hold state,
 * and making it `app.getService('conventionalCommits').parseSubject(...)` would be ceremony that
 * also puts an application between a caller and a parser. The line is whether it needs the
 * repository.
 */
export abstract class Service {
  constructor(protected readonly app: RmanApplication) {}

  protected get repository(): Repository {
    return this.app.repository;
  }

  protected get logger(): Logger {
    return this.app.logger;
  }
}

/**
 * Every service the application can hand out, by name.
 *
 * Declaration-merged, like `RmanConfigKeys`: the core declares its own here, and a plugin adds its
 * own from its own package with `declare module 'rman'`. That is what keeps `getService` typed -
 * a bare `Map<string, Service>` would need a cast at every call and would turn a misspelled name
 * into a runtime failure instead of a compile error.
 */

export interface ServiceMap {}

/** How a service is built when the application first needs it. */
export type ServiceFactory<T> = (app: RmanApplication) => T;
