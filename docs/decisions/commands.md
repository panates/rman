# Commands: declaration, shadowing, shared flags, `.rman/*.mjs`

Design decisions moved out of `CLAUDE.md`. Covers `registerCommand` / `declareCommand` / `defineCommand`, `shadowable`, `skip`, `--from-root`, `--scope /`, a repository's own commands.

## `build` and `test` may be shadowed; every other built-in may not

`CommandMetadata.shadowable`, read by `cli.ts`'s `builtInNames`. Those two are the only built-ins
that carry no logic of their own - both are `run <script>` under a shorter name - so the name belongs
to whoever has the better answer for it.

- **The case that forced it, measured across seven repositories of this organization**: not one has a
  package with its own `test` script, because testing there is a single run at the repository root,
  exactly as linting is a single eslint run there. So `rman test` fanned out over packages defining
  nothing, answered `No package defines a "test" script.`, and everyone typed `npm test` - leaving
  one verb outside the set. `rman test` itself had **zero invocations anywhere**; the only mentions
  are documentation.
- **This is the wall `lint` hit**, which is why `lint` is not an alias any more. Deleting `test` the
  same way would have been the cleaner surface and a **major** - for the benefit of nobody, since the
  alias has no users. Shadowing reaches the same place without breaking a repository whose tests
  really are per package, which still has `rman run test`.
- **A shadowed built-in is not registered at all.** Letting yargs' last-wins settle it leaves *two*
  rows in `--help`, each with its own description and nothing saying which runs - measured on `test`,
  with rman's alias and `@panates/rman-preset`'s command both listed. That is the same failure
  `byName` already fixed for contributed-on-contributed, and the fix is the same shape: skip the
  registration, say so at `verbose`.
- **Not a general relaxation.** Every other built-in defends its name, and that refusal is what keeps
  `rman publish` from resolving to two different things. A repository that wants one anyway has
  `.rman/*.mjs`, where it wins by design.
- **Two spec traps, both caught by asking what would fail**: a case passing a hand-written list to
  `assertNoBuiltinShadowing` proves nothing about what `builtInNames` derives - it would pass with
  the change reverted, so the case goes through `runCli`. And a `.rman/publish.mjs` fixture without
  `describe` is skipped before it can shadow anything, so the refusal control was not controlling.
  A third case reads the registry and pins that **exactly** `build` and `test` carry the flag.

## `skip`, `--from-root` and `--scope /`, the flags every command should share

- **Top-level `skip`: "leave this package alone", honoured by every command that *acts*** -
  `run`/`build`/`test`/`lint`, `exec`, `clean`, `publish`, `version`, `changelog`. Applied inside
  `filterPackages` itself, not as one of its options: it is the *repository's* standing filter,
  where `--scope` is the caller's ad-hoc one. Dropped **before** `--deps`/`--dependents`, so a
  dependency edge cannot drag a skipped package back in.
  - **`filterPackages`' third argument is the only opt-out, and `list` is the only caller that uses
    it.** The test for a new command: does it *do* something to the packages, or *report* on them?
    An inventory hiding part of the repository answers a different question than the one asked.
    `version --json` follows `version` (it honours skip), because its whole job is to say what a
    real run would do.
  - The finer-grained keys stay, and are not the same statement: `run.<script>.skip` stops one
    script, `publish.skip` means "never distributed, by any target" - which `changelog` reuses on
    purpose - and since 2.22 `version` honours `publish.skip` too (see `version` below), with its
    own `version.skip` to say otherwise. A blanket `skip` replacing them would flatten that.
