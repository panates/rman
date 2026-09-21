import type * as yargs from 'yargs';
import type { RmanApplication } from '../core/application.js';
import type { RmanPlugin } from '../core/plugin.js';
import type { RunConditionFn, RunStepValue } from '../core/run-step.js';

/**
 * The shape of `.rmanrc`/`.rmanrc.yml`/`.rmanrc.cjs`/`.mjs`/`.js` (and `package.json`'s own
 * `"rman"` key) - see docs/rman.md#configuration-rmanrc-rmanrcyml for the full reference. Every
 * field is optional and cascades from the repository root down to each package's own directory.
 * Purely a typing aid - never read by rman itself, which only ever sees the plain JS object a
 * config file exports.
 *
 * **Two halves, and the split is who declares a key.** `RmanConfigKeys` holds the ones no command
 * owns; `CommandConfigs` is what every command contributes its own into, from beside the command
 * (see `CommandContribution`). This used to be two files and two types both called `RmanConfig` -
 * one for the config shape, one for the command declarations - which is why the package could not
 * export the second at all.
 */
export interface RmanConfig
  extends
    RmanConfigKeys,
    WithAppend<RmanConfigKeys>,
    RmanConfig.CommandConfigs,
    /** **Both clauses, or a contributed key loses its append form.** `WithAppend` maps over what it
     *  is given, so mapping `RmanConfigKeys` alone stopped generating `+version`/`+publish` the
     *  moment those keys moved out of it - caught by `config.spec.ts`'s type-level pin, which is
     *  the only thing that looks. */
    WithAppend<RmanConfig.CommandConfigs> {
  /**
   * Configs to inherit from, merged **underneath** this one - a shared package
   * (`"@panates/rman-monorepo"`), a relative path, or an array applied in declaration order.
   *
   * A bare name resolves through *this* file's own `node_modules`, so a subpath works too. The
   * target may be YAML, JSON, or a module exporting a config via `defineConfig`, and may itself
   * `extends` another.
   *
   * Top level only: a `"[selector]"` block naming one is an error rather than a no-op, since
   * inheritance is a statement about this config and not about the packages a selector names.
   */
  extends?: string | string[];
}

/**
 * **The `.rmanrc` keys no command owns**, without the `+key` append forms or `extends` - kept
 * separate from `RmanConfig` only so `WithAppend` has something to map over. A key a *command* owns
 * is declared beside that command and arrives through `RmanConfig.CommandConfigs` instead.
 *
 * **A plugin adds its own keys here, by declaration merging** - `rman-node` contributes `clean`
 * from its own `interfaces/rman-config.interface.ts`, so `pkg.config.clean` stays typed wherever it
 * is read without the core having to know npm has a `node_modules` or that TypeScript has build
 * output. `WithAppend` is a mapped type evaluated at use, so an augmented key gets its `+key` form
 * too. (A *target's* block is different again: `publish.npm.*` goes through the
 * `PublishTargetConfigs` slot, beside the core's own `publish.docker.*`.)
 *
 * A config author annotates with the plugin's own name for the union - `RmanNodeConfig` - which is
 * what makes the import that carries the augmentation explicit rather than incidental.
 */
export interface RmanConfigKeys {
  /**
   * Plugins to load, in declaration order - a *package* contributing commands, where `.rman/*.mjs`
   * contributes one repository's own.
   *
   * Each entry is **either a package name (or path) to import, or a plugin object itself**:
   *
   * ```yaml
   * # .rmanrc.yml - imported by name, resolved through the repository's own node_modules
   * plugins: ['rman-node']
   * ```
   *
   * ```js
   * // .rmanrc.mjs - or handed over directly, which a JS config can do and a YAML one cannot
   * import { defineConfig, definePlugin } from 'rman';
   * export default defineConfig({ plugins: [definePlugin({ name: 'mine', commands: [...] })] });
   * ```
   *
   * The object form is what lets a **plugin package export a config** rather than a single plugin:
   * `rman-node`'s entry point is `export default defineConfig({ plugins: [ ... ] })`, so it is an
   * `.rmanrc` like any other and is free to grow a second plugin without changing its shape. When an
   * imported module exports a config this way, **only its `plugins` are read** - a config's other
   * keys reach a repository through `extends`, which is the key that means "merge this underneath
   * mine".
   *
   * This is how everything that only means something in a Node repository lives outside rman's
   * core. A plugin that cannot be loaded is an error, not a skip: silently losing `rman publish` is
   * worse than not starting.
   *
   * Root level only - which commands exist is a property of the repository, not of a package.
   */
  plugins?: string | RmanPlugin | (string | RmanPlugin)[];

