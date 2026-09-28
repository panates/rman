import nodePath from 'node:path';
import vm from 'node:vm';
import { isPlainObject } from '@jsopen/objects';
import type { ConfigScope } from '../../interfaces/config-scope.interface.js';
import type { Resolved } from '../../interfaces/rman-config.interface.js';
import { CODE_SUBTREES, STEP_PATHS } from './config-paths.js';
import { ORIGINS, PREVIOUS_VALUES, type PreviousValue } from './merge-config.js';

/**
 * Resolves a config's values - every `${{ ... }}` expression and every value function - against a
 * scope.
 *
 * Where `ConfigReader` answers *what the files say*, this answers *what those words evaluate to*.
 * It takes a `ConfigScope` rather than a package, so whoever holds the repository builds the scope;
 * `Repository.configScope` is that today.
 *
 * Two passes: {@link interpolate} resolves everything the scope can answer now, and
 * {@link resolveDeferred} resolves what `defer(...)` left for later.
 */
/* The split from `ConfigReader` is a matter of lifetime rather than tidiness: reading happens per
 * directory, before any package exists, while `pkg`, `repository`, `file` and `git` only exist
 * afterwards. One class holding both would have a method that throws when called in the wrong
 * order.
 *
 * **A `ConfigScope` rather than a `Package`** keeps this file free of `core/package.ts` - `core/`
 * has a recorded history of fatal ESM cycles (`core/config` reaching into `plugins/` broke the
 * built CLI on every command while the suite stayed green). Whoever builds the scope owns the
 * measured subtleties in doing so: property descriptors rather than a spread, so `git`'s lazy
 * getter does not shell out on a config that never mentions git, and `pkg.targetVersion` staying a
 * non-enumerable throwing getter.
 *
 * **Every step is a `protected` method**, so a subclass can replace one and a spec can stub it. As
 * module-level functions none of them would be reachable from outside this file. */
export class ConfigInterpolator {
  /** How long one expression may run, in milliseconds. Raise it for a repository with genuinely
   *  slow `read()` calls. */
  /* Guards against an expression that never returns (`while(true)`) taking the whole command with
   * it - a typo rather than an attack, but the failure mode is identical. */
  protected readonly expressionTimeout: number = 1000;

  /** The file the key being walked was written in, for an error message to name. */
  /* A config is merged from several files before anything reads it, so `version.commitMessage`
   * alone does not say where to go and look. `mergeConfig` records the file per key (`ORIGINS`);
   * this is the depth-first cursor over that, kept as a field rather than threaded through every
   * signature because every error site would otherwise carry a parameter it only passes on.
   *
   * **An instance field, where it used to be a module variable** - a module variable is shared by
   * every interpolation in the process, so a failed walk left its cursor behind for the next one. */
  protected currentOrigin: string | undefined;

  /** How many `defer(...)` calls have been rewritten so far. */
  /* `_walk` compares it before and after a key to learn whether anything under that key deferred,
   * which is what `DEFERRED` records - see `resolveDeferred`. */
  protected deferCount = 0;

  /**
   * Pass one: resolves everything the scope can answer now, and leaves `defer(...)` for
   * {@link resolveDeferred}.
   *
   * A string that is *nothing but* one expression keeps that value's own type -
   * `"${{ pkg.private }}"` is a boolean, not the word `true`. Embedded in surrounding text it is
   * stringified, and a nullish result there is an error rather than the word `undefined`.
   *
   * Returns `Resolved<T>`: every value function has been called, so they are gone from the type.
   */
  /* The sole-expression rule is what makes a boolean setting like `run.<script>.skip` reachable
   * from an expression at all - without it this could only ever produce strings.
   *
   * `Resolved<T>` is what lets a reader hold a resolved config with no cast anywhere between. */
  interpolate<T>(args: ConfigInterpolator.InterpolateArgs<T>): Resolved<T> {
    const { config, scope } = args;
    const base = args.at ?? [];
    const skip = args.skip ?? [];
    const context = this._createContext(scope);

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return this._walk(config, scope, context, base, skip) as Resolved<T>;
    }

