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
 * Where a value function keeps the value it is replacing, so it can be handed back as `value`.
 *
 * A **symbol on a forwarding wrapper**, rather than a class or a `{fn, prev}` object, for one
 * concrete reason: every walker in this file and in `config.ts` decides what to do by asking
 * `isPlainObject`, and a wrapper object would answer yes - `finalizeConfig` would rebuild it as a
 * plain object and lose the function, and `mergeConfig` would try to merge into it key by key. A
 * function is not a plain object, so it travels through all of them untouched.
 *
 * The user's own function is never mutated: two packages inheriting the same shared-config function
 * would otherwise share - and overwrite - one `prev`.
 */
export const PREVIOUS_VALUE = Symbol('rman.previousValue');

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
export function mergeConfig(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  // Plain keys first, so a `+key` alongside its own `key` appends to that replacement rather than
  // to whatever the previous layer had.
  for (const [key, value] of Object.entries(source)) {
    if (appendTarget(key)) continue;
    /** `plugins`: additive at every layer, so the closer one adds rather than takes over. */
    if (ALWAYS_APPEND.includes(key)) {
      appendList(target, key, value);
      continue;
    }
    assignMerged(target, key, value);
  }
  for (const [key, value] of Object.entries(source)) {
    const plain = appendTarget(key);
    if (!plain) continue;

    // An object merges either way, so the prefix asks for nothing extra - resolve it now and let
    // the two spellings coincide.
    if (isPlainObject(value) || isPlainObject(target[plain])) {
      assignMerged(target, plain, value);
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
  return result as T;
}

function assignMerged(target: Record<string, any>, key: string, value: unknown): void {
  if (isPlainObject(value)) {
    if (!isPlainObject(target[key])) target[key] = {};
    mergeConfig(target[key], value);
    return;
  }
  /**
   * A function **replaces** like any other value - and remembers what it replaced, so it can be
   * given it back as `value` when the config resolves:
   *
   * ```js
   * '[*]':      { clean: { include: ({ vars }) => [vars.buildDir] } }
   * '[ws:*]':   { clean: { include: ({ value, pkg }) => [...value, pkg.basename + '.log'] } }
   * ```
   *
   * Chained here rather than at resolution time because only the merge knows the order of the
   * layers - by the time `interpolateConfig` sees the config they have collapsed into one object,
   * and whatever a closer layer said has already taken the place of what it was derived from.
   */
  if (typeof value === 'function') {
    target[key] = chainValueFn(value as (...args: any[]) => unknown, target[key]);
    return;
  }
  target[key] = Array.isArray(value) ? [...value] : value;
}

/**
 * Wraps `fn` so it carries `previous`, leaving `fn` itself alone.
 *
 * The wrapper forwards every argument unchanged, which is what lets one rule cover both kinds of
 * function a config can hold: a **value** function is called by `interpolateConfig` with the config
 * scope, a **step** function by `RunService` with a `RunStepContext`, and neither needs to know it
 * has been wrapped. `name` is copied over because a step's label is its function's name.
 */
function chainValueFn(fn: (...args: any[]) => unknown, previous: unknown): (...args: any[]) => unknown {
  const wrapper = (...args: any[]) => fn(...args);
  Object.defineProperty(wrapper, 'name', { value: fn.name, configurable: true });
  /** Only when there *is* one: an own property set to `undefined` is indistinguishable from an
   *  inherited value that genuinely resolved to nothing. */
  if (previous !== undefined) Object.defineProperty(wrapper, PREVIOUS_VALUE, { value: previous });
  return wrapper;
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