- **`--from-root`/`-r` comes from one `fromRootOption(verb)`** (`applyFromRootOption` for the
  hand-written builder form), not from four near-identical option blocks. It means something **only
  where a command scopes by the current directory** - `run`/`build`/`test`/`lint`, `exec`, `clean`,
  `changelog`, `diff` narrow to `Repository.currentPackage` when you stand inside a package, and
  this is the escape hatch. Do **not** add it to `version`, `publish` or `list`: they
  already work across the whole repository, so the flag would do nothing, and a no-op flag reads as
  a promise.
  - `diff` was the measured gap - it narrowed to the current package like the others but had no way
    to say "the whole repository", since omitting the package name is what already meant that.
  - **It was `--root` through 1.x and the name said the opposite of what it does.** Every reader is
    the same line - `options.fromRoot ? undefined : repository.currentPackage` - so the flag means
    *ignore where I am standing*, i.e. the widest set; `--root` reads as the narrowest. The service
    option was renamed with it (`RunService`/`ExecService`/`ChangelogService`/`CleanService`
    `Options.fromRoot`), which also fixed two internal callers that read `root: true` beside a
    `scope:` - `version` and `github-release` driving `ChangelogService` programmatically.
  - **A two-letter short (`-fr`) is not available, and this was measured rather than assumed.**
    yargs' `short-option-groups` is on by default, so `-fr` parses as `-f -r` and `.strict()`
    answers `Unknown arguments: f, r`; `alias: 'fr'` is reachable only as `--fr`. Disabling that
    parser option does make `-fr` work and breaks every grouped short - `rman list -sj` works today.
    So `-r` stayed. The same reasoning applies to any future two-letter alias here.
  - **There is no `--root-only`, and the rule above is why.** Per command: a no-op on
    `run`/`build`/`test`/`lint` (`repository.packages` holds the members only, and the root contributes
    just its `pre`/`post` bookends, so there is nothing to select); identical to `--from-root` on
    `diff` (which is already `rootPackage` with no pathspec); already what `--from-root` does on
    `config`; answerable with `cd $(git rev-parse --show-toplevel)` for `exec`. On `clean` it would
    be **actively misleading**: measured, the root's own sweep recurses through `packages/*`, so a
    flag named "root only" deletes *more* than a package-scoped run. Where the root genuinely is a
    candidate, `--scope /` says so - see below.
