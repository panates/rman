# `run`, `list` and `clean`

Design decisions moved out of `CLAUDE.md`. Covers `RunService` rows and steps, hooks composing, `run.<script>` key levels, question C, `CleanService`.

## `clean` - in `rman-node`, not the core

Everything its built-in behaviour knows how to delete is a **TypeScript** fact: a compiled
`.js`/`.js.map`/`.d.ts` beside its `.ts` source, a `*.tsbuildinfo`, and a `node_modules` to skip
while looking. Nothing in it would fire for a Cargo or Go repository - both of which ship
`cargo clean`/`go clean` anyway - so a core `clean` was a command that only appeared general.
Measured after the move: without the plugin `rman clean` is `Unknown argument: clean`; with it all
four behaviours still fire.

- **`clean.*` is contributed by the command**, like every built-in's own key: `skip` derived from
  its `config` block, `include`/`exclude` through `Extra` because a `CommandOption` cannot say "a
  glob *or* a list of them" - and that union is what a config author writes. **The contribution is
  declared in `rmanrc.augmentation.ts`, not beside the command**, and only because of the one-block
  rule: re-measured while moving it, a second `declare module 'rman'` left
  `SystemInfo.PackageManager` unresolved at four call sites. rman's own commands augment a *module
  path*, which has no such limit.
- **`clean.include`/`clean.exclude` moved with it**, and they are genuinely ecosystem-neutral - that
  is the cost of the move, named rather than hidden. A repository wanting only the globs has to name
  the plugin, or write the `rm` lines as a `run` script. The alternative was a stub `clean` in the
  core plus this one, i.e. two commands with one name and a precedence rule between them.
- A `.d.ts` with **no** matching `.ts`/`.tsx` is left alone - that is a hand-written declaration,
  not build output. Don't "simplify" that check away.
  - **The `.js` it declares stays too, `src` included** (`isDeclaredByHand`). Measured on
    `panates/hl7v2`: a generated plain-JS data module in `src/data` with its `.d.ts` was swept by
    the preset's `rman clean` before every build, and esbuild then failed on the *import* - an error
    nowhere near the cause. The cost: a tsc orphan pair whose `.ts` was renamed now stays whole.
  - **`clean.exclude` reaches this sweep as well as `include`'s**, so a file the rules misread has a
    way out. It used to filter `include` alone.
- Never touches `node_modules`; that is `ci`'s job.
- **A symbolic link is removed as a link and never followed** - every glob in `clean.service.ts`
  says `followSymbolicLinks: false`, and a match is `lstat`ed. fast-glob follows links by default,
  so `build/node_modules/@syncbridge/common` (a link into a sibling's build) was walked into: cleaning
  `syncbuild` emptied `common/build` on `panates/syncbridge`, then failed `rmdir` on the link with
  `ENOTDIR`. **And a failure is said with no panel too** - it went only into the item's `log`, which
  nothing replays without a panel, so a build's nested `rman clean` reported `0 succeeded, 1 failed`
  and no reason.
- `clean`, `ci` and `install` are the commands still wholly `rman-node`'s. `publish` is no longer one of
  them - see above. Both are **declared**, not built, like every built-in.

## `list` / `run`

- **The row is `<name> <step> <elapsed> | <command>`, and the command is last for a reason.** It is
  the one field with no bound on its length - a `tsc -b` line carries a path, a `run` step carries
  whatever the author wrote - so between the step and the clock it put the elapsed time in a
  different column on every row and pushed it off the end once a command was long. Everything
  fixed-width reads down a straight edge now and the variable part runs off to the right, where
  `truncate` cuts it.
- **A function step's child output is *captured*, not passed through to the screen** (`runBin`'s
  `onLine`, threaded from `runFunctionStep` through `createStepContext`). `RunService` already gave
  `exec` an `onLine` so a shell step's output lands in the panel's item log and shows as that row's
  last line; `runBin` had no equivalent, so it streamed its child straight to the terminal through
  the live region. Same panel, two contracts - measured on a failing build of a twenty-package
  repository: a shell step showed `✔ check 554ms` on its row while a function step's `tsc` wrote
  every one of its errors to the screen, scrolling the panel. A failed step's log is still printed
  once, at the end, which is what the shell path already did.
  - **`onLine` forces `pipe`.** Left to the default a caller at `info` gets `inherit`, so
    `child.stdout` is null and the callback never fires - an option that silently does nothing.
  - It also suppresses the reprint on failure: the caller is showing those lines somewhere of its
    own, and writing them again would double them and scroll whatever it is drawing.
- **A function step reports what it *spawns*, not only its own name** (`createStepContext`'s
  `onCommand`, wrapped around the bound `runBin`). `buildWithTsc()` is all the slot knows, and it is
  what the row showed for the whole of a build; the reader wants the `tsc -b <tsconfig>` inside it.
  The name comes back in a `finally`, or a step that spawns once wears that command for the rest of
  its run. A function step is the shape every shared config uses, so this is the common case.
