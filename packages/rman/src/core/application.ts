import { Logger, type LogLevel } from '../utils/logger.js';
import type { ManifestProvider } from './manifest.js';
import { Registry } from './registry.js';
import type { Repository } from './repository.js';
import type { ServiceFactory, ServiceMap } from './service.js';
import type { Workspace } from './workspace.js';

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
  /** Which technology claims a directory - asked of every contributor until one answers, because
   *  before a package is read there is nothing else to go on. */
  readonly manifestProviders = new Registry<ManifestProvider>();

  /** How a repository's packages are laid out. Also "first that answers" today; a polyglot
   *  repository wants the union, which is what moving these onto `TechStack` opens up. */
  readonly workspaceProviders = new Registry<Workspace.Provider>();

  readonly logger: Logger;

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

  /** Called once by `Repository.create`, after the plugins that find the packages have run. */
  attachRepository(repository: Repository): void {
    if (this._repository) throw new Error('This application already has a repository');
    this._repository = repository;
  }

  private _repository?: Repository;
  private readonly services = new Map<string, unknown>();
  private readonly factories = new Map<string, ServiceFactory<unknown>>();
}