  /**
   * Where this repository keeps command modules of its own - a glob, or a list of them.
   *
   * ```yaml
   * commands: ['tools/commands/*.mjs']
   * ```
   *
   * **The easy half of `plugins`.** A package contributing a tech stack, a publish target or a
   * version planner needs a plugin; a repository that just wants a command of its own should not
   * have to write one. `.rman/*.mjs` is simply this key's default value rather than a second
   * mechanism beside it - one source of repository-level commands, one precedence slot.
   *
   * **A relative glob is anchored to the file that declared it**, not to the repository root (see
   * `anchorCommands`), so a shared config can ship commands with `commands: './commands/*.js'` and
   * have it mean its own directory. `plugins` does *not* behave this way, deliberately noted here
   * because the two look alike.
   *
   * **Always appends** (`ALWAYS_APPEND`), like `plugins` and for the same reason: naming a
   * directory of your own never means "and stop loading the ones my shared config ships". It
   * follows that a closer layer cannot *un*-say one.
   *
   * Declared at any level, and every level's globs are loaded - which is what makes it useful in a
   * package's own `.rmanrc`. The commands themselves are still repository-wide, because there is
   * one command list; a package declaring one is contributing it to the repository.
   *
   * A module exports either form: the declarative `app => ({ ... })` a plugin would use, or the
   * `defineCommand({ ... })` object. **`.ts` is not loadable** - rman imports these in its own
   * process, with no loader registered - so a TypeScript repository compiles them first or writes
   * them as `.mjs`.
   */
  commands?: string | string[];

  /**
   * Values for `${{ vars.* }}` to read - a name for something the config would otherwise repeat:
   *
   * ```yaml
   * vars:
   *   outDir: build
   *   image: 'panates/${{ pkg.basename }}'
   * "[*]":
   *   publish:
   *     directory: '${{ vars.outDir }}'
   * ```
   *
   * Any shape, and the values may themselves be expressions - they are evaluated for the package
   * reading them, so one `vars.image` gives each package its own.
   *
   * **The one unmarked key that reaches every package**, rather than only the package of the
   * directory declaring it. A package (or a `"[selector]"` block) overrides it **per key**, so
   * redefining one var keeps the rest.
   */
  vars?: Record<string, unknown>;
  logLevel?: 'silent' | 'error' | 'info' | 'verbose';
  allowBranch?: string | string[];
  ignoreBranch?: string | string[];
  /**
   * Leave this package alone: **every command that acts on packages skips it** - `run`/`build`/
   * `test`, `exec`, `clean`, `publish`, `version`, `changelog`. Per-package cascaded, so a root
   * `"[selector]"` block can say it for several at once.
   *
   * One standing statement rather than a `skip` invented per command, which is what it was: three
   * separate keys carried it and none of them meant quite the same thing. The finer-grained ones
   * remain for when only one command should stop - `run.<script>.skip` for a single script,
   * `publish.skip` for "never distributed, by any target" (which `changelog` reuses on purpose).
   *
   * **The commands that *report* deliberately ignore it** - `list` still shows the package, because
   * it is still in the repository and an inventory hiding part of one is answering a different
   * question. `changed` follows `version`, since its whole job is to say what `version` would do.
   */
  skip?: boolean;
  group?: boolean | string;
  /** Keyed by npm script name (e.g. `"build"`, `"lint"`, `"test"`). A bare string (or array of
   *  them) is shorthand for `{ exec: ... }` - `test: "mocha"` and `test: { exec: "mocha" }` mean
   *  exactly the same thing, and a bare function is the same shorthand for a function step. */
  run?: RmanConfig.RunConfig;
  /**
   * In-repo packages this one depends on **beyond what its own manifest declares** - purely for
   * rman's own dependency graph (topo-sort, `--deps`/`--dependents`, `run`'s scheduling, the version
   * cascade). Declared from the root via a selector (`"[pkg-a]": { dependencies: [...] }`) or in the
   * package's own `.rmanrc`.
   *
   * Each entry is a package **name, or a repository-relative directory** - tried in that order. The
   * path form is not a convenience: a name identifies a package only where the ecosystem guarantees
   * uniqueness, which npm does and others do not, while a directory is unique by construction. It is
   * the same reason `Workspace.Layout` carries paths and `Package.dependencies` holds references
   * rather than names.
   *
   * **A list, and only a list.** It used to accept a `Record<string, string>` too, documented as "an
   * explicit name -> range map" - and the ranges went nowhere: the one reader took `Object.keys` and
   * dropped the values. Nor could they ever mean anything here, since the cascade works from groups
   * and severities, and `ManifestProvider.updateDependencyVersions` rewrites ranges in the
   * *manifest* - a range declared only in `.rmanrc` has no file to be written to. What this key
   * states is an **edge**, and an edge needs two ends and nothing else.
   *
   * **Core, and it has to be**: it is layered on top of whatever `ManifestProvider.dependencies`
   * read, and it is the *only* way a repository with no provider at all has a graph - a repo whose
   * manifests rman cannot read can still state its edges by hand. Moving it to an ecosystem plugin
   * would take that away from exactly the repositories that need it.
   */
  dependencies?: string[];
  /**
   * Config for a **narrower audience**, keyed by a `"[selector]"` naming it - `"[/]"` for the root
   * package alone, `"[*]"` for the packages below this directory, `"[*-dialect]"` for a glob over
   * their names, `"[pkg-a]"` for one. Everything else in this object reaches this directory *and*
   * every package under it, so a selector is how a statement stops being everyone's.
   *
   * A glob never matches the root, which is nobody's child - so a package-shaped setting cannot
   * reach a root that has no package directory to apply it to, and `"[/]"` is the only way to
   * address the root.
   *
   * ```yaml
   * # the repository root's own .rmanrc.yml
   * "[/]":
   *   run:
   *     build:
   *       before: node support/generate.cjs   # a repo-wide bookend, run once at the root
   * "[*]":
   *   run:
   *     build:
   *       after: node ../../support/postbuild.cjs   # run in each package's own directory
   * ```
   *
   * In YAML the quotes are **required**: a bare `[*]` parses as a flow sequence, and `*` as an
   * alias indicator. Precedence: the unmarked keys first, then these blocks **in the order they
   * were written** - later wins. A directory level closer to the package wins over all of them.
   *
   * Recursive, mirroring the schema's own `"$ref": "#"`: whatever a `.rmanrc` may say about its own
   * package it may say here about the ones it names - nested selectors included. Typed as
   * `RmanConfig` rather than `unknown` so the contents are actually checked; `unknown` let any
   * shape through, which is the opposite of the point.
   */
  [selector: `[${string}]`]: RmanConfig;
}

