import path from 'node:path';

/** Where a repository keeps command modules of its own, as a glob or a list of them. */
export const COMMANDS_KEY = 'commands';

/** The keys whose string entries are globs, and so have to be anchored to the file that wrote
 *  them - see `anchorContributions`. The same three that always append. */
const GLOB_KEYS: readonly string[] = ['plugins', COMMANDS_KEY, 'publishTargets'];

/**
 * Keys that **append rather than replace**, which is the only append rman has.
 *
 * **There used to be a `+key` prefix on every key, and it is gone.** It said "add to what this
 * resolved to below", which is exactly what `value` says - and `value` says it better: it composes
 * (three layers each deriving from the one under them), it can reorder or filter rather than only
 * append, and it does not need the merge to keep an append *outstanding* until the layer it belongs
 * to turns up. The prefix also carried a bug `value` does not: appending onto a value that was a
 * sole `${{ }}` expression returning an array nested it, because the merge promoted the expression
 * *string* to a list and interpolation only later turned that element into the array (measured,
 * `[['a','b'],'c']` where a literal list gave `['a','b','c']`).
 *
 * What is left is this list, where appending is not a choice the author makes per layer but what
 * the key *means*.
 *
 * `plugins` is the whole list because it is the one key where replacing is never what anyone meant:
 * every other setting has a value a closer layer can sensibly overrule, while a plugin *adds
 * commands and seams*, and a repository naming one has no wish to lose the ones its shared config
 * brought. Replacing was the silent failure - `extends`-ing a toolchain config and then adding a
 * plugin of your own dropped the toolchain's, and what you noticed was `Unknown argument: publish`.
 *
 * `commands` and `publishTargets` are the same kind of statement - what this repository has, in
 * instances or in globs naming them - so they append for the same reason: a repository adding one
 * of its own never means "and stop loading the ones my shared config brought". All three are what
 * a config *contributes*, and a contribution list is exactly the case where replacing is never
 * what anyone meant.
 *
 * Do not extend this list casually: a key that always appends can never be *un*-said by a closer
 * layer, which is only acceptable where the value is a set of contributions rather than a decision.
 */
export const ALWAYS_APPEND: readonly string[] = ['plugins', COMMANDS_KEY, 'publishTargets'];

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
 * through `mergeConfig` and `rman config` without either of them having to know it
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

/**
 * Merges `source` onto `target` in place, the way every layer of rman config is combined - a
 * directory's own file forms, the directory chain, `"[selector]"` blocks, and an `extends` base.
 * One implementation for all of them, so they cannot disagree about what an append means.
 *
 * Plain keys replace and nested objects merge recursively, as a deep merge always has. The two
 * things it adds are the contribution keys, which append instead (`ALWAYS_APPEND`), and the record
 * of what each key held underneath, so a closer layer can derive from it as `value`.
 *
 * ```yaml
 * # the root says   before: "rm ./build"
 * # a package says  before: "${{ [...value, 'rm ./cache'] }}"
 * # it resolves to   before: ["rm ./build", "rm ./cache"]
 * ```
 *
 * That is the half a shared config cannot live without: a base declaring `before: ["rm ./build"]`
 * otherwise forces every repository wanting one more step to restate the whole list - which is a
 * copy of the base, silently frozen at the version it was copied from.
 *
 * **A `+key` prefix used to mean this and is refused now**, naming the key and what to write
 * instead - see the check at the top of the loop.
 */
