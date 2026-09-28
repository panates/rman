import type path from 'node:path';
import type semver from 'semver';
import type { ConfigFileScope } from '../core/config/config-file-scope.js';

/**
 * **What a `${{ ... }}` expression can name**, and what a value function is handed.
 *
 * One file because these six describe one thing from different angles: `ConfigScope` is the whole
 * of it, the others are its members, and `ConfigValueContext` is the same scope with `value` added
 * for a function. They are `interfaces/` rather than `core/` for the reason the config interface
 * already is - nothing here runs, and the audience is a config author.
 */

/**
 * What a `${{ ... }}` expression can see - the bindings of the fresh global it is evaluated in.
 * Namespaced rather than a flat bag of loose names: one obvious place per fact, and room to add
 * helpers to `pkg`/`repository` later without crowding the global.
 *
 * Alongside these, **the config's own top-level keys are bound bare** (`${{ changelog.filePath }}`,
 * `${{ clean.include }}`) - see `interpolateConfig`. They are not listed here because they come
 * from the config being interpolated, not from this object; a name here wins over a config key of
 * the same name.
 *
 * **Trap: bare `${{ version }}` is the `version` *options block*, not the package's version
 * string** - that is `${{ pkg.version }}`. Same word, two different things, and the plain one
 * belongs to the config because every other config key is reachable that way.
 */
export interface ConfigScope {
  /** The package the config was resolved for - which is what lets one declaration at the root
   *  still say something package-specific. */
  pkg: PackageScope;
  repository: RepositoryScope;
  /** Paths, resolved against the package the config was resolved for. */
  file: FileScope;
  /**
   * The **contents** of a structured file - `${{ read('tsconfig.json').compilerOptions.outDir }}` -
   * where `file` answers only where one is. Resolved against `pkg.dirname` like `file`, so a
   * `"[*]"` block asks each package about its own; a repository-level file is reached through
   * `read(path.join(repository.dirname, ...))`.
   *
   * `.json`, `.yml`/`.yaml` and `.ini` by extension, or name it for a file that does not say
   * (`read('.npmrc', 'ini')`). **Throws** when the file is absent, as `file.resolve` does - compose
   * with `file.exists` when its absence is a case to handle.
   *
   * **A manifest is `pkg.manifest`, not this.** `read('package.json')` works and is the wrong
   * answer: which file a package's identity lives in belongs to the ecosystem, so that expression
   * is already wrong in a Cargo package sitting beside a Node one.
   *
   * The result is **deeply frozen and shared** - see `readStructuredFile`. Spread it to change it.
   */
  read: ConfigFileScope.ReadFile;
  env: Record<string, string | undefined>;
  /** rman's own `semver`, for the arithmetic every release config eventually wants
   *  (`semver.major(pkg.version)`). */
  semver: typeof semver;
  /**
   * Node's own `node:path` - `${{ path.join(pkg.dirname, 'LICENSE') }}`, rather than gluing
   * strings with `+ "/" +` and getting a double separator or none.
   *
   * The platform's flavour, not `path.posix`, so a joined path is the one the shell on *this*
   * machine understands; `path.posix` and `path.win32` are reachable through it when a config
   * genuinely needs one of them (a Docker image path, say, which is always posix).
   */
  path: typeof path;
  /**
   * The checkout: branch, sha, whether the tree is dirty.
   *
   * **Top level, not `repository.git`** - which is where it used to be, and the move is the point.
   * `repository` shares its shape with `pkg` because the repository root *is* a package, and its
   * only other members (`monorepo`, `packages`, `package()`) say something about the repository as
   * a container of packages. A branch name says nothing about any package; it describes the
   * working tree every one of them happens to be sitting in - the same kind of ambient fact as
   * `env`, and it belongs beside it.
   *
   * **Read from git only if an expression actually asks**, then remembered for the whole run: every
   * command resolves config, and a repository that never mentions git must not pay for one. See
   * `Repository.configScope` for the getter, and `interpolateConfig` for why the context is built
   * from property descriptors rather than a spread - a spread would fire this getter on every
   * command, which is exactly what moving it up here risked.
   */
  git: GitScope;
}

/** One package, as an expression sees it - the same shape for the package the config belongs to
 *  and for the repository itself, so `${{ repository.basename }}` reads the way `${{ pkg.basename }}` does. */
/**
 * `file` in a `${{ ... }}` expression: what is actually on disk, resolved against **the package
 * the config was resolved for** - so one declaration in a `"[*]"` block asks each package about
 * its own directory.
 *
 * The pair exists because a config has two different questions about a path, and answering both
 * with one function would mean picking a wrong default for the other:
 *
 * ```yaml
 * "[*]":
 *   run:
 *     build:
 *       # first of these that exists, and an error naming the config path if none do
 *       exec: 'tsc -b ${{ file.exists("tsconfig-build.json") || file.resolve("tsconfig.json") }}'
 * ```
 *
 * **Every member asks a question, and none may ever change anything - no `copy`, no `write`, no
 * `mkdir`.** Not a matter of taste: this is evaluated when the config *resolves*, which every
 * command does, so a member that acted would act on `rman list`, `rman info` and `rman config`.
 *
 * That has been tried, in the only way a missing function can be: a shared config reaching for a
 * `file.copyMany(...)` that does not exist made **every** rman command exit 1 - and had it existed,
 * the quieter outcome would have been files copied by `rman list`. Work belongs in a step
 * (`run.<script>`'s slots, `version`'s hooks), which is the one place rman runs anything, and a
 * step can now be a function - so there is nothing this would enable that is not already possible
 * at the right moment.
 */