    /**
     * The config's own top-level keys, readable bare: `${{ changelog.filePath }}`. So a value that
     * restates another stops being a second copy that drifts.
     *
     * Resolved **on demand**, one key at a time, and memoized. Interpolating in tree order and
     * handing an expression whatever happened to be ready would make the answer depend on key order
     * in the file - a key declared above reading as resolved and one below as raw.
     */
    const resolved = new Map<string, unknown>();
    const resolving: string[] = [];
    /**
     * A cycle is **recorded here rather than thrown from the getter**: a host getter that throws
     * inside a `vm` property interceptor has its exception swallowed, and V8 then reports the
     * global as absent - so a self-referencing key came out as `publish is not defined`, sending
     * the reader after a missing key instead of a loop.
     */
    let cycle: Error | undefined;
    const deferredKeys: Record<string, true> = {};

    const resolve = (key: string): unknown => {
      if (resolved.has(key)) return resolved.get(key);
      if (resolving.includes(key)) {
        cycle ??= new Error(
          `Config expression forms a cycle: ${[...resolving, key].join(' -> ')}\n` +
            `  A value cannot be derived from itself, directly or through another key.`,
        );
        return undefined;
      }
      resolving.push(key);
      const before = this.deferCount;
      try {
        const chain = (config as Record<symbol, unknown>)[PREVIOUS_VALUES] as Record<string, PreviousValue> | undefined;
        const origins = (config as Record<symbol, unknown>)[ORIGINS] as Record<string, string> | undefined;
        const value = this._withOrigin(origins?.[key], () =>
          this._walkWithPrevious(
            (config as Record<string, unknown>)[key],
            chain?.[key],
            scope,
            context,
            [...base, key],
            skip,
          ),
        );
        if (this.deferCount > before) deferredKeys[key] = true;
        resolved.set(key, value);
        return value;
      } catch (e: any) {
        /** Not cleared: a cycle aborts the whole interpolation, and each level up would otherwise
         *  re-swallow its own replacement - leaving it set lets the outermost frame report it. */
        if (cycle) throw new Error(`${String(e?.message).split('\n')[0]}\n  ${cycle.message}`, { cause: e });
        throw e;
      } finally {
        resolving.pop();
      }
    };

    for (const key of Object.keys(config)) {
      /** A scope binding wins: `pkg`/`repository`/`env`/`semver` are not config keys, so nothing
       *  collides today, and a future key that did must not silently take over the namespace. */
      if (key in scope || !IDENTIFIER.test(key)) continue;
      Object.defineProperty(context, key, { enumerable: true, configurable: true, get: () => resolve(key) });
    }