export const commandRegistry: RmanConfig.CommandRegisterFunction[] = [];

/**
 * Adds a `+key` alongside every key of `T`, which **appends** to whatever that key already resolved
 * to instead of replacing it - see `mergeConfig`.
 *
 * Generated by key remapping rather than written out, so a key added to the interface gets its
 * append form automatically and the two can never drift apart.
 */
export type WithAppend<T> = { [K in keyof T as `+${K & string}`]?: T[K] };

/**
 * The one key every nested config node may carry: `vars` scoping that node's subtree - a fresh copy
 * per level, merged per key over the level above. See `withScopedVars` in `core/config.ts` for what
 * it does at resolution time, and docs/rman.md#scoped-vars for how it reads.
 *
 * **Every nested options interface has to carry this**, and a hand-written one had to remember to -
 * which is the cost of the runtime rule being general (any object node scopes) while a type can only
 * say it one interface at a time. TypeScript has no way to state "and every object below this may
 * also carry `vars`" without a recursive remap that would wreck the error messages. A command's
 * contributed block gets it from `RmanConfig.ConfigBlock` and cannot forget.
 */
export interface ScopedVars {
  /** Values for `${{ vars.* }}` to read, for this node and everything under it. */
  vars?: Record<string, unknown>;
}

export namespace RmanConfig {
  /**
   * **The slot every command merges its own keys into.** Empty here on purpose: the core declares
   * no command's config, each command declares its own beside the command itself, and a plugin's
   * commands do the same from their own package.
   *
   * A command augments it with its derived contribution rather than a hand-written interface, so
   * the option list and the config type cannot drift apart:
   *
   * ```ts
   * const versionCommand = registerCommand(...);
   * export default versionCommand;
   *
   * declare module '../interfaces/rman-cfg.interface.js' {
   *   namespace RmanConfig {
   *     interface CommandConfigs extends CommandContribution<ReturnType<typeof versionCommand>> {}
   *   }
   * }
   * ```
   *
   * **Two commands may not contribute under the same top-level key.** Interface merging is not a
   * deep merge: `{run: {build: ...}}` and `{run: {test: ...}}` is
   * `Interface 'CommandConfigs' cannot simultaneously extend types ...` - measured. That is the
   * mechanical reason `build` and `test` own nothing and only *read* `run.build`/`run.test`; `run`
   * is the single owner of that subtree.
   */
  export interface CommandConfigs {}

