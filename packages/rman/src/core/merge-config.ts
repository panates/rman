/** The prefix that turns a key into an append instead of a replacement: `+before` adds to whatever
 *  `before` already resolved to, rather than taking its place. */
export const APPEND_PREFIX = '+';

/**
 * Keys that **append whether or not you ask** - `+plugins` is accepted and means nothing extra.
 *
 * `plugins` is the whole list because it is the one key where replacing is never what anyone meant:
 * every other setting has a value a closer layer can sensibly overrule, while a plugin *adds
 * commands and seams*, and a repository naming one has no wish to lose the ones its shared config
 * brought. Replacing was the silent failure - `extends`-ing a toolchain config and then adding a
 * plugin of your own dropped the toolchain's, and what you noticed was `Unknown argument: publish`.
 *
 * Do not extend this list casually: a key that always appends can never be *un*-said by a closer
 * layer, which is only acceptable where the value is a set of contributions rather than a decision.
 */
export const ALWAYS_APPEND: readonly string[] = ['plugins'];

/**
 * Where a key keeps what it is replacing, so the replacement can be handed it back as `value`.
 *
 * A **symbol-keyed chain on the containing object**, one entry per key, rather than something
 * attached to the value itself. It started as a wrapper around a *function*, which is the only kind
 * of value you can hang a property on - and that is exactly why it had to change: `value` belongs to
 * an expression (`"${{ [...value, 'x'] }}"`) just as much as to a function, and a string cannot
 * carry one.
 *
 * A symbol is invisible to `Object.entries`, `JSON.stringify` and js-yaml, so the chain travels
 * through `mergeConfig`, `finalizeConfig` and `rman config` without any of them having to know it
 * is there.
 *
 * Each entry is a link, not a single slot: three layers each deriving from the one below need
 * `A <- expr2 <- expr3`, and one slot would have lost `A` the moment `expr3` arrived.
 */
export const PREVIOUS_VALUES = Symbol('rman.previousValues');

/**
 * Which file each key came from, so an error can name it.
 *
 * A config is merged from several files before anything reads it - a directory's own four forms, an
 * `extends` base, every `"[selector]"` block, and one layer per directory from the root down - so by
 * the time an expression fails, `version.commitMessage` could have been written in any of them.
 * Saying only the key sends the reader looking through all of them.
 *
 * Recorded the same way `PREVIOUS_VALUES` is, for the same reason: a symbol on the containing
 * object, invisible to `Object.entries`, `JSON.stringify` and js-yaml, so it travels with the config
 * without any reader having to know it is there.
 */
export const ORIGINS = Symbol('rman.origins');

/** One link: the raw value this key held, and whatever *it* was derived from. */
export interface PreviousValue {
  value: unknown;
  previous?: PreviousValue;
}

/** Only these two can ask for `value`, so only these two are worth remembering a previous for. */
export function carriesPreviousValue(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'string' && value.includes('${{'));
}

/** `"+before"` -> `"before"`, or `undefined` for a key that isn't an append. */
export function appendTarget(key: string): string | undefined {
  return key.length > APPEND_PREFIX.length && key.startsWith(APPEND_PREFIX)
    ? key.slice(APPEND_PREFIX.length)
    : undefined;
}

/**
 * Merges `source` onto `target` in place, the way every layer of rman config is combined - a
 * directory's own file forms, the directory chain, `"[selector]"` blocks, and an `extends` base.
 * One implementation for all of them, so they cannot disagree about what an append means.
 *
 * Plain keys replace, and nested objects merge recursively, as a deep merge always has. What this
 * adds is `+key`:
 *
 * ```yaml
 * # the root says          before: "rm ./build"
 * # a package adds        +before: "rm ./cache"
 * # it resolves to         before: ["rm ./build", "rm ./cache"]
 * ```
 *
 * Appending is the half a shared config can't live without: a base that declares
 * `before: ["rm ./build"]` otherwise forces every repository wanting one more step to restate the
 * whole list - which is a copy of the base, silently frozen at the version it was copied from.
 *
 * A scalar is promoted to a list on the way, so neither side has to be written as an array. With
 * nothing inherited, `+key` simply produces a one-element list.
 *
 * On a value that isn't a list, the prefix is **ignored** rather than an error, because there the
 * two spellings already mean the same thing: objects merge whether or not you asked them to, and a
 * scalar has nothing to append to, so `+key` behaves exactly as `key` would. Nothing is silently
 * dropped - the value still lands.
 *
 * `key` and `+key` in the same object are both honored, in that order: the replacement happens
 * first, then the append lands on top of it.
 */
