import path from 'node:path';
import { BUILTIN_PLUGINS } from './builtins.js';

/**
 * **Which platform a repository looks like, when it has not said.**
 *
 * The 2.0 split made every Node repository write a config file before `rman clean` would run, and
 * the cost of that landed on exactly the repositories the split was not for. This is the other half
 * of the fix: a repository that declares no technology gets the one its own files already imply.
 *
 * **The core does not know what any repository looks like, and must not.** It asks the *platforms*
 * - `manifestProvider.read(dir)` has always meant "is this directory one of mine?", so there is no
 * new seam and no list of filenames anywhere in `core/`. This file listed `package.json` for one
 * commit, which is the same mistake as the hardcoded `['npm']` publish default that
 * `PublishTarget.claims` exists to have replaced: true of npm, written in a place that speaks for
 * every ecosystem, and invisible while only one platform ships.
 *
 * The platforms it can ask are the ones it has, which are the built-ins - by construction, not by
 * choice: a third-party platform arrives through `plugins` or `extends`, and a repository that
 * wrote either has declared its technology, so detection never runs for it.
 *
 * **Only ever consulted when nothing was declared** - see `Repository.create`, which checks both the
 * config and the application. That boundary is the whole safety of it, because registering a
 * platform changes *which directories are packages at all* (`Workspace.resolve` takes the first
 * provider that answers), so guessing on top of an explicit statement could quietly change what
 * `rman list` reports.
 *
 * **It is announced, not silent.** A guess the reader cannot see is one they cannot correct.
 */
export interface DetectedBuiltin {
  /** The built-in's name - what `plugins: [...]` would have said. */
  name: string;
  /** The file that gave it away, for the message - the platform's own `manifestFile`. */
  because: string;
}

/**
 * Marks a config whose `plugins` was **detected rather than declared**, so the one caller that
 * should say so can tell.
 *
 * A non-enumerable symbol, the way `ORIGINS` and `PREVIOUS_VALUES` already carry bookkeeping: it
 * travels with the config through `mergeConfig`, `JSON.stringify` and `rman config` without any of
 * them knowing it is there, and `expect`'s `toEqual` compares symbol properties - so a plain
 * property would turn every config-shape spec into a diff about this.
 *
 * The alternative was re-deriving the answer where the message is printed, which means reading the
 * config twice and two places that can disagree about what "declared" means.
 */
export const DETECTED_BUILTIN = Symbol('rman.detectedBuiltin');

/** What detection put on `config`, if anything. */
export function detectedBuiltinOf(config: object): DetectedBuiltin | undefined {
  return (config as Record<symbol, DetectedBuiltin | undefined>)[DETECTED_BUILTIN];
}

/**
 * The first built-in platform that claims `dir`, or `undefined` for a repository none of them
 * recognizes - which is the honest answer, not a default.
 *
 * **First match, in declaration order**, the same rule `Manifest.read` and `Workspace.resolve`
 * already follow, so a repository two platforms both recognize resolves the same way here as it
 * will once they are loaded.
 *
 * Memoized per directory: this is asked once per directory per package and each ask reads the disk.
 * Nothing here writes, so the answer cannot change under a run in any way that matters.
 */
export function detectBuiltin(dir: string): DetectedBuiltin | undefined {
  const resolved = path.resolve(dir);
  if (cache.has(resolved)) return cache.get(resolved);
  let found: DetectedBuiltin | undefined;
  for (const [name, builtin] of Object.entries(BUILTIN_PLUGINS)) {
    const platform = builtin.plugin();
    /** `read` is the question. Its answer is thrown away - the manifest is read again for real once
     *  the platform is registered, and reading it twice is cheaper than keeping a half-built
     *  package around to decide whether it should exist. */
    if (platform.manifestProvider.read(resolved)) {
      found = { name, because: platform.manifestProvider.fileName };
      break;
    }
  }
  cache.set(resolved, found);
  return found;
}

/** Forgets what was detected - for a spec that writes a fixture, detects, then writes another. */
export function clearDetectionCache(): void {
  cache.clear();
}

const cache = new Map<string, DetectedBuiltin | undefined>();
