import type { RmanPlugin } from '../core/plugin.js';
import type { RunConditionFn, RunStepValue } from '../core/run-step.js';
import type { RmanConfig as CommandDeclaration, ScopedVars, WithAppend } from './rman-cfg.interface.js';

/**
 * Re-exported, not declared here any more: both moved to `rman-cfg.interface.ts`, where
 * `CommandContribution` needs them to give a command's contributed block the same `+key` and `vars`
 * forms a hand-written one has. The import direction points at the file that outlives this one.
 */
export type { ScopedVars, WithAppend } from './rman-cfg.interface.js';

/**
 * The shape of `.rmanrc`/`.rmanrc.yml`/`.rmanrc.cjs`/`.mjs`/`.js` (and `package.json`'s own
 * `"rman"` key) - see docs/rman.md#configuration-rmanrc-rmanrcyml for the full reference. Every
 * field is optional and cascades from the repository root down to each package's own directory.
 * Purely a typing aid (used by `defineConfig` below, and importable on its own for a `.rmanrc.ts`/
 * `.mts` authored config, or a plain `: RmanConfig` annotation) - never read by rman itself, which
 * only ever sees the plain JS object a JS config file exports.
 */
export interface RmanConfig
  extends
    RmanConfigKeys,
    WithAppend<RmanConfigKeys>,
    CommandDeclaration.CommandConfigs,
    /** **Both clauses, or a contributed key loses its append form.** `WithAppend` maps over what it
     *  is given, so mapping `RmanConfigKeys` alone stopped generating `+version`/`+publish` the
     *  moment those keys moved out of it - caught by `config.spec.ts`'s type-level pin, which is
     *  the only thing that looks. */
    WithAppend<CommandDeclaration.CommandConfigs> {
  /**
   * Configs to inherit from, merged **underneath** this one - a shared package
   * (`"@panates/rman-monorepo"`), a relative path, or an array applied in declaration order.
   *
   * A bare name resolves through *this* file's own `node_modules`, so a subpath works too
   * (`"@panates/rman-monorepo/strict"`). The target may be YAML, JSON, or a module exporting a
   * config via `defineConfig`, and may itself `extends` another.
   *
   * Top level only: a `"[selector]"` block naming one is an error rather than a no-op, since
   * inheritance is a statement about this config and not about the packages a selector names.
   */
  extends?: string | string[];
}

/** Every setting a config may carry, without the `+key` append forms or `extends` - the shape
 *  `RmanConfig` is built from, kept separate only so `WithAppend` has something to map over. */
export interface RmanConfigKeys {
  /**
   * **A plugin adds its own keys here, by declaration merging** - `rman-node` contributes
   * `clean` and `publish.npm.directory` from its own
   * `interfaces/rman-config.interface.ts`, so `pkg.config.clean` stays typed wherever it is read
   * without the core having to know npm has a `node_modules` or that TypeScript has build output.
   * `WithAppend` is a mapped type evaluated at use, so an augmented key gets its `+key` form too.
   *
   * A config author annotates with the plugin's own name for the union - `RmanNodeConfig` - which
   * is what makes the import that carries the augmentation explicit rather than incidental.
   */
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

export namespace RmanConfig {
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

  export interface RunScriptOptionsKeys {
    concurrency?: number;
    topo?: boolean;
    bail?: boolean;
    progress?: boolean;
    logLevel?: 'silent' | 'error' | 'info' | 'verbose';
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

  /**
   * **A target's name, and deliberately not a union.**
   *
   * It was `'npm' | 'docker'`, which CLAUDE.md recorded as the type half of a bug: the runtime half
   * was a hardcoded `['npm']` default, so `rman list --json` reported `publishTargets: ["npm"]` for
   * a Cargo package. Both are gone together - which targets exist is whatever the repository's
   * plugins contribute (`RmanApplication.publishTargets`), so a union here would mean the core
   * naming plugins it cannot know about, exactly as `Package.provider` must not.
   *
   * A name nothing implements is caught where the facts are, by `publish` itself, naming the
   * targets this repository does have.
   */
  export type PublishTarget = string;

  /** Required once `"docker"` is one of this package's `publish.target`s - `publish --target
   *  docker` errors clearly on a package that opts in here but leaves this out. */
  export interface DockerPublishOptions
    extends DockerPublishOptionsKeys, WithAppend<DockerPublishOptionsKeys>, ScopedVars {}

  export interface DockerPublishOptionsKeys {
    /** DockerHub image name/repository - bare (e.g. `"my-app"`) to be prefixed with
     *  `--docker-namespace`/`DOCKERHUB_NAMESPACE`, or already-namespaced (contains a `/`) to use
     *  verbatim. */
    image: string;
    /** Relative to the package's own directory. Default `"Dockerfile"`. */
    dockerfile?: string;
    /** Default `["linux/amd64"]`. */
    platforms?: string[];
    /** Build `cwd` override, relative to the repository root - only needed when the Dockerfile's
     *  own `COPY`/`ADD` paths expect something other than the package's own directory (rare). */
    cwd?: string;
    /** Named `docker buildx build --build-context <name>=<path>` entries, keyed by name - each
     *  path is relative to the package's own directory (or absolute). */
    buildContexts?: Record<string, string>;
    /** `docker buildx build --build-arg <name>=<value>` entries - a value of exactly `"$NAME"`
     *  expands to `process.env.NAME` at build time (e.g. to pass a CI secret through). */
    buildArgs?: Record<string, string>;
    /** A file (relative to the package's own directory) whose contents become the DockerHub repo's
     *  full description, if present. Default `"DOCKER_README.md"`. */
    readme?: string;
  }
}
