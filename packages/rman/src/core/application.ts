import type { VersionPlanService } from '../services/version-plan.service.js';
import { Logger, type LogLevel } from '../utils/logger.js';
import { registerCoreServices } from './core-services.js';
import { Registry } from './registry.js';
import type { Repository } from './repository.js';
import type { ServiceFactory, ServiceMap } from './service.js';
import { baseTechStack, type TechStack } from './tech-stack.js';

/**
 * **One rman invocation, and everything it holds.** Created before anything else, handed to every
 * plugin's `init`, and the owner of every registry and service that used to be a module-level
 * variable.
 *
 * The point is that nothing is process-global any more. `Manifest`, `Workspace`, `BinPath`,
 * `RunService` and `VersionPlanService` each kept their contributions in a module-scope array, so
 * two repositories in one process shared them - `support/mocha-root-hooks.ts` exists solely to
 * empty five of them before every test, and CLAUDE.md records the failure it prevents: whichever
 * spec ran first decided the answer for the rest, and the core appeared to work in tests that had
 * registered nothing. An application starts empty and is thrown away whole.
 */
export class RmanApplication {
  /**
   * The technologies this invocation knows about, in `plugins` declaration order.
   *
   * One registry rather than the four it replaces (`manifest`, `workspace`, `binPaths`,
   * `runSteps`): a technology is a whole, and declaring part of one was never meaningful - see
   * `TechStack`.
   */
  readonly techStacks = new Registry<TechStack>();

  /** One answer, not a sum - so a field rather than a registry, and last registration wins. */
  versionPlanner?: VersionPlanService;

  readonly logger: Logger;

  /** Which stack claims a directory - the first whose manifest provider recognizes it, because
   *  before a package is read there is nothing else to go on. */
  techStackFor(dir: string): TechStack {
    return this.techStacks.first(stack => (stack.manifestProvider.read(dir) ? stack : undefined)) ?? baseTechStack;
  }

  /**
   * The application this invocation is using, created on demand.
   *
   * **A single slot, and deliberately not the end state.** The registries it replaces were arrays
   * that *accumulated*, which is what made one spec decide the answer for the next; one reference
   * that is swapped whole has no such failure. It is here so the storage could move without
   * rewriting 312 `Repository.create(dir)` call sites in the same change, and it goes away as those
   * take an application explicitly.
   */
  static current(): RmanApplication {
    return (RmanApplication._current ??= new RmanApplication());
  }

  /** Starts a fresh application - what a test does between cases, and what `runCli` does per run. */
  static reset(app: RmanApplication = new RmanApplication()): RmanApplication {
    RmanApplication._current = app;
    return app;
  }

  private static _current?: RmanApplication;

  /**
   * **Not a constructor field, and that is forced by the order things happen in.** Plugins are what
   * *find* the packages - `Repository.create` loads them before it calls `Workspace.resolve` - so
   * the application has to exist, and be handed to every `init`, while there is still no
   * repository to put in it.
   *
   * A throwing getter rather than `undefined`: a plugin reaching for packages during `init` has
   * made a real mistake, and `undefined` would let it write a check that silently does nothing.
   */
  get repository(): Repository {
    if (!this._repository) {
      throw new Error(
        'The repository is not available yet - plugins are loaded before the packages they are ' +
          "what finds. Ask for it from a command or a service, not from a plugin's init().",
      );
    }
    return this._repository;
  }

  /** `info` until `--log-level` or `.rmanrc "logLevel"` is resolved - which cannot happen here,
   *  since reading the config is itself work the application does. */
  constructor(options?: { logLevel?: LogLevel }) {
    this.logger = new Logger(options?.logLevel ?? 'info');
    registerCoreServices(this);
  }

  /**
   * The single instance of a service, built on first use.
   *
   * **Lazy, and for two reasons.** `rman info` has no business constructing the changelog, version
   * and release services, which is the same laziness the config scope's `git` getter was measured
   * to need (0 git reads with property descriptors, 1 with a spread). And services call each other -
   * `VersionService` reaches for `RunService` and `ChangelogService`, which reaches for
   * `ChangeHashService` - so resolving at call time is what keeps that from being a construction
   * cycle.
   */
  getService<K extends keyof ServiceMap>(name: K): ServiceMap[K] {
    const existing = this.services.get(name as string);
    if (existing) return existing as ServiceMap[K];

    const factory = this.factories.get(name as string);
    if (!factory) throw new Error(`No service registered under "${String(name)}"`);
    const service = factory(this);
    this.services.set(name as string, service);
    return service as ServiceMap[K];
  }

  /**
   * Registers how a service is built. A plugin replacing one of the core's - a version planner that
   * knows its own ecosystem's dependency ranges - does it here, which is why that no longer needs a
   * seam of its own on the plugin interface.
   *
   * Refused once the service has been built: something is already holding the old instance, and
   * swapping the factory then would leave two answers to one question in play.
   */
  setService<K extends keyof ServiceMap>(name: K, factory: ServiceFactory<ServiceMap[K]>): void {
    if (this.services.has(name as string)) {
      throw new Error(`Service "${String(name)}" has already been built and cannot be replaced`);
    }
    this.factories.set(name as string, factory as ServiceFactory<unknown>);
  }

  /**
   * Called by `Repository.create`, after the plugins that find the packages have run.
   *
   * **Last one wins, which is a consequence of `current()` being shared and not of the design.**
   * One invocation means one application and one repository, and this refused a second - but a spec
   * that builds two repositories in a single test is using one application for both, so the rule
   * fired on ordinary use. It comes back as a refusal once call sites take an application
   * explicitly, which is the same change that removes `current()`.
   */
  attachRepository(repository: Repository): void {
    this._repository = repository;
  }

  private _repository?: Repository;
  private readonly services = new Map<string, unknown>();
  private readonly factories = new Map<string, ServiceFactory<unknown>>();
}