    /** Built through the same memo the getters use, so every key is walked exactly once whether an
     *  expression asked for it first or the result did. */
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(config)) result[key] = resolve(key);
    this._markDeferred(result, deferredKeys);
    return result as Resolved<T>;
  }

  /**
   * Pass two: resolves what pass one deferred, against a scope that can now answer it.
   *
   * `version` is the case it exists for - `${{ defer(pkg.targetVersion) }}` in a `version` hook
   * names a version that does not exist while the config is being read.
   *
   * Only the keys pass one marked are walked; a `${{` that arrived any other way is left exactly as
   * it is. A string handed over on its own has no containing object to carry a mark, so it is
   * interpolated outright - the caller passing one has already decided.
   */
  /* **Walking marks rather than scanning for `${{` is the whole safety of running twice.** Pass
   * one's output legitimately contains `${{` in cases that have nothing to do with `defer`: the
   * documented way to emit a literal is `${{ '${{' }}` (a `helm template --set tag=...` line needs
   * it), and `read()` can return a string holding one. Scanning would execute both. */
  resolveDeferred<T>(args: ConfigInterpolator.ResolveDeferredArgs<T>): T {
    const context = this._createContext(args.scope);
    return this._walkDeferred(args.config, context, args.at ?? []) as T;
  }

  /** Whether anything under `config` is waiting for {@link resolveDeferred} - `false` for every
   *  config that never writes `defer(...)`, so the second pass can be skipped. */
  hasDeferred(config: unknown): boolean {
    if (!isPlainObject(config)) return false;
    return (config as Record<symbol, unknown>)[DEFERRED] !== undefined;
  }

  /** The V8 context an expression is evaluated in - a clean scope holding only `scope`'s bindings. */
  /* **Built from `scope`'s property descriptors, never `{ ...scope }`.** A spread reads every
   * property, so a lazy getter on the scope stops being lazy the moment one is added - and `git` is
   * exactly that: it shells out to `git rev-parse`, and a spread here would do it on `rman list`,
   * `rman info` and every other command, in a repository whose config never mentions git. Measured
   * both ways on one build: 0 git reads with descriptors, 1 with a spread.
   *
   * A clean scope, **not a sandbox** - `node:vm` is explicitly not a security mechanism, and none is
   * called for: a config that can say `exec: "..."` already runs arbitrary shell, so the expression
   * evaluator adds no trust boundary that was not already wide open. */
  protected _createContext(scope: ConfigScope): vm.Context {
    return vm.createContext(Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)));
  }

  protected _walk(value: unknown, scope: ConfigScope, context: vm.Context, at: Path, skip: string[]): any {
    /** Compared on the key path rather than the value, so a skipped key's whole subtree - a single
     *  command or an array of them - is handed on untouched. */
    if (at.length && skip.includes(at.filter(p => typeof p === 'string').join('.'))) return value;

    if (typeof value === 'function') {
      /** Code, not a value: a step for `run`/`version` to call in its own time, or a plugin's own
       *  function. Calling it here would run build-time work while merely *loading* the repository,
       *  which is the whole distinction the function form exists to draw. */
      if (this._isCodePath(at)) return value;
      return this._callValueFn(value as (arg: unknown) => unknown, context, at);
    }
    if (typeof value === 'string') return this._interpolateString(value, context, at);
    if (Array.isArray(value)) return value.map((item, i) => this._walk(item, scope, context, [...at, i], skip));

    if (value && typeof value === 'object') {
      const chain = (value as Record<symbol, unknown>)[PREVIOUS_VALUES] as Record<string, PreviousValue> | undefined;
      return this._withScopedVars(value as Record<string, unknown>, scope, context, at, skip, () => {
        const result: Record<string, unknown> = {};
        const origins = (value as Record<symbol, unknown>)[ORIGINS] as Record<string, string> | undefined;
        const deferredKeys: Record<string, true> = {};
        for (const [key, item] of Object.entries(value)) {
          const before = this.deferCount;
          result[key] = this._withOrigin(origins?.[key], () =>
            this._walkWithPrevious(item, chain?.[key], scope, context, [...at, key], skip),
          );
          if (this.deferCount > before) deferredKeys[key] = true;
        }
        this._markDeferred(result, deferredKeys);
        return result;
      });
    }
    return value;
  }

  /**
   * Runs `body` with `vars` scoped to this node: a fresh copy at every level, with the node's own
   * `vars` block - if it declares one - merged **per key** over what the level above resolved to,
   * so redeclaring one var keeps the rest.
   *
   * The node's own block is resolved against the outer scope before being installed, so
   * `vars: { out: '${{ vars.x }}/dist' }` refines the `x` it inherits rather than reading itself.
   */
  /* **Copied at every node, not only where a `vars` block appears**, and that is the difference
   * between scoping and leaking: a value function is handed this object, so one that writes to it
   * must not be writing into the level above. */
  protected _withScopedVars<T>(
    node: Record<string, unknown>,
    scope: ConfigScope,
    context: vm.Context,
    at: Path,
    skip: string[],
    body: () => T,
  ): T {
    /**
     * **A `vars` block does not scope itself.** Resolving one walks its own values, and without
     * this that walk asks for the scope it is in the middle of producing - which the cycle guard
     * catches and reports as `vars -> vars`. It recovered, but left the cycle *flag* set, and the
     * next genuine error in that key came out wearing `Config expression forms a cycle`.
     */
    if (at.some(segment => segment === VARS_KEY)) return body();

    const outer = context[VARS_KEY] as Record<string, unknown> | undefined;
    const own = node[VARS_KEY];
    /** Nothing to shadow and nothing to protect: a node with no object below it can hold no
     *  function either, so the copy would be pure cost. */
    if (own === undefined && !hasObjectChild(node)) return body();

    const resolvedOwn = own === undefined ? undefined : this._walk(own, scope, context, [...at, VARS_KEY], skip);
    const scoped = { ...outer, ...(isPlainObject(resolvedOwn) ? resolvedOwn : undefined) };

    const previous = Object.getOwnPropertyDescriptor(context, VARS_KEY);
    Object.defineProperty(context, VARS_KEY, { value: scoped, enumerable: true, configurable: true, writable: true });
    try {
      return body();
    } finally {
      if (previous) Object.defineProperty(context, VARS_KEY, previous);
      else delete context[VARS_KEY];
    }
  }

  /**
   * Walks one key with `value` bound to what the layers underneath resolved to.
   *
   * Always bound, even with nothing underneath - see {@link _previousValue} for what it is then.
   * The chain resolves bottom-up, so a layer deriving from a layer that itself derived from
   * something is handed the finished value rather than a half-resolved expression.
   */
  /* Left unbound, an expression naming `value` fails with V8's `value is not defined`, which reads
   * as "there is no such thing" rather than "nothing below this layer set it" - two different
   * mistakes needing two different fixes. */
  protected _walkWithPrevious(
    item: unknown,
    previous: PreviousValue | undefined,
    scope: ConfigScope,
    context: vm.Context,
    at: Path,
    skip: string[],
  ): unknown {
    const resolved = this._previousValue(
      previous === undefined
        ? undefined
        : this._walkWithPrevious(previous.value, previous.previous, scope, context, at, skip),
      at,
    );

    const outer = Object.getOwnPropertyDescriptor(context, VALUE_KEY);
    /** A getter, so the catch below can tell whether the value **actually read `value`**: the hint
     *  is irrelevant to any other failure, and attaching it anyway is the send-the-reader-to-the-
     *  wrong-place mistake it exists to prevent. Recorded, never matched on V8's wording. */
    let wasRead = false;
    Object.defineProperty(context, VALUE_KEY, {
      configurable: true,
      enumerable: true,
      get: () => {
        wasRead = true;
        return resolved;
      },
    });
    try {
      return this._walk(item, scope, context, at, skip);
    } catch (e: any) {
      if (wasRead && isUnsetValue(resolved) && !e?.rmanValueHint) {
        e.rmanValueHint = true;
        e.message = `${e.message}\n  Note: nothing below this layer sets "${this._describeAt(at)}, so \`value\` is empty.`;
      }
      throw e;
    } finally {
      if (outer) Object.defineProperty(context, VALUE_KEY, outer);
      else delete context[VALUE_KEY];
    }
  }

  /**
   * Whether a function at `at` is **code** - a step to run later, or part of a plugin - rather than
   * a value to compute now.
   *
   * Array indices are dropped before matching, so a function inside a *list* of steps is still a
   * step; `*` in a `STEP_PATHS` entry matches any one segment (`run.<script>.exec`).
   */
  protected _isCodePath(at: Path): boolean {
    const segments = at.filter((p): p is string => typeof p === 'string');
    if ((CODE_SUBTREES as readonly string[]).includes(segments[0]!)) return true;
    return STEP_PATHS.some(pattern => {
      const parts = pattern.split('.');
      return parts.length === segments.length && parts.every((part, i) => part === '*' || part === segments[i]);
    });
  }

  /**
   * Calls a **value** function: the JS spelling of a `${{ }}` expression, answering the same
   * question at the same moment.
   *
   * It is handed one object carrying everything an expression can name, plus `value` - what this
   * key resolved to in the layers underneath.
   *
   * A value function **computes and returns; it must never act.** This runs while the config
   * resolves, which *every* command does - so one that writes a file writes it on `rman list`,
   * `rman info` and `rman config` too, once per package, with nothing having asked. Work goes in a
   * step.
   */
  /* The argument is built with the interpolation context as its **prototype**, not copied from it.
   * The top-level keys are lazy memoized getters; spreading them into a new object would fire every
   * one on every call, including the ones a function never reads - and one of those throwing would
   * blame the wrong key. */
  protected _callValueFn(fn: (arg: unknown) => unknown, context: vm.Context, at: Path): unknown {
    /** `value` arrives through the prototype, bound by `_walkWithPrevious` for exactly this key -
     *  so nothing here may *read* it. Passing it in as an argument did, which tripped the "was it
     *  read" getter before the function ran and put the `value` hint on every unrelated failure. */
    const arg = Object.create(context);
    try {
      return fn(arg);
    } catch (e: any) {
      throw new Error(`Config function in "${this._describeAt(at)} failed: ${e?.message}`, { cause: e });
    }
  }

  protected _interpolateString(value: string, context: vm.Context, at: Path): unknown {
    if (!value.includes('${{')) return value;
    const found = [...value.matchAll(EXPRESSION)];
    if (!found.length) return value;
    /** Counted rather than matched with an anchored `^...$` regex: a lazy quantifier still
     *  backtracks to satisfy an end anchor, so `"${{ a }} and ${{ b }}"` looked like *one*
     *  expression whose body ran from `a` to `b`, brace-ends and all - invalid JavaScript. */
    const soleExpression = found.length === 1 && found[0]![0] === value.trim();
    // Alone, a nullish result is just "this setting is unset" - a legitimate answer.
    if (soleExpression) return this._evaluate(found[0]![1]!, value, context, at);
    return value.replace(EXPRESSION, (_, expr: string) => {
      const result = this._evaluate(expr, value, context, at);
      /** Embedded in text it never is: splicing in the word "undefined" produces a path or tag like
       *  `app:undefined` that looks plausible and is wrong - the exact silent-mistake shape this
       *  evaluator exists to avoid. `?? 'fallback'` says what was meant. */
      if (result === undefined || result === null) {
        throw new Error(
          `Expression in "${this._describeAt(at)} is ${result} inside a string: ${value.trim()}\n` +
            `  \${{${expr}}} has no value here - give it a fallback (\${{${expr.trim()} ?? '...'}}).`,
        );
      }
      return String(result);
    });
  }

  /** Evaluates one expression, rewriting any `defer(...)` in it first. A failure names the config
   *  path and the expression. */
  /* Naming the path matters: an error saying only "x is not defined" sends the reader hunting
   * through a file that may hold dozens of them. */
  protected _evaluate(expr: string, source: string, context: vm.Context, at: Path): unknown {
    const prepared = this._rewriteDefer(expr, source, at);
    try {
      return vm.runInContext(prepared, context, { timeout: this.expressionTimeout });
    } catch (e: any) {
      throw new Error(`Invalid expression in "${this._describeAt(at)}: ${source.trim()}\n  ${e?.message ?? e}`, {
        cause: e,
      });
    }
  }

  /**
   * Turns `defer(<inner>)` into a string literal holding `${{ <inner> }}`, so the expression around
   * it resolves now and the deferred part survives as an expression for pass two.
   *
   * ```
   * '_' + defer(pkg.targetVersion) + '-' + pkg.name
   * '_' + "${{ pkg.targetVersion }}" + '-' + pkg.name     // rewritten
   * _${{ pkg.targetVersion }}-mypackage                   // evaluated
   * ```
   *
   * `defer` is a marker the source is rewritten around, not a function in scope - so
   * `defer(() => x)` is not a thing to write. A nested `defer` is refused.
   */
  /* **Why a source rewrite rather than a function.** JavaScript evaluates arguments first, so
   * `defer(pkg.targetVersion)` would read `pkg.targetVersion` - a *throwing* getter until `version`
   * binds it - before `defer` ran. A function also only ever receives its argument's value, never
   * the source text that has to survive.
   *
   * **The closing parenthesis is found by asking V8, not by counting.** `defer(x ? ')' : y)` and
   * `defer(read('a)b.json').v)` both hold a `)` that closes nothing, and a hand-rolled scanner has
   * to know about strings, template literals and regex literals to see that. Each candidate span is
   * handed to the parser instead, and the first that parses is the answer - correct by construction,
   * since the parser is the authority on what is a complete expression. The same family of mistake
   * is already recorded here for `${{ }}` itself, where an anchored regex backtracked across two
   * expressions. */
  protected _rewriteDefer(expr: string, source: string, at: Path): string {
    if (!DEFER_TOKEN.test(expr)) return expr;

    /**
     * **A fresh `/g` regex per call, never a shared one.** A global regex carries `lastIndex`
     * between uses, so one that throws mid-scan leaves it set and the *next* expression is searched
     * from the middle - measured here: a case that refused a malformed `defer()` left the cursor
     * behind, and the following `${{ defer(pkg.x) }}` was not recognized at all and reached V8 as
     * `defer is not defined`. `DEFER_TOKEN` itself is deliberately not global for the same reason.
     */
    const token = new RegExp(DEFER_TOKEN.source, 'g');

    let out = '';
    let cursor = 0;
    for (let match = token.exec(expr); match; match = token.exec(expr)) {
      const open = match.index + match[0].length; // first character inside the parentheses
      const inner = this._findDeferArgument(expr, open, source, at);
      out += expr.slice(cursor, match.index) + match[1];
      out += JSON.stringify(`\${{ ${inner.trim()} }}`);
      cursor = open + inner.length + 1; // past the closing parenthesis
      token.lastIndex = cursor;
      this.deferCount++;
    }
    return out + expr.slice(cursor);
  }

  /** The text between `defer(` and the parenthesis that closes it. */
  /* The parser decides where that is rather than a counter - see `_rewriteDefer`. */
  protected _findDeferArgument(expr: string, open: number, source: string, at: Path): string {
    for (let end = expr.indexOf(')', open); end !== -1; end = expr.indexOf(')', end + 1)) {
      const inner = expr.slice(open, end);
      try {
        new Function(`return (${inner})`);
      } catch {
        continue;
      }
      /**
       * **A nested `defer` is refused rather than half-handled** - it would need a third pass and
       * means nothing anyone has asked for.
       *
       * There is deliberately no check for `}}` inside the argument, though it would close the
       * expression being written: it cannot arrive. `EXPRESSION` is non-greedy, so `${{ }}` has
       * already been cut at the first `}}` long before this sees the text - which is a limitation of
       * the delimiter itself and has nothing to do with `defer`.
       */
      if (DEFER_TOKEN.test(inner)) {
        throw new Error(`Nested defer() in "${this._describeAt(at)}: ${source.trim()}`);
      }
      return inner;
    }
    throw new Error(`Unclosed defer() in "${this._describeAt(at)}: ${source.trim()}`);
  }

  /** Records which of `node`'s keys deferred, invisibly to anything but pass two. */
  /* **Non-enumerable**, like `ORIGINS` and `PREVIOUS_VALUES`: `expect`'s `toEqual` compares symbol
   * properties, and `js-yaml` and `JSON.stringify` would otherwise carry it into `rman config`. */
  protected _markDeferred(node: Record<string, unknown>, keys: Record<string, true>): void {
    if (!Object.keys(keys).length) return;
    Object.defineProperty(node, DEFERRED, { value: keys, enumerable: false, configurable: true });
  }

  /** Pass two's walk: only the keys pass one marked, so a `${{` that arrived from anywhere else is
   *  left exactly as it is. */
  protected _walkDeferred(value: unknown, context: vm.Context, at: Path): unknown {
    if (typeof value === 'string') return this._interpolateString(value, context, at);
    if (Array.isArray(value)) return value.map((item, i) => this._walkDeferred(item, context, [...at, i]));
    if (!isPlainObject(value)) return value;

    const marks = (value as Record<symbol, unknown>)[DEFERRED] as Record<string, true> | undefined;
    if (!marks) return value;
    const result: Record<string, unknown> = { ...value };
    for (const key of Object.keys(marks)) {
      result[key] = this._walkDeferred(value[key], context, [...at, key]);
    }
    return result;
  }

  protected _withOrigin<T>(origin: string | undefined, body: () => T): T {
    const outer = this.currentOrigin;
    if (origin !== undefined) this.currentOrigin = origin;
    try {
      return body();
    } finally {
      this.currentOrigin = outer;
    }
  }

  /** `"version.commitMessage" (.rmanrc.yml)`, or just the path when nothing recorded a file. The
   *  file is relative to the working directory when it sits inside it. */
  protected _describeAt(at: Path): string {
    const where = at.length ? formatPath(at) : 'the config root';
    return this.currentOrigin ? `${where}" (${shortenOrigin(this.currentOrigin)})` : `${where}"`;
  }

  /**
   * What a layer deriving from the one below it reads as `value`.
   *
   * Spreads as empty when nothing below set the key, so `[...value, 'x']` needs no guard. Used as a
   * string or a number it throws, naming the key and what to write instead.
   */
  /* The empty case is not exotic: a value written to extend an inherited list is also the *first*
   * layer in a repository that inherits nothing.
   *
   * Refusing to become a string or a number is a correction to an older `undefined`: `undefined + 1`
   * is `NaN`, which serialized to `null` and read like a configured value. */
  protected _previousValue(raw: unknown, at: Path): unknown {
    /** Never a list, and unfixable as one. */
    if (typeof raw === 'boolean') return raw;
    const list = raw === undefined ? [] : Array.isArray(raw) ? [...raw] : [raw];
    Object.defineProperty(list, UNSET_MARKER, { value: raw === undefined });
    return Object.defineProperty(list, Symbol.toPrimitive, {
      value: (hint: string) => {
        if (raw === undefined) {
          throw this._unusable(at, 'nothing below this layer sets it, so it is empty', "`value ?? ''`, `value ?? 0`");
        }
        if (typeof raw !== 'string' && typeof raw !== 'number') {
          throw this._unusable(
            at,
            `the layer below it is ${Array.isArray(raw) ? 'a list' : 'an object'}`,
            '`value.join(", ")` for a list',
          );
        }
        return hint === 'string' ? String(raw) : raw;
      },
    });
  }

  /** The one sentence both `value` refusals share: what was asked for, why it cannot be done, what
   *  to write instead. */
  /* Marked `rmanValueHint` so `_walkWithPrevious`'s catch leaves it alone - that note exists to
   * explain an empty `value` to an error that does not mention it, and this error *is* that
   * explanation. */
  protected _unusable(at: Path, because: string, instead: string): Error {
    const error: any = new Error(
      `\`value\` cannot be used as a string or a number here - ${because}, for "${this._describeAt(at)}. ` +
        `It spreads as a list (\`[...value, x]\`); to use it as something else, say what it should be - ${instead}.`,
    );
    error.rmanValueHint = true;
    return error;
  }
}

