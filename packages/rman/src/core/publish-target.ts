import type { RmanConfig } from '../interfaces/rman-config.interface.js';
import type { PackageFilterOptions } from '../utils/package-filter.js';
import type { RmanApplication } from './application.js';
import type { Package } from './package.js';
import type { Repository } from './repository.js';

/**
 * **Where a package's artifact ships, as a contribution.**
 *
 * `publish` used to be `rman-node`'s command, and that was backwards in a way worth stating: the
 * command itself is about a *repository* - which packages are candidates, which versions are
 * already out there, what order to push them in, what to print - and none of that is npm's. What is
 * npm's is one answer to "is this version on the registry, and how do I push it", which is exactly
 * the size of this interface. Docker publishing was in the core all along and could only be reached
 * through a Node plugin's command; a Cargo repository could reach neither.
 *
 * So: the core ships `publish` and the `docker` target, the `node` built-in contributes `npm`, and a
 * repository in any other ecosystem contributes its own without either package knowing about it.
 *
 * A target owns three things and no more:
 *
 * - **Which packages are its own by default** (`claims`) - see below.
 * - **Its own CLI options**, merged into `publish`'s by the command. Every flag that only meant
 *   something to npm (`--access`, `--tag`, `--otp`, `--registry`, `--userconfig`, `--contents`,
 *   `--package-manager`) is declared here now instead of on a command the core would otherwise have
 *   to know them all in advance.
 * - **`getPlan`/`applyPlan`** - the same two-step shape every other rman service uses, and the
 *   reason `--dry-run` and the confirmation prompt are the command's business rather than each
 *   target's.
 */
export interface PublishTarget {
  /** The name `publish.target` and `--target` use, and the label printed beside a package. */
  readonly name: string;
  /** One line for `--target`'s help - a reader asking `rman publish --help` in a polyglot
   *  repository has no other way to find out which targets are even installed. */
  readonly describe?: string;
  /**
   * This target's own flags, merged into `publish`'s options.
   *
   * Flat, not namespaced: `--tag` reads better than `--npm-tag`, and two targets colliding on a
   * name is refused loudly by the command rather than resolved by a rule nobody would remember.
   * Name a flag for the target when it genuinely belongs to one (`--docker-namespace`).
   */
  readonly options?: Record<string, RmanConfig.CommandOption>;
  /**
   * Whether a package that declares **no** `publish.target` at all ships here.
   *
   * Absent means never - the target is opt-in, which is what `docker` is. `npm`'s answer is
   * `pkg.provider === 'node'`, and that is the fix for a real bug rather than a nicety: the default
   * used to be a hardcoded `['npm']` in the core, so `rman list --json` reported
   * `publishTargets: ["npm"]` for a Cargo package and `publish` treated it as an npm candidate.
   * A default only the ecosystem can state had been written down by someone who could not know it.
   */
  claims?(pkg: Package): boolean;
  /** What this target *would* do - never publishes. Called even under `--dry-run`, which is the
   *  whole point of the split. */
  getPlan(ctx: PublishTarget.Context): Promise<PublishTarget.Entry[]>;
  /** Publishes every `'publish'` entry in `plan`, and returns what it did. */
  applyPlan(ctx: PublishTarget.Context, plan: PublishTarget.Entry[]): Promise<PublishTarget.Entry[]>;
}

export namespace PublishTarget {
  /**
   * What a target is handed, once per call.
   *
   * `args` is the parsed argv, untyped on purpose: a target declared its own options, so it is the
   * only thing that knows their names and types, and the core cannot be made to know them without
   * becoming the thing this interface exists to stop it being.
   */
  export interface Context {
    readonly app: RmanApplication;
    readonly repository: Repository;
    /** The filters every target shares, read off argv once by the command. */
    readonly options: Options;
    /** The whole parsed argv - a target reads the options it declared out of this. */
    readonly args: Record<string, any>;
  }

  export interface Options extends PackageFilterOptions {
    /** A package with uncommitted local changes is excluded (`'skip'`) instead of aborting the
     *  whole plan (`'error'`). */
    ignoreDirty?: boolean;
  }

  /**
   * One package's outcome for one target.
   *
   * `'skip'` and `'error'` differ in what they do to the run: an error aborts before anything is
   * published, a skip is a package the plan deliberately leaves alone. A target may add fields of
   * its own (docker carries the resolved image reference); `detail` is the one the command prints,
   * so whatever a target wants shown beside a package goes there.
   */
  export interface Entry {
    package: Package;
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    /** Printed after the package name - docker's resolved `<namespace>/<image>`, for instance. */
    detail?: string;
    reason?: string;
  }
}

/**
 * **A target's name, and deliberately not a union.**
 *
 * It was `'npm' | 'docker'`, the type half of a bug whose runtime half was a hardcoded `['npm']`
 * default, so `rman list --json` reported `publishTargets: ["npm"]` for a Cargo package. Both are
 * gone together - which targets exist is whatever the repository's plugins contribute
 * (`RmanApplication.publishTargets`), so a union here would mean the core naming plugins it cannot
 * know about, exactly as `Package.provider` must not.
 *
 * A name nothing implements is caught where the facts are, by `publish` itself, naming the targets
 * this repository does have.
 */
export type PublishTargetName = string;

/**
 * The targets a package **declares**, or `undefined` when it declares none - which is not the same
 * as an empty list, and the difference is what `claims` is asked about.
 */
export function declaredTargets(pkg: Package): string[] | undefined {
  const declared = pkg.config.publish?.target;
  if (declared === undefined) return undefined;
  return Array.isArray(declared) ? [...declared] : [declared];
}

/** Whether `pkg` ships to `target`: its own `publish.target` decides when it has one, and the
 *  target's own `claims` decides when it does not. */
export function shipsTo(pkg: Package, target: PublishTarget): boolean {
  const declared = declaredTargets(pkg);
  return declared ? declared.includes(target.name) : !!target.claims?.(pkg);
}

/** Every registered target `pkg` ships to, in registration order. The single answer to "where does
 *  this package go", so `publish` and `list --json` cannot disagree about it. */
export function targetsOf(app: RmanApplication, pkg: Package): PublishTarget[] {
  return app.publishTargets.all.filter(target => shipsTo(pkg, target));
}

/** Names in a package's `publish.target` that no registered target answers to - a misconfiguration
 *  that used to be caught by a `choices: ['npm', 'docker']` the core can no longer write down. */
export function unknownTargets(app: RmanApplication, pkg: Package): string[] {
  const declared = declaredTargets(pkg);
  if (!declared) return [];
  const known = new Set(app.publishTargets.all.map(t => t.name));
  return declared.filter(name => !known.has(name));
}