  export interface CommandConfig {
    skip?: boolean;
    logLevel?: 'silent' | 'error' | 'info' | 'verbose';
    vars?: RmanConfig.VarsMap;
    [index: string]: any;
  }

  export interface VarsMap {
    /** Values for `${{ vars.* }}` to read, for this node and everything under it. */
    vars?: Record<string, unknown>;
  }

  /**
   * Called during init, with the application - not at import, and not with just the repository.
   *
   * The application is what a command reaches services through (`app.getService('changelog')`), and
   * `app.repository` is still there for the metadata that reads it: `version`'s help names its own
   * scheme's bump words, which cannot be known before a repository exists.
   */
  export type CommandRegisterFunction = (app: RmanApplication) => CommandMetadata;

  /** One declared option: everything yargs takes, plus where it may be set from. */
  export type CommandOption = yargs.Options & {
    array?: boolean;
    conflicts?: string | string[];
    target: 'cli' | 'config' | 'both';
    /** The flag's spelling on the command line when it differs from the config key - `ignoreDirty`
     *  is `--ignore-dirty`. The key stays the camelCase one, since that is what a `.rmanrc` writes. */
    cliName?: string;
  };

  export type CommandMetadata = {
    command: string;
    /** Other names the command answers to - `list` is also `ls`. */
    aliases?: string[];
    /**
     * yargs parser switches this command needs. `exec` is the only one so far and needs two:
     * `populate--` to keep everything after `--` out of its own options, and
     * `unknown-options-as-args` so the flags of the command *being run* pass through untouched.
     */
    parserConfiguration?: Partial<yargs.ParserConfigurationOptions>;
    describe?: string;
    examples?: {
      command: string;
      description?: string;
    }[];
    /**
     * The options this command **owns** - the ones it contributes to `RmanConfig`, under
     * `configKey`. An option a command merely *reads* belongs to whoever declares it; name it in
     * `configKeys` instead. One key, one owner: two commands declaring the same key differently
     * would collide silently in the augmentation's intersection.
     */
    config?: Record<string, CommandOption>;
    /**
     * Where `config` lands in a `.rmanrc`. Defaults to the first word of `command`, and a dotted
     * path nests (`'run.build'` -> `{ run: { build: ... } }`).
     *
     * **Needed exactly once across the nine commands today**, which is why it is optional rather
     * than required: `github-release` writes `githubRelease`, since a config key is camelCase and a
     * command name is hyphenated. Deriving that with a kebab-to-camel rule was the alternative and
     * was refused - it is one more rule to remember, and when it goes wrong the key lands somewhere
     * plausible and nobody notices.
     */
    configKey?: string;
    /**
     * Config subtrees this command reads but does not own - what `--config` should show beside its
     * own. A function of argv where the answer depends on it (`run <script>` reads `run.<script>`).
     *
     * `version` is the clearest case: it owns `version.*`, but `group` decides which packages move
     * together and `changelog.*` is consulted when `--changelog` folds one into the bump commit.
     * Neither is `version`'s to declare.
     */
    configKeys?: string[] | ((argv: yargs.Arguments) => string[]);
    /**
     * The positionals `command` declares, described - `'version [bump]'` names `bump`, this says
     * what it is. Keyed by name, and **the names are checked against the command string**: a typo
     * or a positional the command never declared fails on its own key and names the string it was
     * checked against, which the `.positional('bump', ...)` builder call could never do.
     *
     * Only the description belongs here. Whether one is required (`<x>`) or variadic (`[x..]`) is
     * part of the command string, which is the only place it can be, since that is what yargs
     * parses.
     */
    positionals?: Record<string, yargs.PositionalOptions>;
    handler: (argv: yargs.Arguments) => void;
  };

  /**
   * The names a command string declares as positionals: `'run <script> [args..]'` is
   * `'script' | 'args'`.
   *
   * Handles all four spellings in use - `<required>`, `[optional]`, `[variadic..]`, and the
   * `[three...]` that `list` writes (yargs' own marker is two dots, so that one is a latent bug
   * worth fixing separately; the parser tolerates it rather than silently producing a name with a
   * dot in it).
   */
  export type PositionalsOf<C extends string> = C extends `${string}<${infer N}>${infer Rest}`
    ? StripDots<N> | PositionalsOf<Rest>
    : C extends `${string}[${infer N}]${infer Rest}`
      ? StripDots<N> | PositionalsOf<Rest>
      : never;