/** Where a value sits in the config, as the walk builds it up - a string key or an array index.
 *  A module-level type rather than a member of the namespace below, so the class's own signatures
 *  can name it without shadowing the namespace's copy of the name. */
type Path = (string | number)[];

export namespace ConfigInterpolator {
  export interface InterpolateArgs<T = unknown> {
    /** The config, or a fragment of it. */
    config: T;
    /** Everything an expression can name: `pkg`, `repository`, `file`, `env`, `semver`, `path`,
     *  `git`. Built by whoever holds the repository - see the class doc for why it is not a
     *  `Package`. */
    scope: ConfigScope;
    /**
     * Where `config` sits in the whole config, for a caller handing over a **fragment**.
     *
     * Optional in the type and required in practice for a fragment: the path is what decides
     * whether a function is a value to compute or a step to leave alone (`STEP_PATHS`). Without it
     * a fragment starts at the root and matches nothing, so a function in a `version` hook was
     * called while the hook was being *prepared* - it failed inside the user's own code with
     * `path.join` receiving undefined.
     */
    at?: Path;
    /** Config paths to leave entirely untouched, subtree and all. */
    skip?: string[];
  }

  export interface ResolveDeferredArgs<T = unknown> {
    /** What `interpolate` returned - the marks it left are what this walks. */
    config: T;
    /** The scope with whatever pass one could not bind, `pkg.targetVersion` being the case this
     *  exists for. */
    scope: ConfigScope;
    at?: Path;
  }
}

