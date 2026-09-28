import { CODE_SUBTREES } from '../core/config/config-paths.js';

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

/**
 * A resolved config with the **contribution keys** dropped - `plugins`, `platforms`, `commands`,
 * `publishTargets` - for `rman config` and `--config`, which exist to show what a repository is
 * *configured* to do.
 *
 * Returns a copy; the config itself is what every command reads and is never touched.
 */
/* **Those four are code, not settings** (`CODE_SUBTREES`), and printing them answers a question
 * nobody asked: a platform dumps its manifest provider and version planner, a publish target its
 * whole option table, and `commands` comes out as a list of `[Function]` - which is the clearest
 * evidence of all that they do not belong in this output. Measured on this repository, where
 * `rman config` printed forty lines of the npm target's flags above the two keys its `.rmanrc`
 * actually sets.
 *
 * **And silently, which was argued the other way first.** The note that announced them read as the
 * sibling of the `version.<slot>` one, and it is not: that note explains a *visible* oddity - an
 * unresolved `${{ }}` sitting among resolved values, which without it reads as interpolation being
 * broken - while this one announced an absence the reader was not looking for. The measurement that
 * settled it: presets go under every root, so every config carries all four and the note was
 * printed **every time**, which makes it a banner rather than a report. At this repository's root
 * it was one of three lines. A reader asking which technologies are loaded is asking `rman info`,
 * and one asking whether their command registered is asking `rman --help`.
 *
 * **`CODE_SUBTREES` itself, not a second copy of those four names.** `config-paths.ts` imports
 * nothing, so there is no cycle to buy by reaching for it - and a printer quietly keeping its own
 * list is how a key added to one side stops being dropped by the other. That exact shape was live
 * in this tree an hour earlier: `presetNames()` held a hardcoded `['node']` beside a resolver that
 * looked somewhere else, and the error message named the preset it had just failed to find.
 *
 * **Top level only, matching the runtime rule** (`ConfigInterpolator._isCodePath` checks
 * `segments[0]`). `Resolved` skips these names at *every* level because the selector index
 * re-enters the config, and the two have disagreed since - this is not the place to pick a side,
 * and stripping them deeper would hide a script that happens to be called `commands`. By the time
 * either printer runs the selector blocks are merged in anyway, so there is no deeper one to find.
 *
 * **Distinct from `printableConfig`, which makes a value serializable rather than deciding what is
 * worth showing.** A step written as a function still prints as `[Function: copyDocs]` - that one
 * *is* a setting. */
export function withoutContributions<T extends object>(config: T): T {
  const result = { ...(config as Record<string, unknown>) };
  for (const key of CODE_SUBTREES) delete result[key];
  return result as T;
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