  /**
   * `argv` as a command's own declarations describe it - every option by its config key, every
   * positional the command string names, plus yargs' own two.
   *
   * **It is written as an explicit annotation on the handler, not inferred**, and that is a
   * measured limitation rather than a preference. Inferring it from the sibling `config` works on
   * its own, but not beside the `M & ValidMeta<M>` check: `M` is inferred from the whole literal,
   * `handler` is part of that literal, so `ArgsOf<M>` is circular and resolves to
   * `ArgsOf<CommandMetadata>` - every option "does not exist". Splitting the inference sites gets
   * the names back and loses the values instead, because `M` and `C` then infer from the same
   * `config` property and the literals widen, so every option arrives as `unknown`.
   *
   * So the declarations are hoisted out of the literal and the handler is annotated:
   *
   * ```ts
   * const COMMAND = 'version [bump]' as const;
   * const config = { ... } satisfies Record<string, RmanConfig.CommandOption>;
   *
   * handler: (args: RmanConfig.ArgsOf<typeof config, typeof COMMAND>) => { ... }
   * ```
   *
   * Two lines, and in exchange the typo checking stays and a renamed option can no longer survive
   * silently in the handler behind an `as`.
   *
   * Every option is optional - a flag that was not passed is absent, whatever `demandOption` says
   * on the CLI side.
   */
  export type ArgsOf<C, Cmd extends string> = { [K in keyof C]?: OptionValue<C[K]> } & {
    [K in PositionalsOf<Cmd>]?: PositionalValue<Cmd, K>;
  } & GlobalArgs;

  /**
   * What every command's argv carries whatever it declares - yargs' own two, and rman's global
   * options, which are registered on the program rather than per command.
   *
   * **Measured the moment `exec` was converted**: its handler read `args.logLevel`, which compiled
   * only because `yargs.Arguments` is an index signature. With a real type it is
   * `Property 'logLevel' does not exist` - correct, and exactly the kind of thing that was invisible
   * before. Global options have to be stated once, here, or every handler that reads one is wrong.
   */
  export type GlobalArgs = {
    _: (string | number)[];
    $0: string;
    /** `--log-level`, declared on the program in `cli.ts`. */
    logLevel?: 'silent' | 'error' | 'info' | 'verbose';
    /** `--config`: print what this command would run with, and run nothing. */
    config?: boolean;
    /** Everything after `--`, present when the command sets `populate--` - `exec` reads it to tell
     *  its own flags from the ones belonging to the command it runs. */
    '--'?: (string | number)[];
  };

  /**
   * The config object a command's `config` declaration describes - `{ type: 'string' }` becomes
   * `string`, `{ type: 'string', array: true }` becomes `string[]`.
   *
   * **The literal survives inference, which is the whole reason this works.** `{ type: 'string' }`
   * would normally widen to `string`, but `yargs.Options['type']` is a union of string literals and
   * the generic's constraint types the object literal contextually - so `ReturnType<T>` still holds
   * `'string'` by the time this maps over it. Measured, with negative controls: reading a mapped
   * value as the wrong type errors, and so does naming an option that was not declared.
   *
   * `choices` narrows further, and is the one place the caller has to help: an array literal widens
   * to `string[]` on its own, so `choices: ['a', 'b'] as const` is what yields `'a' | 'b'`. Without
   * the assertion it falls back to the declared `type`.
   */
  export type CommandConfigFromMetadata<T extends CommandMetadata> = T['config'] extends infer C
    ? C extends Record<string, CommandOption>
      ? { [K in keyof ConfigOnly<C>]?: OptionValue<ConfigOnly<C>[K]> }
      : {}
    : {};

