/** The prefix that turns a key into an append instead of a replacement: `+before` adds to whatever
 *  `before` already resolved to, rather than taking its place. */
export const APPEND_PREFIX = '+';

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
      target[plain] = [...toList(target[plain]), ...toList(value)];
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
  target[key] = Array.isArray(value) ? [...value] : value;
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** A config object, as opposed to an array or anything with its own prototype - only the former
 *  merges key by key. */
function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