- **`exec` and `ci` set `currentCommand` too, and used to set neither** - `exec`'s is the one command
  it runs everywhere (set once where the item is made), `ci`'s is set inside `runStep`, which is also
  what keeps `wipe` out of it: a wipe runs no command. `clean` still sets none, because its `ts`/
  `glob` labels already say what is happening and there is no shell command behind them.
- **The progress panel's row names the command, not just the slot** (`ProgressItem.currentCommand`,
  set from `step.command` or a function step's own name). `before (2/9)` answers "which slot",
  which the reader already knows; a row sitting there for ten seconds with nothing on stdout is
  what the panel was hiding, and for a build it is the common case.
  - **A failed package stays on the list, under the ones still running.** It used to vanish the
    moment it failed, so on a long run the only sign anything had gone wrong was a count in the
    header. Below the running rows and only with the space they leave - work in progress is what
    the panel is for, and a repository that fails early would otherwise fill the block with corpses
    and push the live rows off the screen. One line each rather than two: a failed row's value is
    that it is *named*, and its output is replayed at the end. What does not fit is counted
    in the one trailing `… and N more` line, which now covers both kinds.
  - **The replay is the failing step's output, the passing steps a line each** (`ProgressItem.steps`,
    `ProgressPanel.stepRecap`, filled by `PanelReporter` from the `start`/`end` events). It was the
    whole log, on the reasoning that an earlier step can explain a later failure; in a real build
    that put `rman check`'s file count and its own recap above every lint error. The user's call.
    `log` is still kept flat, and is what `ci`, `exec` and `clean` - which report no steps - replay.
  - **A failed row names the command that failed, not the step's own name.** `createStepContext`
    hands the step label back on a *successful* `runBin` only; a rejection skips it, so the row
    keeps the `tsc -b <tsconfig>` that exited non-zero rather than reverting to `buildWithTsc()`.
    The success path still has to restore it, or a step that spawns once wears that command for the
    rest of its run.
  - **A row forgets its last line when the step or the command changes** (`PanelItem`'s accessors).
    Stale output under a new command is the one kind of wrong that does not look wrong - reported
    from `ci`, where the row read `install (2/2) | npm install` over
    `removed node_modules, package-lock.json`, the wipe's line sitting under the install's command
    as though it were its output.
    - **Accessors rather than a line at each call site.** The sites are four services and a command,
      and the one that forgets leaves no trace.
    - **Cleared where it changes, never at render time.** The panel redraws every 100ms, so
      comparing there would race a line that arrived between the change and the next frame and throw
      away real output.
    - Assigning the same value is not a change, or a driver that re-sets the step on every tick
      would discard the output it just captured.
  - The second line stays the last captured *output*. The command belongs on the first because it
    has to be stable - replacing it the moment the step prints something takes it away exactly when
    a long step is still worth identifying.
  - **Cut from the end, and budgeted against the plain text.** Every field is wrapped in escape
    sequences and `String.length` counts those, so measuring the rendered string leaves the row
    short and gets it wrong again the moment the colours change. It must never wrap: a block taller
    than the terminal breaks the panel's cursor-up arithmetic, which is what the row budget exists
    for too.
  - A driver that names its own steps (`ci`'s `wipe`/`install`, `clean`'s `ts`/`glob`) sets no
    command and the row is unchanged - those labels already say what is happening.
  - **Trap for a spec that *measures* a row:** strip every CSI sequence, not just the colours. A
    redraw also writes `\x1b[2K` and `\x1b[1A`, which a colour-only pattern leaves in - invisible to
    `toContain` and wrong by their length to anything counting characters. Measured: an 80-column
    row came back as 84.

- **`build` and `test` are aliases for `run <script>`, and both are core.** The test is what the
  command *knows*: a script name and nothing else. A Cargo repository declaring `build: 'cargo
  build'` is served by the same file as a Node one, which is why neither sits in the `node` preset -
  the line `clean` is on the other side of, since everything `clean` knows how to delete is a
  TypeScript fact.
- **There was a `lint` beside them and it was removed; do not add it back.** Linting is the one of
  the three where **the repository decides what to use**, and an alias is not neutral about that:
  `rman lint` claims the name for `run lint`, and a built-in name cannot be shadowed
  (`assertNoBuiltinShadowing` throws - see "A repository's own commands"). So a repository whose
  linting is one eslint run *at the root* - which is what a flat config already covers, and what
  makes a per-package `run lint` reload the config once per package and still miss the root's own
  files - could not contribute a `lint` command at all. Measured on `@panates/rman-preset`, which
  ships exactly that command: with the alias present, every rman invocation in a repository
  extending it died with `would shadow rman's built-in "lint" command`.
  - `build` and `test` are not in the same position: both name a per-package script that rman
    orchestrates, which is the thing `run` exists for. A repository wanting its own `build`
    *command* is in the same bind, and that cost is stated rather than hidden - it is just not one
    anybody has hit.
  - `rman run lint` is unchanged, and so is every `run.lint` key.
- **Neither owns a config key.** `build` is `run build` under another name, so its settings are
  `run.build`, which belongs to `run` - the two declare `configKeys: ['run.<script>']` and
  contribute nothing. Two commands cannot contribute under one top-level key anyway (interface
  merging is not a deep merge), and these never needed to.

- **A `run.<script>` key is not read at one uniform level, and the wrong level fails silently.**
  `RunService` reads `concurrency`, `progress`, `changed` and `changedSince` off
  **`repository.rootPackage` only** - there is one scheduler and it needs one answer for the whole
  batch - while `logLevel`, `skip`, `if`, `override` and the step slots are per package. Measured,
  because nothing reports it: two packages of 1.5s each, `concurrency: 1` under `"[*]"` still ran
  them at once (1.8s); the same line under `"[/]"` serialized them (3.3s). `docs/cli/run.md`'s
  example had it under `"[*]"`.
  - **`topo` is read both ways and means a different thing at each**, which is why `topo: false`
    appears to work from either place: the root's picks the *sort* (`getPackages({toposort})`,
    decided once for the list), a package's own decides whether **it** waits for its dependencies
    (`pkgTopo`, `run.service.ts:175`). `bail` is likewise both - the root's is the default, a
    package's own outranks even an explicit CLI flag.
  - **Raising concurrency buys nothing while `topo` is on and the packages form a chain** - the
    dependency edges serialize them anyway (measured: `topo: true, concurrency: 8` is the same 3.1s
    as `concurrency: 1`). For a script whose packages are genuinely independent, `topo: false` is
    the setting that matters, not `concurrency`.
  - **`--parallel` and `concurrency` are deliberately different names**: the flag is
    `boolean | number` (omit/`true` = CPU count, `false` = serially), the key is the number it
    resolves to. Don't "fix" this into one name; do keep the flag's describe text naming the key.
  - **A key read at runtime but missing from `RunScriptOptionsKeys` is invisible to a typed
    config**, and there is no schema behind it any more, so the type is the only reader. `changed`
    sat that way - read since forever, declared never - so a JS config could not write the thing
    that worked. Pinned now in `config.spec.ts`'s `RunScriptOptions` block, with a negative control.

