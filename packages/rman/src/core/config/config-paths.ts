/**
 * **Which config paths are code rather than data**, and which are left for later.
 *
 * Three lists, read by `ConfigInterpolator` as it walks and by the commands that own the keys. Not
 * members of that class, and that is the exception CLAUDE.md records: `CodeSubtree` is derived from
 * `CODE_SUBTREES` with `(typeof ...)[number]`, and a class field has no type to derive from. The
 * test is whether a *type* reads the value, not whether the value feels constant.
 */

/**
 * Keys whose **whole subtree** is code rather than config, so no function under them is a value to
 * compute.
 *
 * The three contribution keys, and each has to be here: an entry may be the *instance* itself, and
 * a `Plugin` is almost entirely functions - `manifestProvider.read`, `getWorkspace`,
 * `getBinPaths`, `versionPlanner` - while a command is often a bare factory and a publish target
 * carries `getPlan`/`applyPlan`.
 *
 * Measured twice, once per shape. With `plugins` walked like any other key, resolving the config
 * of a repository that named a plugin called that plugin's yargs builder with the config scope:
 * `Config function in "plugins[0].commands[0].builder" failed: cmd.option is not a function`. And
 * with `commands` left out of this list, a declarative command - which *is* a function - was
 * invoked with the interpolation scope instead of the application, so its handler closed over a
 * repository that was not one: `repository.getPackages is not a function`, from inside `clean`.
 *
 * These entries are loaded by `loadPlugins` and `cli.ts`, never read as settings.
 */
export const CODE_SUBTREES = ['plugins', 'platforms', 'commands', 'publishTargets'] as const;

/**
 * Paths whose value is a **step** - something to run later - rather than a setting to compute now.
 * `*` matches one path segment (`run.<script>.exec`).
 *
 * This is what tells a step function from a value function, and the two live side by side in one
 * config:
 *
 * ```js
 * '[*]': {
 *   clean: { include: ({ vars, value }) => [...value, vars.buildDir] },   // a value: called here
 *   run: { build: { after: ({ pkg }) => copyDocs(pkg) } },                // a step: called by `run`
 * }
 * ```
 *
 * **The key decides, and it already did.** `run.build.exec: 'tsc -b'` is a shell command and
 * `publish.npm.directory: 'build'` is a path - not because of anything about the strings, but because of
 * where they sit. A function inherits the same rule, so nothing new has to be learned and no marker
 * has to be remembered. The alternative was inspecting the function (arity, parameter names), which
 * is the kind of guess `loadPlugins` refuses to make about a module's export for the same reason:
 * guessing wrong here means running build-time code while merely loading the repository, or
 * silently never running it.
 *
 * A **string** at one of these paths is still interpolated - `exec: 'tsc -b ${{ file.resolve(...) }}'`
 * has to keep working - so this is narrower than `DEFERRED_PATHS`, which skips its paths entirely.
 */
export const STEP_PATHS = [
  /** The bare-value shorthand: `run: { build: fn }` means `{ exec: fn }`, as `run: { build: 'cmd' }`
   *  means `{ exec: 'cmd' }`. Missing it made the two spellings disagree about *when* the function
   *  runs, which is worse than not supporting the short one at all. */
  'run.*',
  'run.*.before',
  'run.*.exec',
  'run.*.after',
  /** A condition, evaluated per package by `RunService` when the run reaches it. Called here
   *  instead, it collapsed to the boolean it happened to return at load time - and `parseIfExpr`
   *  then read that boolean as "no condition given", so the script ran unconditionally (measured). */
  'run.*.if',
  'version.before',
  'version.exec',
  'version.after',
  /**
   * The function inside a step's **object** form (`{ topo: true, run: fn }`).
   *
   * Array indices are dropped before matching but object keys are not, so `run.build.after[0].run`
   * arrives as `run.build.after.run` - one segment longer than `run.*.after`, which matches by
   * length. Without these the function would be taken for a *value* function and called while the
   * repository loads, which is the exact failure the step/value split exists to prevent, and it
   * would happen on `rman list`.
   *
   * `command` needs no entry: only functions are asked, and a string at any path is interpolated
   * either way - which is what keeps `command: 'tsc -b ${{ file.resolve(...) }}'` working.
   */
  'run.*.run',
  'run.*.before.run',
  'run.*.exec.run',
  'run.*.after.run',
  'version.before.run',
  'version.exec.run',
  'version.after.run',
];

/**
 * Config paths left untouched when a repository's config is first resolved, and evaluated only by
 * the command that runs them.
 *
 * `version`'s own hooks are the one place `${{ pkg.targetVersion }}` makes sense, and the version
 * being written is not known until `version` has computed its plan - long after the config was
 * resolved. Evaluating these eagerly would throw while merely *loading* the repository, so any
 * command at all would fail on a config that mentions it.
 */
export const DEFERRED_PATHS = ['version.before', 'version.exec', 'version.after'];

/** One of the keys whose whole subtree is code - see {@link CODE_SUBTREES}. */
export type CodeSubtree = (typeof CODE_SUBTREES)[number];
