/**
 * A copy of a resolved config with every value a serializer cannot represent replaced by a short
 * description of it - for `rman config` and `--config`, which exist to be *looked at*.
 *
 * Needed because a config legitimately holds functions now: a `run.<script>` or `version.<slot>`
 * step written as JavaScript, and an `if` written the same way. It was already needed before that,
 * though, which is the better argument for doing it here rather than at one call site - a
 * `plugins` entry given in its object form carries the plugin's seams, and `rman config --from-root`
 * died on one with `unacceptable kind of an object to dump [object Function]` (measured, on a
 * repository whose shared config did nothing more unusual than `extends` a plugin package).
 *
 * A function prints as `[Function: copyDocs]`, so the output says *which* one - an anonymous step
 * reads as `[Function]`, which is itself worth seeing.
 */
export function printableConfig<T>(config: T): T {
  return walk(config, new WeakSet()) as T;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
  if (!value || typeof value !== 'object') return value;

  /** A resolved config is a tree, but a plugin object is arbitrary code's data and may not be.
   *  js-yaml's `noRefs` turns a repeat into a copy rather than an anchor, which on a true cycle
   *  never terminates - so the cycle is cut here, where it can be named. */
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => walk(item, seen));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = walk(item, seen);
    return result;
  } finally {
    /** Released on the way out, so a value that merely appears twice in *different* branches - the
     *  ordinary case after merging - is printed both times rather than reported as a cycle. */
    seen.delete(value);
  }
}