  /**
   * What the command adds to `RmanConfig`: its config options, under the key they live at -
   * `{ version: { changelog: boolean } }`, or `{ run: { build: { exec: string } } }` for a dotted
   * `configKey`.
   *
   * **`Extra` is for what an option cannot describe**, and only that. A `CommandOption` says
   * `type: 'string'` or `type: 'boolean'`; it has no way to say `{ file: string; constant?: string }`
   * or "a shell command or a function". So `version.stamp` and `version.before`/`.exec`/`.after`
   * arrive through `Extra`, hand-written beside the command, while `version.commitMessage` and
   * `version.releaseTagPattern` are ordinary `target: 'config'` options and are derived like the
   * rest. Reach for `Extra` when the shape genuinely resists, never to avoid declaring an option.
   *
   * **One key, one declaration - which is what makes `Extra` necessary rather than convenient.**
   * Interface merging is not a deep merge, so a key that arrives from two places is
   * `Interface 'RmanConfig' cannot simultaneously extend types ... Named property 'publish' of
   * types ... are not identical` (measured). A command therefore contributes its key *whole*: the
   * derived half intersected with the hand-written one, never one half here and the other in some
   * central interface.
   *
   * **`run` is the one command this cannot describe**, and it is worth knowing before relying on
   * this: `run.<script>.*` is keyed by script name, so there is no flat option map to derive from
   * and `Extra` would be the entire block. Its contribution stays hand-written in `RmanConfig`.
   *
   * **A widened key is refused rather than used**, because the damage otherwise is not local:
   * `Nest<string, V>` is an index signature, so a `configKey` that lost its literal (a missing
   * `as const`) turns `CommandConfigs` into "every string key has this command's shape" and every
   * other key in `RmanConfig` then fails to satisfy it. Measured, on `github-release`: four errors
   * pointing at `extends`, `logLevel`, `vars` and `changelog`, none of them anywhere near the
   * mistake. The named property fails at the augmentation instead, and says what to add.
   */
  export type CommandContribution<T extends CommandMetadata, Extra = {}> =
    string extends ConfigKeyOf<T>
      ? { __configKeyMustBeALiteral: 'add `as const` to `command` (or to `configKey`)' }
      : Nest<ConfigKeyOf<T>, ConfigBlock<CommandConfigFromMetadata<T> & Extra>>;

  /**
   * One config block as a `.rmanrc` may actually write it: the keys themselves, their `+key` append
   * forms, and the `vars` that scopes the subtree.
   *
   * This is what a hand-written options interface said by extending
   * `XOptionsKeys, WithAppend<XOptionsKeys>, ScopedVars` - three clauses every new one had to
   * remember. Derived, it cannot be forgotten. `WithAppend` is applied to the keys **before**
   * `ScopedVars` is added, so no `+vars` is generated: appending to `vars` means nothing, since
   * objects merge either way.
   */
  export type ConfigBlock<K> = K & WithAppend<K> & ScopedVars;

  /** The declared `configKey`, or the first word of `command`. */
  export type ConfigKeyOf<T> = T extends { configKey: infer K extends string }
    ? K
    : T extends { command: infer C extends string }
      ? C extends `${infer N} ${string}`
        ? N
        : C
      : never;

  /** One option's value type: the scalar its `type` denotes, in a list when it is one. */
  export type OptionValue<O> = O extends { array: true }
    ? OptionScalar<O>[]
    : O extends { type: 'array' }
      ? OptionScalar<O>[]
      : OptionScalar<O>;

  /**
   * The scalar behind a yargs `type`, in decreasing order of how much each says.
   *
   * `coerce` first: it is a function that *produces* the value, so its return type is the answer and
   * whatever `type` claims is a description of the input. `run --parallel` is the case - it takes a
   * flag, a number or `false` and coerces them into `boolean | number | undefined`, which no `type`
   * can state. Then `choices`, which narrows a `type` to the values it allows; then the `type`
   * itself. An option declaring none of the three is `unknown` rather than `any` - a value nothing
   * described should not silently type-check against everything.
   */
  export type OptionScalar<O> = O extends { coerce: (...args: never[]) => infer R }
    ? R
    : O extends { choices: readonly (infer C)[] }
      ? C
      : O extends { type: 'string' }
        ? string
        : O extends { type: 'number' | 'count' }
          ? number
          : O extends { type: 'boolean' }
            ? boolean
            : unknown;

  /**
   * The `run` block: scripts by name.
   *
   * **`run.vars` works at runtime but is deliberately not in this type**, and the reason is a
   * measured trade rather than an oversight. `run` is keyed by script name, so any encoding that
   * lets `vars` through has to widen the index signature's value type to something object-shaped -
   * and TypeScript then stops excess-property-checking *every* script's options. Measured on the
   * same file: with the widened index, `run: { build: { exce: 'tsc' } }` compiles clean.
   *
   * Catching that typo across every script is worth more than typing one key, so a typed JS config
   * writing `run.vars` needs a cast (`run: { vars: { x: 2 }, build: ... } as RmanConfig['run']`).
   * YAML and JSON configs are unchecked anyway and simply work. A key-remapped index signature
   * (`{ [K in string as K extends 'vars' ? never : K]: ... }`) was tried and does not help - the
   * remap still produces an index signature that claims `vars`.
   */
  export type RunConfig = Record<string, RunStepValue | RunStepValue[] | RunScriptOptions>;