export interface FileScope {
  /**
   * The absolute path if it exists, **`''` if it does not** - so `a || b || c` picks the first one
   * present, and so a miss never reaches the "nullish inside a string" guard that `undefined` would
   * trip. Accepts a relative path (against the package directory) or an absolute one.
   *
   * It returns a path rather than a boolean on purpose: the caller almost always wants the path,
   * and a separate `file.path()` to fetch it after a boolean test would read the disk twice and
   * invite the two calls to disagree.
   */
  exists(target: string): string;
  /** The absolute path, or **throws** - for a file whose absence is a mistake rather than a case to
   *  handle. The error names the config path holding the expression, like any other. */
  resolve(target: string): string;
  /**
   * The first of several that exists, or **throws** naming every candidate it tried:
   *
   * ```yaml
   * exec: 'tsc -b ${{ file.resolveFirst("tsconfig-build.json", "tsconfig.build.json", "tsconfig.json") }}'
   * ```
   *
   * The same thing an `exists() || exists() || resolve()` chain does, said once - and it cannot be
   * got subtly wrong the way that chain can: ending it in `exists()` leaves `tsc -b ` with no
   * argument when nothing matches, and tsc then silently falls back to the directory's default
   * rather than reporting that the package has no build config.
   */
  resolveFirst(...targets: string[]): string;
}

export interface PackageScope {
  /** The package's own name, scope included (`@sqb/builder`). */
  name: string;
  /** Just the scope (`@sqb`), or `undefined` for an unscoped package. */
  scope: string | undefined;
  /** The name with its scope stripped (`builder`). */
  unscopedName: string;
  version: string;
  /** The package directory's last segment (`builder`) - not always the same as `unscopedName`,
   *  which is why both exist, and usually what a sibling path (`../../coverage/builder`) is keyed on. */
  basename: string;
  /** Absolute path to the package's own directory - named as rman's own `Package.dirname` is. */
  dirname: string;
  /** That directory relative to the repository root (`packages/builder`), which is what a command
   *  addressing another package from the root usually needs. Empty string for the root itself. */
  relativeDir: string;
  /**
   * Which ecosystem this package belongs to - `'node'` for one the `node` built-in read, empty when no
   * plugin claimed it. The same `Package.provider`, so one declaration can address a single
   * ecosystem in a polyglot repository (`if: "${{ pkg.provider === 'node' }}"`).
   */
  provider: string;
  /**
   * The whole manifest, as a copy - so an expression can reach a field rman itself has no opinion
   * about (`${{ pkg.manifest.engines.node }}`).
   *
   * Named `manifest`, not `json`: which file a package's identity lives in is the ecosystem's
   * business now (see `Plugin`'s manifest members), and `json` was that assumption showing through the one
   * remaining user-facing name. A config written against `${{ pkg.json... }}` needs the rename.
   */
  manifest: Record<string, unknown>;
  /**
   * The version this run is about to write - **bound only during `version`**, and only once its
   * plan is computed. Reading it anywhere else throws rather than yielding `undefined`: no other
   * command has a target version, so an expression asking for one has been put in the wrong place,
   * and a config that quietly evaluates to "undefined" is the failure this evaluator exists to
   * prevent.
   */
  targetVersion: string;
}

/** Facts about the repository, on top of the root package's own - because the repository root *is*
 *  a package (`repository.name` is what its `package.json` says, `repository.basename` the directory
 *  it sits in, and the two genuinely differ). Sharing `PackageScope`'s shape is what makes
 *  `repository.version` read the way `pkg.version` does. */
export interface RepositoryScope extends PackageScope {
  monorepo: boolean;
  /** Every package in the repository - the root included only when it *is* the one package. */
  packages: PackageScope[];
  /** One package by name, or `undefined` - for reaching a sibling's directory. */
  package(name: string): PackageScope | undefined;
}

export interface GitScope {
  branch: string | undefined;
  sha: string | undefined;
  shortSha: string | undefined;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean | undefined;
}

/**
 * What a **value function** is handed - `clean: { include: ({ value, pkg }) => [...] }`.
 *
 * The same scope a `${{ }}` expression sees, plus `value`. There is no asymmetry between the two
 * spellings and that is an invariant with a spec on it: the argument *is* the expression context
 * with `value` on it, so a member defined straight onto the argument would split them silently and
 * a config author would meet a name that works in one spelling and not the other.
 *
 * **The config's own top-level keys are bound bare too**, and they cannot be typed here - they come
 * from the config being interpolated rather than from this object. Reach them through `pkg.config`
 * when a type matters, or accept `any` from the bare name.
 *
 * **Not what a *step* function is handed.** `run.<script>.exec` and `version.<slot>` take a
 * `RunStepFn`, which gets a `RunStepContext` (`pkg`, `repository`, `cwd`, `runBin`, `logger`) when
 * its turn comes - a different object at a different time, which is the whole distinction the two
 * forms exist to draw. Never widen a step key to accept this one.
 */
export interface ConfigValueContext extends ConfigScope {
  /**
   * What this key resolved to in the layers **below** this one - the list form of it, so
   * `[...value, 'x']` needs no guard. `any` rather than a generic: the key's own type is what the
   * function must return, while `value` is whatever the layers underneath happened to produce, and
   * a scalar underneath arrives as a one-element list. See `previousValue`.
   */
  value: any;
  /** The config's own top-level keys, bound bare - `vars`, `publish`, `clean`, … */
  [key: string]: any;
}
