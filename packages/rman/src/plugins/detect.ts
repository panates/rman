import fs from 'node:fs';
import path from 'node:path';

/**
 * **Which built-in a repository looks like, when it has not said.**
 *
 * The 2.0 split made every Node repository write a config file before `rman clean` would run, and
 * the cost of that landed on exactly the repositories the split was not for. This is the other half
 * of the fix: a repository that declares no technology gets the one its own files already imply.
 *
 * **Only ever consulted when nothing was declared** - see `readDirConfig`. That boundary is the
 * whole safety of it, because registering a technology changes *which directories are packages at
 * all* (`Workspace.resolve` takes the first provider that answers), so guessing on top of an
 * explicit statement could quietly change what `rman list` reports. A repository that means "no
 * technologies" writes `plugins: []`, which counts as having said so.
 *
 * **It is announced, not silent.** A guess the user cannot see is a guess they cannot correct; the
 * caller prints what was detected and why.
 */
export interface DetectedBuiltin {
  /** The built-in's name - what `plugins: [...]` would have said. */
  name: string;
  /** The file that gave it away, for the message. */
  because: string;
}

/**
 * What `dir` looks like, or `undefined` for a repository rman cannot place.
 *
 * Memoized per directory: `readDirConfig` is called once per directory per package, and this reads
 * the disk. Nothing here writes, so the answer cannot change under a single run in any way that
 * matters - and a run that *did* create a `package.json` (`rman import`) has already resolved the
 * config it is acting on.
 */
export function detectBuiltin(dir: string): DetectedBuiltin | undefined {
  const resolved = path.resolve(dir);
  if (cache.has(resolved)) return cache.get(resolved);
  const found = SIGNALS.map(signal => signal(resolved)).find(Boolean);
  cache.set(resolved, found);
  return found;
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

/** Forgets what was detected - for a spec that writes a fixture, detects, then writes another. */
export function clearDetectionCache(): void {
  cache.clear();
}

/**
 * One signal per built-in, asked in order.
 *
 * **A single file each, deliberately.** A cleverer test (read the manifest, look for `workspaces`,
 * count source files) buys nothing here: this only fires when the repository said nothing, so the
 * question is not "is this definitely a Node repository" but "is there anything better to guess".
 * A `package.json` is the file npm requires and no other ecosystem writes.
 *
 * The order is the order a polyglot repository's `plugins` would list, and it matters for the same
 * reason: the first provider that recognizes a directory decides whether it holds a package. With
 * one built-in there is nothing to order yet - the list is written as a list so that adding a second
 * is a line rather than a rewrite.
 */
const SIGNALS: ((dir: string) => DetectedBuiltin | undefined)[] = [
  dir => (fs.existsSync(path.join(dir, 'package.json')) ? { name: 'node', because: 'package.json' } : undefined),
];

const cache = new Map<string, DetectedBuiltin | undefined>();