  export interface RunScriptOptions extends RunScriptOptionsKeys, WithAppend<RunScriptOptionsKeys>, ScopedVars {}

  /**
   * **Which level a key is read at is not uniform, and it follows what the key decides.**
   * `RunService` reads `concurrency`, `progress`, `changed` and `changedSince` off the **root
   * package only** - one scheduler, one answer for the whole batch - so those belong under
   * `"[/]"`, and a `"[*]"` block declaring them is silently ignored (measured: `concurrency: 1`
   * under `"[*]"` still ran two packages at once). `logLevel`, `skip`, `if`, `override` and the
   * step slots are per package. `topo` and `bail` are read **both** ways and mean different things
   * at each: the root's `topo` picks the sort (topological vs alphabetical), a package's own
   * decides whether *it* waits for its dependencies; the root's `bail` is the default, a package's
   * own outranks even an explicit CLI flag.
   */
  export interface RunScriptOptionsKeys {
    concurrency?: number;
    topo?: boolean;
    bail?: boolean;
    progress?: boolean;
    logLevel?: 'silent' | 'error' | 'info' | 'verbose';
    /** Only run in packages that have changed since their last release - the config twin of
     *  `--changed`, read off the root. It was read at runtime long before it was declared here, so
     *  a typed config could not say the thing that already worked. */
    changed?: boolean;
    changedSince?: string;
    skip?: boolean;
    /** Whether this script runs for a package at all - the small `changed and not private` grammar,
     *  or a `RunConditionFn` for a condition it cannot express. Both are evaluated per package when
     *  the run reaches it; a `${{ }}` expression here is not, having been resolved when the config
     *  loaded. */
    if?: string | RunConditionFn;
    /** Command(s) to run as this script itself, when the package's `package.json` doesn't define
     *  it. An array runs them in sequence, and may mix shell commands with functions. */
    exec?: RunStepValue | RunStepValue[];
    /** Same, for this script's `pre<script>` hook. */
    before?: RunStepValue | RunStepValue[];
    /** Same, for its `post<script>` hook. */
    after?: RunStepValue | RunStepValue[];
    override?: boolean;
  }
}

/**
 * Registers a command and hands the register function straight back.
 *
 * **It returns the function, not the command's config, and that is the point.** The function has
 * not run yet - it runs during init, once there is a `Repository` - so at registration time no
 * config object exists to return. Declaring one anyway is what made the old body
 * (`return def['config']`) uncompilable: `def` is a function, and `config` belongs to what it
 * *returns*.
 *
 * Nothing is lost by being honest, because the metadata type rides along on the return type:
 * `ReturnType<typeof someCommand>` is the `CommandMetadata`, and `CommandConfigFromMetadata` maps
 * it to the config object the command contributes. A phantom property carrying the config type was
 * tried and is unnecessary for exactly this reason - and it would not have survived being stored in
 * `commandRegistry`, whose element type erases it.
 *
 * **`M` is inferred from the metadata rather than from the function, so that the same position can
 * check it.** With the plainer `<T extends CommandRegisterFunction>(def: T)`, `T` is inferred from
 * the literal itself, so the constraint is a subtype check - and a subtype check does no
 * excess-property checking. Measured: `anotherBogusTopLevelKey: true` and a `totallyBogusKey`
 * inside an option both compiled silently, which is how `cliName` and `examples` went unnoticed in
 * `version.command.ts`. `M & ValidMeta<M>` keeps the bare `M` as the inference site and puts the
 * check beside it, so a misspelled key now errors on its own line and names itself.
 *
 * **A command's `command` string needs `as const`** for the config key to be derivable from it
 * (`'version [bump]' as const` -> `'version'`). `type: 'string'` survives inference on its own,
 * since `yargs.Options['type']` is a union of literals and a union suppresses widening; `command`
 * is a plain `string`, so it widens without the assertion. Spelling it `` `${string}` `` does not
 * help - measured; that trick only applies where the constraint sits on the generic parameter.
 */
