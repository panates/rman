import type * as yargs from 'yargs';
import type { RmanApplication } from '../core/application.js';

/**
 * What a `.rmanrc` may hold. The keys here are the ones no command owns; everything a command
 * contributes arrives through `RmanConfig.CommandConfigs`.
 */
export interface RmanConfig extends RmanConfig.CommandConfigs {
  extends?: string | string[];
  logLevel?: 'silent' | 'error' | 'info' | 'verbose';
  vars?: RmanConfig.VarsMap;
}

export const commandRegistry: RmanConfig.CommandRegisterFunction[] = [];

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
   * **`run` is the one command this cannot describe**, and it is worth knowing before relying on
   * this: `run.<script>.*` is keyed by script name, so there is no flat option map to derive from.
   * Its contribution stays hand-written in `RmanConfig`. Eight of nine, not nine of nine.
   *
   * **A widened key is refused rather than used**, because the damage otherwise is not local:
   * `Nest<string, V>` is an index signature, so a `configKey` that lost its literal (a missing
   * `as const`) turns `CommandConfigs` into "every string key has this command's shape" and every
   * other key in `RmanConfig` then fails to satisfy it. Measured, on `github-release`: four errors
   * pointing at `extends`, `logLevel`, `vars` and `changelog`, none of them anywhere near the
   * mistake. The named property fails at the augmentation instead, and says what to add.
   */
  export type CommandContribution<T extends CommandMetadata> =
    string extends ConfigKeyOf<T>
      ? { __configKeyMustBeALiteral: 'add `as const` to `command` (or to `configKey`)' }
      : Nest<ConfigKeyOf<T>, CommandConfigFromMetadata<T>>;

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