/** `${{ ... }}`, deliberately not `{{ ... }}`: a config value may legitimately carry `{{...}}` meant
 *  for something else (`helm template --set tag={{.Values.tag}}`), and with the plainer delimiter
 *  rman would try to evaluate it. Non-greedy, and never used with an end anchor - see
 *  `_interpolateString`. */
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

/** `defer(` as a *token*: preceded by nothing that would make it a property (`x.defer(`) or part of
 *  a longer name (`mydefer(`). Group 1 is that preceding character, put back by the rewrite.
 *
 *  **Not global**, so `.test()` on it carries no `lastIndex` between calls; `_rewriteDefer` builds
 *  its own `/g` copy for the one scan that needs one. */
const DEFER_TOKEN = /(^|[^A-Za-z0-9_$.])defer\s*\(/;

/** A config key readable bare inside an expression has to be a valid identifier - `"[*]"` is not. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The one key that scopes rather than configures. Reserved at **every** level, which costs a
 *  script that would have been called `vars`: `run.vars` is a scope, not a script. */
const VARS_KEY = 'vars';

/** What a layer deriving from the one below it reads. */
const VALUE_KEY = 'value';

/** Marks that a layer set nothing - by the marker `_previousValue` puts on it, never by emptiness,
 *  since a layer may legitimately resolve to `[]`. */
const UNSET_MARKER = Symbol('rman.valueUnset');

/** Which of an object's keys hold something `defer(...)` left for pass two. */
const DEFERRED = Symbol('rman.deferred');

function isUnsetValue(value: unknown): boolean {
  return Array.isArray(value) && (value as any)[UNSET_MARKER] === true;
}

function hasObjectChild(node: Record<string, unknown>): boolean {
  for (const item of Object.values(node)) {
    if (typeof item === 'function') return true;
    if (item && typeof item === 'object') return true;
  }
  return false;
}

function formatPath(at: Path): string {
  return at.reduce<string>(
    (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : String(part)),
    '',
  );
}

function shortenOrigin(file: string): string {
  const relative = nodePath.relative(process.cwd(), file);
  return !relative.startsWith('..') && !nodePath.isAbsolute(relative) ? relative : file;
}