export function registerCommand<M extends RmanConfig.CommandMetadata>(
  def: (app: RmanApplication) => M & ValidMeta<M>,
): (app: RmanApplication) => M {
  /** The same cast `declareCommand` makes, rather than a call to it: passing `def` through would
   *  re-infer `M` from a type that already carries `ValidMeta<M>`, and the check then compounds
   *  onto itself (`Exact<M & Exact<M, …>, …>`) and fails on every command. Two lines, one cast
   *  each, is the honest shape. */
  const fn = def as (app: RmanApplication) => M;
  commandRegistry.push(fn);
  return fn;
}

/**
 * The same declaration, **without** the registration - for a command that must exist only when
 * something asks for it.
 *
 * That is exactly a plugin's situation: `commandRegistry` is a module-level array walked by every
 * `runCli`, so a plugin pushing onto it would give its commands to repositories that never named
 * the plugin - the module is imported as soon as anything imports the package. A plugin hands the
 * function to `ctx.addCommand` instead, and it is called once the repository exists.
 *
 * **Why a factory rather than the metadata itself**, for a plugin in particular: `init` runs
 * *inside* `Repository.create`, before the packages are known (plugins are what find them), so
 * `app.repository` throws there. The function is stored and run later, in `cli.ts`, where the
 * built-ins' own factories run.
 *
 * Everything `registerCommand` documents about inference - `M & ValidMeta<M>`, the `as const` on
 * `command`, the metadata riding on the return type - applies here unchanged; the two differ in one
 * line.
 */
export function declareCommand<M extends RmanConfig.CommandMetadata>(
  def: (app: RmanApplication) => M & ValidMeta<M>,
): (app: RmanApplication) => M {
  return def as (app: RmanApplication) => M;
}

/**
 * Only the options a `.rmanrc` may actually set. `target: 'cli'` says the flag exists on the
 * command line and nowhere else - `--interactive`, `--yes`, `--show` - and putting those in the
 * config type would invite writing them where nothing reads them.
 */
type ConfigOnly<C> = { [K in keyof C as C[K] extends { target: 'config' | 'both' } ? K : never]: C[K] };

/**
 * A dotted path into nested objects: `'run.build'` + shape -> `{ run?: { build?: shape } }`.
 *
 * **Optional at every level**, and that is not a detail: a required key would make the whole
 * contribution mandatory, so `defineConfig({})` stopped compiling with
 * `Property 'version' is missing in type '{}'` (measured). A `.rmanrc` may say nothing about a
 * command, and usually does.
 */
type Nest<P extends string, V> = P extends `${infer H}.${infer R}` ? { [K in H]?: Nest<R, V> } : { [K in P]?: V };

/** Keys `T` declares that `Shape` does not know about. */
type Excess<T, Shape> = Exclude<keyof T, keyof Shape>;

/**
 * `T` itself when it declares nothing extra; otherwise a shape it cannot satisfy, so the assignment
 * fails on the offending key and says which one it is.
 *
 * The failure payload is an **object** rather than a tuple or a string literal. Intersecting a
 * property's real type with an object leaves a real object type, so the error reads `Property
 * '__unknownKey' is missing`; with a string or a tuple the intersection collapses to `never` and the
 * message stops naming anything.
 */
type Exact<T, Shape> = [Excess<T, Shape>] extends [never] ? T : { [K in Excess<T, Shape>]: { __unknownKey: K } };

/** Every option checked against `CommandOption`, so a typo inside one is caught too. */
type ValidConfig<C> = { [K in keyof C]: Exact<C[K], RmanConfig.CommandOption> };

type ValidMeta<M> = Exact<M, RmanConfig.CommandMetadata> & {
  config?: M extends { config: infer C } ? ValidConfig<C> : unknown;
  positionals?: ValidPositionals<M>;
};

/** A positional the `command` string never declared fails on its own key, naming the string it was
 *  checked against. */
type ValidPositionals<M> = M extends { command: infer C extends string; positionals: infer P }
  ? { [K in keyof P]: K extends RmanConfig.PositionalsOf<C> ? P[K] : { __notDeclaredIn: C } }
  : unknown;

/** A trailing `..`/`...` is yargs' variadic marker, not part of the positional's name. */
type StripDots<S extends string> = S extends `${infer N}...` ? N : S extends `${infer N}..` ? N : S;

/** A variadic positional (`[command..]`) collects a list; every other one is a single value. The
 *  command string is the only place that says which, since it is what yargs parses. */
type PositionalValue<Cmd extends string, N extends string> = Cmd extends `${string}${'<' | '['}${N}..${string}`
  ? string[]
  : string;
