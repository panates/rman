import type { VersionPlanService } from '../services/version-plan.service.js';
import { Logger, type LogLevel } from '../utils/logger.js';
import { registerCoreServices } from './core-services.js';
import { registerCoreTargets } from './core-targets.js';
import { basePlugin, type Plugin } from './plugin.js';
import type { PublishTarget } from './publish-target.js';
import { Registry } from './registry.js';
import type { Repository } from './repository.js';
import type { ServiceFactory, ServiceMap } from './service.js';

/**
 * **One rman invocation, and everything it holds.** Created before anything else, handed to every
 * plugin's `init`, and the owner of every registry and service that used to be a module-level
 * variable.
 *
 * The point is that nothing is process-global any more. `Manifest`, `Workspace`, `BinPath`,
 * `RunService` and `VersionPlanService` each kept their contributions in a module-scope array, so
 * two repositories in one process shared them - which the test suite could only survive with a
 * root hook emptying five of them before every test, and the failure that hook prevented was:
 * whichever spec ran first decided the answer for the rest, and the core appeared to work in tests
 * that had registered nothing. An application starts empty and is thrown away whole, so the hook
 * is gone.
 */
export class RmanApplication {
  /**
   * The technologies this invocation knows about, in `plugins` declaration order.
   *
   * One registry rather than the four it replaces (`manifest`, `workspace`, `binPaths`,
   * `runSteps`): a technology is a whole, and declaring part of one was never meaningful - see
   * `Plugin`.
   */
  readonly plugins = new Registry<Plugin>();

  /**
   * Where a package's artifact can ship, in registration order.
   *
   * A registry rather than a field because the answer is a *sum*: a package may ship to npm and
   * Docker Hub at once, and `publish` runs every target a package declares. The core contributes
   * `docker` (nobody's ecosystem), `rman-node` contributes `npm`, and a plugin for any other
   * technology adds its own without either of them changing - see `PublishTarget`.
   */
  readonly publishTargets = new Registry<PublishTarget>();

  /**
   * **The planner that orchestrates a run**, not the one that answers for each package.
   *
   * One answer, not a sum - so a field rather than a registry, and last registration wins. What it
   * decides is the shape of the whole plan: groups, the commit→size reading, the cross-group ripple
   * and the root's release identity, none of which belongs to any one technology.
   *
   * The two decisions that *are* a technology's - `detectBoundary` and `cascade` - are asked of
   * each package's own `Plugin.versionPlanner` instead (`VersionPlanService.plannerFor`), so a
   * polyglot repository no longer resolves both through whichever plugin registered last.
   */
  versionPlanner?: VersionPlanService;

  readonly logger: Logger;

  /** Which plugin claims a directory - the first whose manifest provider recognizes it, because
   *  before a package is read there is nothing else to go on. `basePlugin` when none does, so the
   *  caller needs no guard. */
  pluginFor(dir: string): Plugin {
    return this.plugins.first(plugin => (plugin.manifestProvider.read(dir) ? plugin : undefined)) ?? basePlugin;
  }

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
    registerCoreTargets(this);
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
   * **One application, one repository**, and a second is refused. It was briefly "last one wins",
   * because a single shared application made two repositories in one test collide; each
   * `Repository.create` makes its own now, so the rule holds again and nothing in a process is
   * shared by accident.
   */
  attachRepository(repository: Repository): void {
    if (this._repository) throw new Error('This application already has a repository');
    this._repository = repository;
  }

  private _repository?: Repository;
  private readonly services = new Map<string, unknown>();
  private readonly factories = new Map<string, ServiceFactory<unknown>>();
}