export function mergeConfig(
  target: Record<string, any>,
  source: Record<string, any>,
  /** The file `source` was read from, recorded per key - see `ORIGINS`. A caller merging a value it
   *  built rather than read (a selector block already carrying its own origins) passes nothing. */
  origin?: string,
): Record<string, any> {
  for (const [key, value] of Object.entries(source)) {
    /**
     * **A retired `+key` is refused, not ignored.** rman validates no config keys at all - there is
     * no schema behind `.rmanrc`/`.rmanrc.yml` any more - so an unknown key is silent, and a
     * repository upgrading from 1.x with `+before:` in its config would simply lose that step with
     * nothing said. Measured before this check: `+include: ['extra']` resolved to the inherited
     * list unchanged, exactly as if the line were not there.
     *
     * Here rather than in a validator, because this is the one function every layer passes through,
     * and it is the only place that still knows which file the key came from.
     */
    if (key.length > 1 && key.startsWith('+')) {
      const plain = key.slice(1);
      throw new Error(
        `"${key}" is no longer a config key${origin ? ` (${origin})` : ''}. The \`+key\` prefix is ` +
          `gone: write "${plain}" as a value that derives from what it inherited - ` +
          `\`${plain}: ({ value }) => [...value, 'x']\`, or \`"\${{ [...value, 'x'] }}"\` in YAML. ` +
          `\`value\` is the layers below this one, and spreads as empty when there are none.`,
      );
    }
    /** `plugins`/`commands`/`publishTargets`: additive at every layer, so the closer one adds
     *  rather than takes over. A glob among them is anchored to its own file on the way in - see
     *  `anchorContributions`. */
    if (ALWAYS_APPEND.includes(key)) {
      appendList(target, key, GLOB_KEYS.includes(key) ? anchorContributions(value, origin) : value);
      continue;
    }
    assignMerged(target, key, value, source, origin);
  }
  return target;
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
  /**
   * **A chain already on `source` is carried over**, the way its `ORIGINS` are just above - and for
   * the same reason: `source` may itself be several layers already merged, and only the merge knows
   * their order.
   *
   * Without this, a chain recorded *inside* a source was silently dropped whenever the key was
   * absent from the target, because the link below was only ever recorded for a key being
   * *replaced*. The shape that hit it is the ordinary one for a shared config: a base and its
   * consumer both writing `"[*]"`. Those two blocks merge into one before `matchingSelectors` sees
   * them - recording the chain on the merged block - and that block is then merged into a `result`
   * which has no such key, so the chain went nowhere.
   *
   * Measured, on a base declaring `clean.include: ['build']` and a consumer's `"[*]"` deriving from
   * it: `${{ [...value, 'dist'] }}` answered `['dist']`, losing `build` outright. It answers
   * `['build', 'dist']` now. Two *different* selectors (`"[*]"` then `"[pkg-a]"`) always worked,
   * and so did an unmarked key, which is why this went unnoticed - those merge into a target that
   * already holds the key.
   */
  const sourceChain = (source as Record<symbol, any>)[PREVIOUS_VALUES]?.[key] as PreviousValue | undefined;
  if (carriesPreviousValue(value) && (key in target || sourceChain)) {
    const carrier = target as Record<symbol, unknown>;
    const chain = (carrier[PREVIOUS_VALUES] ??= {}) as Record<string, PreviousValue>;
    /** The layer the target itself stands for, bottom-most of the three: what it holds now, over
     *  whatever *that* was derived from. Absent when the target never had the key. */
    const below: PreviousValue | undefined = key in target ? { value: target[key], previous: chain[key] } : chain[key];
    /** Bottom-up: the target's layer, then `source`'s own intermediate ones, then `value` on top -
     *  so `source`'s chain keeps its internal order and gets the target's spliced beneath it. */
    chain[key] = sourceChain ? graftChain(sourceChain, below) : below!;
  }
  target[key] = Array.isArray(value) ? [...value] : value;
}

/** `node`'s chain, copied with `tail` spliced in beneath its deepest link - so two layer-stacks
 *  join into one without either being mutated (a chain is shared by every package that resolved
 *  through it, so grafting in place would rewrite what the others see). */
function graftChain(node: PreviousValue, tail: PreviousValue | undefined): PreviousValue {
  return { value: node.value, previous: node.previous ? graftChain(node.previous, tail) : tail };
}

/**
 * Appends `value` to `target[key]`, de-duplicating **only** an `ALWAYS_APPEND` key.
 *
 * That asymmetry is the point. `plugins` appends without being asked, so a repository and the config
 * it extends both naming `'node'` is the ordinary case rather than a mistake, and the list is
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

/**
 * Anchors every glob in `plugins`/`commands`/`publishTargets` to the directory of the file that
 * declared it, on the way in. A non-string entry - an instance written straight into the config -
 * passes through untouched.
 *
 * **Done here, at the merge, because this is the last moment the answer is known.** `commands`
 * always appends, so one resolved list ends up holding entries from the repository's own
 * `.rmanrc`, from each `extends` base, and from every directory above - and `ORIGINS` records one
 * file per *key*, not per element, so after the merge there is nothing left to attribute them by.
 * Rewriting each glob as it arrives makes the merge trivially correct and costs one `path.resolve`.
 *
 * It is what lets a **shared config ship its own contributions**: `commands: './commands/*.js'`
 * in a published package means that package's directory, wherever the repository inheriting it
 * happens to sit. All three keys behave the same way; `plugins` used to resolve every entry
 * against the repository root instead, whatever file declared it, and that asymmetry is gone.
 *
 * `origin` is absent when a caller merges a value it built rather than read (a selector block, the
 * directory chain layering already-resolved configs); those globs have been anchored already, and
 * an absolute path is left alone by `path.resolve` anyway.
 */
function anchorContributions(value: unknown, origin: string | undefined): unknown {
  if (!origin) return value;
  const dir = path.dirname(origin);
  const anchor = (entry: unknown) =>
    typeof entry === 'string' && !looksLikePackageName(entry) ? path.resolve(dir, entry) : entry;
  return Array.isArray(value) ? value.map(anchor) : anchor(value);
}

/**
 * Whether an entry is shaped like a **package name** rather than a glob - `rman-node`,
 * `@panates/rman-node`, but not `*.js`, `./x.js` or `commands/*.mjs`.
 *
 * Such an entry is left unanchored, because it is not a relative path and turning it into one
 * destroys the only evidence of what the author meant. A package name is never valid in these keys
 * (a package's config arrives through `extends`), so the whole value of keeping it intact is the
 * error message: anchored, `plugins: ['rman-node']` failed with `glob ".../rman-node" matched no
 * file`, which sends the reader to check their paths. `loadPlugins` can now say what they actually
 * wrote and what to write instead - which two doc pages already promised it did.
 *
 * Shape, not a resolver call: decidable without touching the disk, and a wrong guess only chooses
 * which of two error messages a failing entry gets. An extension is excluded so a bare `plugin.js`
 * beside the config is still anchored as the relative path it is.
 */
function looksLikePackageName(entry: string): boolean {
  return /^(?:@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*$/i.test(entry) && !/\.[cm]?js$/i.test(entry);
}

/** A config object, as opposed to an array or anything with its own prototype - only the former
 *  merges key by key. */
function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