- **A package's own `pre<script>`/`post<script>` and the config's `before`/`after` both run** -
  they compose, and only `exec` replaces (`slotValues` in `run.service.ts`). The two are not the
  same kind of key: `exec` is one answer to one question, so a package declaring `"build"` and a
  config declaring `exec` are the same build stated twice; a hook is a *point*, and two hooks at
  one point both belong.
  - **The config brackets the package's own**, which is what the wider statement means:
    `config.before -> prebuild -> build -> postbuild -> config.after`.
  - **Measured, and it was a silent loss.** A root declaring `"[*]" run.build.before` lost it
    entirely for any package that had a `prebuild` - so adding an unrelated codegen hook to one
    package cancelled a repo-wide `rman clean`, with a stale build directory as the only symptom.
    The control is the same repository with `prebuild` deleted, where the config's hooks run.
  - **`version` uses the same function**, so npm's `preversion` no longer replaces a repository's
    `.rmanrc version.before` either. The rule lives in `RunService` and `VersionService` calls it -
    two copies would drift, and one of them would sit in the file that writes versions.
  - `override: true` is unchanged: the config replaces rather than composes, per slot, which is
    what "ignore what the package says it does" has always meant.
- **An `exec` in the package's own config file beats its `package.json` script, with a warning**
  (`ownsConfiguredExec`, `warnReplacedScript` in `run.service.ts`). Reported from
  `syncbridge-io/syncbridge`: web-ui's own `.rmanrc.yml` chained `npm run type-check && npm run build`,
  its `package.json` said `"build": "vite build"`, and the package script won silently - the type check
  never ran and a TypeScript error went unnoticed for two days, while `--config` showed the configured
  exec. First read as `&&` dropping the first command; measured, the whole configured exec was replaced.
  - **"Own" is read off `rawConfig`'s `ORIGINS`**: the key's file sits in the package's directory (a
    `.rmanrc*` or the manifest's `rman` key). An inherited exec - a directory above, a selector block
    there, an `extends` base - still loses, which a shared preset's `"[*]" run.build.exec` relies on.
  - The user's call: the rman statement wins, and says so, rather than only warning.
- **An empty run has two endings, and conflating them hid a broken CI step for months.** Nothing
  defining the script at all is a mistake - `npm run` fails on it, so does `rman` (non-zero). Every
  package being *filtered out* (`--scope`/`--changed`/`skip`/`if:`) is the correct answer to what
  was asked, and exits zero. The monorepo root's own `<script>` never counts toward "defined": the
  root contributes only `pre`/`post` bookends, which is exactly why a `qc` defined solely there ran
  nothing while reporting success.

- **Question C** (`Repository.listStatus`): `dirty` (uncommitted) / `committed` (`git cherry` -
  committed but not pushed) / `clean`.
- Meant for the development loop ("only build/test what I touched").
- **Never use it for release decisions.** After a push `git cherry` is empty and everything reads
  `clean`, which does not mean there is nothing to publish.