- **`--scope /` is the root package, and a glob never matches a *monorepo's* root** (`ROOT_SELECTOR` /
  `selector` in `package-filter.ts`, `Package.isRoot`). One vocabulary with `.rmanrc`'s `"[/]"`, and
  the same justification: *a monorepo's root is never selected by name.*
  - **Both halves are the feature.** `/` alone would be sugar - `--scope <root's name>` already
    worked (measured on this repository: `rman clean --scope 'rman*'` selected the root). Leaving
    globs able to reach it keeps exactly the trap the config selectors were redesigned to remove,
    and for `clean` it is destructive rather than merely surprising.
  - **In a single-package repository a glob does reach the root**, because there it is the one
    package - `repository.packages` is `[rootPackage]`, so `--scope '*'` selecting nothing was the
    same silent emptiness `"[*]"` had in the config. `/` still selects it, so nothing that worked
    stops working. The clause is written twice on purpose, here and in `Workspace._speaksFor`, and
    the two must never drift: `"[*]"` and `--scope '*'` are one set.
  - Accepted by `--ignore` too, so `--ignore /` is every package but the root. The asymmetry would
    be the thing to remember, and that spelling is a real thing to want of `clean`.
  - **It selects nothing where the root is not a candidate, deliberately.**
    `repository.packages` is the workspace members, so `list`/`run`/`exec` have no root to select -
    measured, `rman list --scope /` answers `0 Package(s) found` and `rman exec --scope /` answers
    `No package matched.` `clean` and `changelog` are the two that put
    `[rootPackage, ...packages]` in front of `filterPackages` on purpose - they are where it bites,
    and where the specs for it live.
  - **`Package.isRoot` is by directory**, not by name and not by identity: `Repository extends
    Package` while holding a *separate* `rootPackage` instance for the same directory, so `this ===
    repository.rootPackage` answers `false` for one of the two objects that are both the root. It is
    `false` before `Repository.create` assigns `repository`, which is what keeps a bare
    `new Package(dir, app)` (the fixtures') usable.

## How a command is declared

[`src/interfaces/rman-config.interface.ts`](../../packages/rman/src/interfaces/rman-config.interface.ts),
[`src/core/command-builder.ts`](../../packages/rman/src/core/command-builder.ts). **A command says what it
has; one function says what yargs is told.** A hand-written `builder` was the second place every
fact about a command lived, and a typo in it was a flag that silently never existed.

```ts
const COMMAND = 'version [bump]' as const;
const config = { ...packageFilterOptions, show: { target: 'cli', type: 'boolean', ... } }
  satisfies Record<string, RmanConfig.CommandOption>;
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const versionCommand = registerCommand(app => ({ command: COMMAND, config, handler: (args: Args) => ... }));
```

- **`registerCommand` for a built-in, `declareCommand` for a plugin's**, and the difference is one
  line: the first pushes onto `commandRegistry`, a module-level array `runCli` always walks. A
  package using it would hand its commands to repositories that never named it - the module is
  imported the moment anything imports the package. A package puts the function in its config's
  `commands` instead, and `cli.ts` calls it once the repository exists.
- **A factory of `app`, not the metadata**, because a command closes over the repository and over
  whatever the application carries (`publish` reads `app.publishTargets` to build its own options).
  For a plugin that is also a necessity: `init` runs *inside* `Repository.create`, before any
  package is known, so `app.repository` throws there. `cli.ts` runs a plugin's factory where the
  built-ins' own run.
- **`as const` on the `command` string is load-bearing twice**: the config key is derived from it
  (`'version'`), and so are the positional names checked against `positionals`.
- **`ArgsOf` is annotated, never inferred.** Three ways were measured: via `ValidMeta<M>` it is
  circular; split inference sites give the names but `unknown` values; hoisting `config`/`COMMAND`
  out and annotating the handler works. That is why those two consts sit above the factory.
- **`M & ValidMeta<M>` is what catches a typo**, and the plainer `<T extends CommandRegisterFunction>`
  does not: a generic inferred from a literal makes the constraint a subtype check, and a subtype
  check does no excess-property checking (measured - `cliName` and `examples` went unnoticed).
- **`target: 'cli' | 'config' | 'both'`** on each option decides whether it is a flag, a `.rmanrc`
  key, or both; `CommandContribution` turns the `config`/`both` ones into the command's slice of
  `RmanConfig`, so the option list and the config type cannot drift.
- **`Extra` is for what an option cannot describe, and only that.** A `CommandOption` says
  `type: 'string'`; it cannot say `{ file: string; constant?: string }` or "a shell command or a
  function". So `version.stamp` and `version.before`/`.exec`/`.after` are written out as
  `VersionExtraKeys` beside the command, while `version.commitMessage` and `.releaseTagPattern` are
  ordinary `target: 'config'` options and are derived like everything else. Reach for `Extra` when
  the shape genuinely resists, never to avoid declaring an option - `changelog` and `github-release`
  need none at all (`assets` is `type: 'string'` **plus** `array: true`, which is what keeps it a
  `string[]`; `type: 'array'` alone loses the element type and yields `unknown[]`).
- **One key, one declaration - which is what makes `Extra` necessary rather than convenient.**
  A key arriving from two places is `Interface 'RmanConfig' cannot simultaneously extend types ...
  Named property 'publish' of types ... are not identical` (measured). So a command contributes its
  key *whole*: derived half intersected with hand-written half, never one half here and the other
  in some central interface.
- **A key several parties contribute to needs a slot, not a second declaration.**
  `publish.command.ts` exports an empty `PublishTargetConfigs`; the core's docker target declares
  `docker` in it and `rman-node` declares `directory`, each from its own package. That is the config
  half of a publish target being a contribution - the flags, the registry check *and* the keys.
- **`declareCommand` and friends are exported from `rman` under flat names** (`CommandOption`,
  `ArgsOf`, `CommandMetadata`), not as the `RmanConfig` namespace they live in: `rman-config.
  interface.ts` exported that name too and one package cannot export two. The two files are merged
  now and `RmanConfig` *is* exported; the flat names stay because they are the better ones for the
  job - a plugin author declaring a flag wants `CommandOption`, not the config it contributes to.

**Three authoring forms exist, and only the first is the one to write:**

| | Who | Shape |
| --- | --- | --- |
| `registerCommand` | rman's own `src/commands/*.command.ts` | declarative, auto-registered |
| `declareCommand`, in a config's `commands` | a package, or a repository | declarative, registered when the config is read |
| `defineCommand` (`CustomCommand`) | `.rman/*.mjs`, and anything not yet converted | hand-written `builder`, `handler(context, args)` |

The third is not deprecated: a repository's own command has no `app` to close over and wants the
`CommandContext` it gets. `cli.ts` turns either plugin form into a `CommandModule` and there is one
`program.command` call for all of them.

## A repository's own commands (`.rman/*.mjs`)

[`src/core/custom-command.ts`](../../packages/rman/src/core/interfaces/custom-command.ts). A module there becomes `rman <its file
name>`, built with `defineCommand` (the `defineConfig` pattern again). `handler(context, args)` -
`context` is an **object** precisely so later additions don't break commands already written
against it, which has already paid for itself twice (`runBin`, `logger`). Its members:
`repository`; `package` (`Repository.currentPackage`, so `undefined` at the root); `runBin`; and
`logger`.

- **`context.runBin`/`context.logger` carry *this run's* settings, and that is why they are handed
  over rather than imported.** `runBin` is pre-bound with `cwd` = the repository root and the log
  level resolved from `--log-level`/`.rmanrc logLevel`; `logger` is at that same level. A command
  importing `runBin` from `'rman'` directly gets one that knows neither, so `--log-level silent`
  would quietly fail to apply to the only part of the command that prints anything. Anything else a
  run turns out to carry goes on the context the same way.
- **`runBin` vs `exec`** ([`src/utils/run-bin.ts`](../../packages/rman/src/utils/run-bin.ts)): `runBin` takes **argv as
  an array** and spawns with no shell, so an interpolated value containing a space stays one
  argument and one containing `;` stays data. `exec` runs a shell and is right for a command string
  a config author wrote, shell operators and all (`run.<script>`, `version` hooks) - and wrong for
  arguments assembled in code. `runBin` also resolves the binary through `BinPath.env` rather than
  by path, which is what makes Windows find `eslint.cmd`; and a non-zero exit **rejects** rather
  than returning a code, because a lint or check step that passes in CI having checked nothing is
  the outcome worth ruling out.
  - **The distinction is kept in `exec`'s signature, not in a convention**: it takes no `argv` and
    its shell is not optional. It used to accept both, and nothing ever passed either - which made
    it look able to do `runBin`'s job, badly, since the shell would still re-split the arguments.
    Don't re-add them.
  - **Anything that spawns goes through `trackChild`**
    ([`packages/rman/src/utils/child-tracker.ts`](../../packages/rman/src/utils/child-tracker.ts)), so an
    interrupted rman kills it. The registry used to be private to `exec.ts`, which meant a `runBin`
    child - i.e. every plugin's and `.rman/*.mjs` command's child - survived a Ctrl-C. Measured both
    ways on the same build: with the call the child is gone, with it commented out rman exits and
    `sleep` is still running.

- **Scope boundary, and state it when documenting either side:** `.rman/*.mjs` is for *one*
  repository-level operation with logic of its own; a shell step across every package is
  `run.<script>`, which already owns the scheduling, topological order, `bail` and progress panel.
  A loop over packages written inside a command module reimplements all of that and loses it.
- **A broken module warns and is skipped; a clash with a *built-in* throws.** Not an inconsistency:
  a module that fails to load affects only itself, while `rman publish` resolving to two different
  things has no safe guess. Both name the file and the reason.
- **A clash with a *contributed* command is neither - the repository wins.** A `.rman/clean.mjs`
  in a repository that inherits `clean` simply becomes `rman clean`: the intended escape hatch, and
  the same precedence a package's own `.rmanrc` has over an `extends` base, so don't "fix" it into
  an error.
  - **One registration per name, keeping the last** (`byName` in `cli.ts`), which is the precedence
    yargs already applied - made explicit rather than left to it. Both used to be registered, and
    what that cost was the help output: measured, `rman --help` listed `deploy` twice, once with
    each description, with nothing to say which would run. Only the listing was wrong - `rman
    deploy --help` already showed the winner's options alone and the loser's flag was rejected.
  - **Said out loud at `verbose`, because deduplicating silently is what would make this the trap
    it used to be**: two rows at least hinted something was doubled, while one row and no note
    leaves "my plugin's command does nothing" with no thread to pull. Not a warning - an override is
    a correct thing to do.
  - The note reads `--log-level` **straight off argv** (`argvLogLevel`), the way `-v`/`-h` are
    answered: commands are registered before `parseAsync`, since registering them is what makes
    parsing possible, so a diagnostic emitted there cannot come from `args.logLevel`. Measured - it
    was silent for `--log-level verbose` and appeared only when `.rmanrc` said so.
- **The built-in name list is derived, not written** (`builtInNames` in
  [`src/cli.ts`](../../packages/rman/src/cli.ts)): it walks the same `commandRegistry` the commands are
  registered from, so the two cannot disagree and adding a command can't quietly leave a
  repository's own able to shadow it. It was a hand-maintained array pinned by a spec, which is what
  declaring commands replaced. Aliases count (`ls` is `list`); `completion` is yargs' own and is the
  one name still written down. It covers **built-ins only**, which is why the rule above differs for
  plugins - and note that `publish` crossed that line when it moved into the core, so a
  `.rman/publish.mjs` that used to win silently is now a clash that throws.
- **A bare name in `extends` resolves through the *repository's* `node_modules` first, and falls
  back to whatever is installed beside rman itself** (`resolveConfigTarget` / `resolveBesideRman` in
  [`src/core/resolve-target.ts`](../../packages/rman/src/core/config/resolve-config-target.ts)). **`extends` is now its
  only caller** - `plugins` takes an instance or a glob and resolves no names at all, so the error
  quoted below can no longer come from that key. A globally installed rman's siblings are the
  globally installed packages, which is what makes the bootstrap work: `rman ci` exists to create
  `node_modules`, `ci` is `rman-node`'s command, so on a fresh clone the package cannot be found in
  the directory the command was going to make. Measured on the `plugins` spelling of the day - with
  both installed globally, a clone answered `target "rman-node" could not be resolved ... is it
  installed in this repository?`, which was true and useless.
  - **A fallback, never a search order.** The repository is always tried first and its copy always
    wins, or a global install could silently override a pinned one.
  - **Not gated on whether the repository looks installed**, and the gate that was tried is the
    lesson: "fall back only when there is no `node_modules` above the config file" reads well and
    behaves unpredictably, because that walk reaches the filesystem root - a checkout under any
    directory that happens to have one (a home directory, a nested clone) silently lost the
    fallback. A rule whose answer depends on where the repository was cloned is worse than the
    looser one.
  - `resolveBesideRman`'s `from` parameter is the test seam: the answer depends on where rman's own
    module sits, so a spec inside this repository could otherwise only prove that this repository
    sees its own `node_modules`.
- **`plugins` arrives through `extends` too, commands and seams alike.** The root's level is read by
  `ConfigReader`, which has already resolved `extends` - so a shared config package
  can deliver a whole toolchain and a repository writes one line. Measured: with nothing but
  `{ "extends": "shared-config" }`, `rman clean --dry-run` ran and `rman list` found the workspace
  packages, i.e. the inherited entry brought the manifest reader and workspace provider along with
  the command. It is read **once, from the root, before the packages are known**, which is why it is
  root-level and why a `plugins` entry in a package's own `.rmanrc` is never read.
- **`.rman/` is the default value of `.rmanrc "commands"`, not a mechanism of its own**
  (`defaultCommandGlobs`). A glob key was going to sit *beside* the directory scan, and that is a
  third source of repository-level commands and a third precedence question - the shape rejected
  for `clean` ("two commands with one name and a rule between them"). Folding the directory into
  the key leaves one source, one slot, and a zero-config path that behaves exactly as before.
  - **A relative glob is anchored to the file that declared it**, in `mergeConfig`
    (`anchorContributions`),
    which is the last moment the answer is known: `commands` always appends, so one resolved list
    holds entries from the repository's `.rmanrc`, each `extends` base and every directory above,
    and `ORIGINS` records one file per *key*, not per element. After the merge there is nothing
    left to attribute an entry by.
  - **`plugins` does not work this way, and that asymmetry is deliberate.** `loadPlugins` resolves
    every entry against `<rootDir>/.rmanrc` whatever file declared it, so a shared config writing
    `plugins: './x.js'` looks in the *consumer's* root. It does not bite in practice because shared
    configs use the object form or a package name. `commands` is the side worth being on, and the
    reason is the payoff: a shared config can ship commands without wrapping them in a plugin.
  - **Always appends** (`ALWAYS_APPEND`), like `plugins`: naming a directory of your own never
    means "and stop loading the ones my shared config ships". Consequence to state rather than
    hide - a closer layer cannot un-say one, and declaring a **glob** anywhere replaces the
    `.rman/` default, because the key appends across layers and not onto a built-in fallback.
  - **Trap: a glob replaces that default and an instance does not**, so a shared config shipping
    its commands as `'./commands/*.js'` silently takes the `.rman/` directory away from every
    repository inheriting it. Measured both ways on one pair of repositories: with the base
    declaring instances, the consumer's own `.rman/hello.mjs` is in `rman --help`; with a glob it
    is simply gone. **A config meant to be inherited lists its commands individually.**
  - **Not a root-level key**, unlike `plugins`: a package's own `.rmanrc` may contribute. The
    commands stay repository-wide - there is one command list - so a package declaring one is
    contributing it to the repository. The cascade then names the same glob once per package, so
    `commandEntries` dedups by pattern and the loader again by resolved file; two different globs
    can name one file, which is why the second pass is the one that matters.
  - **Both export forms are accepted**, and the same pair is accepted for a command written
    straight into the key - one key, one set of rules. The declarative factory is stored unrun and
    executed in `cli.ts` where `app.repository` exists.
    **The file name is the fallback for `command`** on either form - a convention a file has and a
    plugin does not, which is why `checkCustomCommand` refuses nameless metadata and `cli.ts`
    fills the name in before calling it. The name for the clash check comes from what the factory
    *returned*, not from the file, or the check compares something yargs never registered.
  - The error for a module that exports nothing usable says **"no command exported"**, not "no
    default export": measured on a real package, a module exporting the declarative form was
    refused as having no default export, which it plainly had.
- No matching file means no imports. Every `rman` invocation runs this, `info` included, so that
  has to stay true - it costs one glob now rather than one `existsSync`.
