import micromatch from 'micromatch';
import type { RmanApplication } from '../application.js';
import type { Package } from '../classes/package.js';
import type { Repository } from '../classes/repository.js';

/**
 * **How one technology answers "are this package's dependencies current, and what may they move
 * to"** - the half of `rman deps` that is an ecosystem's.
 *
 * The command owns the repository's half: which packages are asked, printing the plan, `--json`,
 * writing only under `--upgrade`, and undoing the writes when `verify` refuses them.
 */
/* **The same split `PublishTarget` draws, for the same reason.** Which packages, in what order,
 * plan before apply, a JSON a script can read - none of that is npm's. What is npm's is everything
 * that gives the answer: four dependency fields, caret and tilde ranges, a registry reached through
 * `npm view`, and peer dependencies, which is a concept Cargo does not have at all.
 *
 * **The whole set of a technology's packages is planned at once**, never one package at a time. A
 * monorepo package's peer range constrains what its siblings may move to, and the registry is
 * asked once per dependency *name* rather than once per package declaring it - both need every
 * package in hand. */
export interface DependencyUpdater {
  /** What each dependency of `packages` would move to - never writes. */
  getPlan(ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<DependencyUpdater.Entry[]>;

  /** Writes every `'update'` entry of `plan` to its manifest, and returns how to take that back. */
  applyPlan(
    ctx: DependencyUpdater.Context,
    plan: readonly DependencyUpdater.Entry[],
  ): Promise<DependencyUpdater.Applied>;

  /**
   * Asks the ecosystem's own resolver whether the manifests as they now stand can be installed,
   * once `applyPlan` has written them. Returns why not, or `undefined` when they can.
   *
   * Omit it when the ecosystem has no resolver to ask; the plan's own checks then stand alone.
   */
  /* **This is the second of two checks, and it exists because the first cannot be complete.**
   * `getPlan` checks what it can see - the peer ranges of the packages a manifest names, the
   * runtime they require, what a sibling package asks of a shared dependency - and explains every
   * version it holds back. A dependency's own dependency carrying a peer range is out of its sight,
   * and seeing it would mean writing the ecosystem's resolver again. Asking the real one is cheaper
   * and cannot be wrong about its own rules. */
  verify?(ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<string | undefined>;
}

export namespace DependencyUpdater {
  /** What one call is handed. */
  export interface Context {
    readonly app: RmanApplication;
    readonly repository: Repository;
    readonly options: Options;
  }

  /** The run's own settings, read off the command line. A package's `.rmanrc "deps"` block supplies
   *  the rest - see `settingsFor`. */
  export interface Options {
    /** Only the dependencies whose names match one of these globs. */
    names?: string[];
    /** Overrides every package's `deps.target`. */
    target?: string;
    /** Added to every package's `deps.reject`. */
    reject?: string[];
    /** Overrides every package's `deps.minAge`. */
    minAge?: number;
    /** How many registry lookups run at once. */
    concurrency: number;
    /** Reported as each dependency name's registry lookup finishes. */
    onProgress?(done: number, total: number): void;
  }

  /** One package's settings, once the command line has been laid over its config. */
  export interface Settings {
    /** The largest move allowed, as one of the package's version scheme's `bumpNames` - `minor`
     *  keeps every dependency inside its major. */
    target: string;
    /** `deps.targets`: a dependency-name glob, and the largest move for the names it matches -
     *  ahead of `target`. Empty when `--target` was given, which overrides both. */
    targets: Record<string, string>;
    reject: string[];
    minAge: number;
    /** The dependency kinds to look at, in the ecosystem's own words - `undefined` is every one. */
    types?: string[];
  }

  /**
   * One dependency of one package.
   *
   * - `'update'`: `target` is the new range; `reason` says why it is lower than `latest`, if it is.
   * - `'held'`: a newer version exists and is allowed, but another dependency's rule refuses it -
   *   `reason` names that rule.
   * - `'skipped'`: a newer version exists, and the package's own settings leave it out - a major
   *   under `target: minor`, or one younger than `minAge`. `reason` says which.
   * - `'up-to-date'`: nothing newer exists.
   * - `'error'`: the registry gave no answer.
   */
  export interface Entry {
    package: Package;
    /** The dependency's name. */
    name: string;
    /** Where the package declares it, in the ecosystem's own words - `devDependencies`. */
    types: string[];
    /** The range as the manifest declares it. */
    current: string;
    status: 'update' | 'held' | 'skipped' | 'up-to-date' | 'error';
    /** The range it is rewritten to, on an `'update'`. */
    target?: string;
    /** The newest version the package's own settings allow, before any other dependency's rule. */
    latest?: string;
    /** The newest version there is, whatever the settings say - what a reader compares against to
     *  see what was left behind. */
    available?: string;
    /** How far `target` moves, in the version scheme's own words - `major`. */
    bump?: string;
    reason?: string;
  }

  /** What `applyPlan` wrote. */
  export interface Applied {
    /** Every file it changed, absolute. */
    files: string[];
    /** Puts every one of them back as it was. */
    restore(): void;
  }

  /**
   * Every move but the largest - `minor` under semver. The largest is the one a scheme reserves for a
   * break, and taking a break is a decision a person makes, not a default.
   */
  /* **It was `latest` - every move - and that was the wrong default**, measured the moment it ran:
   * a `^5.3.0` came back as `^7.0.2`. The values are the scheme's own `bumpNames` rather than a list
   * written here, for the reason `version` gives: `patch`/`minor`/`major` are semver's words, and a
   * four-part scheme would offer four. */
  export function defaultTarget(bumps: readonly string[]): string {
    return bumps[Math.max(0, bumps.length - 2)]!;
  }

  /**
   * The largest move `settings` allow for the dependency `name`, and the key that said so - the
   * **last** `deps.targets` glob matching it, else `deps.target`.
   */
  /* Last rather than first, because that is how two `"[selector]"` blocks layer: what is written
   * later wins. */
  export function targetFor(settings: Settings, name: string): { size: string; from: string } {
    let found: { size: string; from: string } | undefined;
    for (const [glob, size] of Object.entries(settings.targets)) {
      if (micromatch.isMatch(name, glob)) found = { size, from: `deps.targets["${glob}"]` };
    }
    return found ?? { size: settings.target, from: 'deps.target' };
  }

  /** The settings `pkg` is planned with: `options` from the command line over its `.rmanrc "deps"`,
   *  and the defaults under both. */
  export function settingsFor(pkg: Package, options: Options): Settings {
    const config = pkg.config.deps ?? {};
    const bumps = pkg.versionScheme.bumpNames;
    const target = options.target ?? config.target ?? defaultTarget(bumps);
    if (!bumps.includes(target)) {
      throw new Error(
        `Invalid "deps.target" for "${pkg.name}": "${target}" (expected one of: ${bumps.join(', ')}, ` +
          `the "${pkg.versionScheme.name}" scheme's own sizes)`,
      );
    }
    const targets: Record<string, string> = options.target ? {} : { ...(config.targets ?? {}) };
    for (const [glob, size] of Object.entries(targets)) {
      if (!bumps.includes(size)) {
        throw new Error(
          `Invalid "deps.targets" entry "${glob}" for "${pkg.name}": "${size}" (expected one of: ${bumps.join(', ')})`,
        );
      }
    }
    return {
      target,
      targets,
      reject: [...toList(config.reject), ...(options.reject ?? [])],
      minAge: options.minAge ?? config.minAge ?? 0,
      types: config.types?.length ? [...config.types] : undefined,
    };
  }
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}