export function mergeConfig(
  target: Record<string, any>,
  source: Record<string, any>,
  /** The file `source` was read from, recorded per key - see `ORIGINS`. A caller merging a value it
   *  built rather than read (a selector block already carrying its own origins) passes nothing. */
  origin?: string,
): Record<string, any> {
  // Plain keys first, so a `+key` alongside its own `key` appends to that replacement rather than
  // to whatever the previous layer had.
  for (const [key, value] of Object.entries(source)) {
    if (appendTarget(key)) continue;
    /** `plugins`: additive at every layer, so the closer one adds rather than takes over. */
    if (ALWAYS_APPEND.includes(key)) {
      appendList(target, key, value);
      continue;
    }
    assignMerged(target, key, value, source, origin);
  }
  for (const [key, value] of Object.entries(source)) {
    const plain = appendTarget(key);
    if (!plain) continue;

    // An object merges either way, so the prefix asks for nothing extra - resolve it now and let
    // the two spellings coincide.
    if (isPlainObject(value) || isPlainObject(target[plain])) {
      assignMerged(target, plain, value, source, origin);
      continue;
    }
    if (plain in target) {
      appendList(target, plain, value);
      continue;
    }
    /** Nothing to append to *yet*. Kept as an append rather than collapsed into the plain key,
     *  because the layer that provides it may still be coming: a directory's own file forms are
     *  merged into an empty object long before the selector blocks and parent directories they
     *  append to are. Collapsing here lost both of those - measured. `finalizeConfig` turns
     *  whatever is still outstanding at the end into a plain list. */
    target[key] = [...toList(target[key] ?? []), ...toList(value)];
  }
  return target;
}

/**
 * Turns any `+key` still outstanding into its plain key, as a list - the "nothing was inherited"
 * case, where an append simply is the whole value.
 *
 * Called once on a fully resolved config, and only there: until then an outstanding append may
 * still find the layer it belongs to, and a config handed to a command must carry no `+key` at all
 * or every reader would have to know about them.
 */
export function finalizeConfig<T>(config: T): T {
  if (Array.isArray(config)) return config.map(finalizeConfig) as T;
  if (!isPlainObject(config)) return config;
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(config)) {
    const plain = appendTarget(key);
    if (!plain) {
      result[key] = finalizeConfig(value);
      continue;
    }
    const pending = finalizeConfig(value);
    result[plain] = plain in result ? [...toList(result[plain]), ...toList(pending)] : toList(pending);
  }
  /** Carried across by hand: this rebuilds the object from `Object.entries`, which does not see a
   *  symbol - and dropping it here would lose every `value` chain the merge just recorded. */
  for (const carried of [PREVIOUS_VALUES, ORIGINS]) {
    const value = (config as Record<symbol, unknown>)[carried];
    if (value) Object.defineProperty(result, carried, { value });
  }
  return result as T;
}

function assignMerged(
  target: Record<string, any>,
  key: string,
  value: unknown,
  source: Record<string, any>,
  origin: string | undefined,
): void {
  /** A source that already carries origins wins over the caller's: an `extends` base keeps the file
   *  its own keys were written in, rather than being attributed to the file that named it. */
  const from = (source as Record<symbol, any>)[ORIGINS]?.[key] ?? origin;
  if (from !== undefined) {
    const carrier = target as Record<symbol, any>;
    /** **Non-enumerable**, like `PREVIOUS_VALUES`: `expect`'s `toEqual` compares symbol properties,
     *  so a plain assignment turned every config-shape assertion in the suite into a diff about
     *  bookkeeping (measured, five specs at once). Nothing should see this but the error messages. */
    if (!carrier[ORIGINS]) Object.defineProperty(target, ORIGINS, { value: {}, writable: true });
    (carrier[ORIGINS] as Record<string, string>)[key] = from;
  }
  if (isPlainObject(value)) {
    if (!isPlainObject(target[key])) target[key] = {};
    mergeConfig(target[key], value, from);
    return;
  }
  /**
   * A value that can ask for `value` **replaces** like any other - and remembers what it replaced:
   *
   * ```js
   * '[*]':    { clean: { include: ({ vars }) => [vars.buildDir] } }
   * '[*]': { clean: { include: "${{ [...value, pkg.basename + '.log'] }}" } }
   * ```
   *
   * Chained here rather than at resolution time because only the merge knows the order of the
   * layers - by the time `interpolateConfig` sees the config they have collapsed into one object,
   * and whatever a closer layer said has already taken the place of what it was derived from.
   */
  if (carriesPreviousValue(value) && key in target) {
    const carrier = target as Record<symbol, unknown>;
    const chain = (carrier[PREVIOUS_VALUES] ??= {}) as Record<string, PreviousValue>;
    chain[key] = { value: target[key], previous: chain[key] };
  }
  target[key] = Array.isArray(value) ? [...value] : value;
}

/**
 * Appends `value` to `target[key]`, de-duplicating **only** an `ALWAYS_APPEND` key.
 *
 * That asymmetry is the point. `plugins` appends without being asked, so a repository and the config
 * it extends both naming `'rman-node'` is the ordinary case rather than a mistake, and the list is
 * also what `rman config` prints. An explicit `+before`, by contrast, was *written* - repeating a
 * step that is already there is a strange thing to ask for, but it is what was asked for, and
 * silently collapsing it would make one layer's list depend on another's contents.
 *
 * By identity (`===`), which covers a string by value and a plugin object by reference; two
 * *different* objects claiming one plugin name are caught where it counts, at registration - see
 * `loadPlugins`.
 */
function appendList(target: Record<string, any>, key: string, value: unknown): void {
  const merged = [...toList(target[key] ?? []), ...toList(value)];
  target[key] = ALWAYS_APPEND.includes(key) ? merged.filter((entry, at) => merged.indexOf(entry) === at) : merged;
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** A config object, as opposed to an array or anything with its own prototype - only the former
 *  merges key by key. */
function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
