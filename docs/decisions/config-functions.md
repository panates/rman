# Functions in config and function steps

Design decisions moved out of `CLAUDE.md`. Covers Value functions and `value`, step functions, `STEP_PATHS` / `CODE_SUBTREES`, the console capture in `RunService`.

## Functions in config: two kinds, and the key decides which

A config value may be a **function**, and there are two entirely different meanings depending on
where it sits. Both live in one config, so the rule has to be decidable without looking at the
function:

| | |
| --- | --- |
| `run.<script>`, `run.<script>.before`/`.exec`/`.after`, `run.<script>.if`, `version.before`/`.exec`/`.after` | **code** (`STEP_PATHS`) - left alone, called later by `run`/`version` |
| `plugins`, `commands`, `publishTargets`, and everything below them | **code** (`CODE_SUBTREES`) - a `Plugin`, a command and a target are functions all the way down |
| everything else | **a value** - called by `interpolateConfig`, exactly where a `${{ }}` would be |

- **The key decides, and it already did.** `run.build.exec: 'tsc -b'` is a shell command and
  `publish.npm.directory: 'build'` is a path - not because of anything about those strings, but because
  of where they sit. A function inherits the rule, so there is no marker to remember. **Never
  replace this with a test on the function** (arity, parameter names): that is the guess
  `loadPlugins` refuses to make about a module's export, and here guessing wrong means either
  running build-time code while merely *loading* the repository or silently never running it.
- **`plugins` has to be in the list, and it was measured the hard way**: with it walked like any
  other key, resolving the config of a repository that named a plugin called that plugin's yargs
  builder with the config scope - `Config function in "plugins[0].commands[0].builder" failed:
  cmd.option is not a function`.
- **`run.*` (the bare shorthand) and `run.*.if` are in `STEP_PATHS` for reasons that are not
  symmetry.** `run: { build: fn }` means `{ exec: fn }`, so leaving it out made the short and long
  spellings disagree about *when* the function runs. And an `if` called at load time collapsed to
  the boolean it happened to return, which `parseIfExpr` then read as "no condition given" - so the
  script ran unconditionally (measured).
- **A string at a step path is still interpolated**, so this is narrower than `DEFERRED_PATHS`:
  `exec: 'tsc -b ${{ file.resolve(...) }}'` has to keep working.
- **A caller interpolating a *fragment* must say where it sits.** `interpolateConfig`'s `at` option
  exists for `version`, which resolves its own `version.<slot>` because those three paths are
  deferred. Without it the fragment starts at the root, matches no step path, and a function in a
  version hook was called while the hook was being *prepared* - measured, failing inside the user's
  own code with `path.join` receiving undefined.

## The value kind: the JS spelling of `${{ }}`

Same question, same moment, same scope - `pkg`, `repository`, `file`, `env`, `semver`, `path`, plus
the config's own top-level keys - **plus `value`**: what the key resolved to in the layers
underneath, which is the general form of `+key` and the one thing an expression cannot express.

- **The chain is built during the merge, not at resolution.** Only `mergeConfig` knows the layer
  order; by the time `interpolateConfig` runs they have collapsed into one object and a closer
  layer's value has already replaced what it was derived from.
- **It lives on the containing object under a symbol (`PREVIOUS_VALUES`), keyed by the key.** It
  began as a wrapper around the *function* - the only kind of value you can hang a property on - and
  that is exactly why it had to move: `value` belongs to an expression string just as much, and a
  string carries nothing. A symbol is invisible to `Object.entries`, `JSON.stringify` and js-yaml,
  so it travels through `mergeConfig` and `rman config` without either knowing it is there.
  (`finalizeConfig` rebuilt objects from `Object.entries` and had to copy it across by hand; it went
  with `+key`, which is what it existed for.)
- **Each entry is a link, not a slot.** Three layers each deriving from the one below need
  `A <- expr2 <- expr3`, and a single slot loses `A` the moment `expr3` arrives. Resolved bottom-up,
  so a layer is always handed a finished value rather than a half-resolved expression.
- Only a function or a string containing `${{` gets a chain recorded (`carriesPreviousValue`) -
  nothing else can ask for `value`.
- **The two contexts expose the same names, with no asymmetry, and that is an invariant with a test
  on it.** `value` was function-only at first, on the reasoning that a string could not carry an
  inherited array back - **wrong**, since a string that is *nothing but* one expression keeps the
  value's own type, so `"${{ [...value, 'x'] }}"` returns a list. It is bound on the interpolation
  context now, which the function's argument inherits through its prototype, so the two spellings
  cannot disagree. They cannot drift by accident either - the argument *is* the context with nothing
  added - but a member defined straight onto the argument would split them silently, and what a
  config author would meet is a name that works in one spelling and not the other. The spec
  enumerates both sides rather than checking a list someone has to remember to extend.
- **Nothing may *read* `context.value` on the way to calling a value function.** It is bound as a
  getter that records whether the value actually asked for it, and `callValueFn` reading it to pass
  it along as an argument tripped that getter before the function ran - putting the `value` hint on
  every unrelated failure. Caught by the spec written for exactly that. The function gets `value`
  through the prototype; there is nothing to pass.
- The argument object is built with the interpolation context as its **prototype**, never spread
  from it. Those top-level keys are lazy memoized getters (so key order in the file means nothing
  and a cycle is reported rather than half-resolved); spreading would fire every one on every call,
  and one of them throwing would blame the wrong key.
- **`value` spreads as empty when nothing below set the key, so `[...value, 'x']` needs no guard**
  (`ConfigInterpolator._previousValue`'s `UNSET_MARKER`). That case is not exotic: a value written to extend an inherited
  list is also the *first* layer in a repository that inherits nothing.
  - **It was `undefined`, with `value ?? []` required at every site, and the reasoning for that was
    half right.** Defaulting to a plain `[]` would indeed be a guess about the key's type - so the
    stand-in is an empty array that **refuses to be a string or a number**, and a non-list use
    throws naming the key rather than quietly getting `''` or `'1'`. Measured on the three shapes:
    `[...value, 'x']` -> `['x']`; `` `${value}-x` `` -> throws; `value + 1` -> throws. That last one
    is a case the old answer got *wrong*: `undefined + 1` is `NaN`, which serialized to `null` and
    read like a configured value.
  - **An array rather than a bespoke object, so configs already written keep working**: `value ?? []`
    returns it (not nullish), and `.length`/`.map`/`.concat`/`.join`/`Array.isArray` all behave as
    before - measured one by one. The single consequence is that `value === undefined` is now
    `false`; ask `value.length === 0`.
  - The sentinel's own error carries `rmanValueHint`, so `walkWithPrevious`'s catch leaves it alone.
    That catch still adds a note when a value **read `value`** and then failed for a reason of its
    own - recorded through a getter, never inferred from V8's wording. Without that second condition
    the note went out with *every* failure of a first-layer function: a frozen-object `TypeError`
    from `read()` arrived wearing advice about spreading an inherited list, which is the
    send-the-reader-to-the-wrong-place mistake it exists to prevent.
- **A chain on the *source* of a merge is carried over, like its `ORIGINS`** (`assignMerged` ->
  `graftChain`). The link below a key used to be recorded only for a key being **replaced**, and the
  shape that broke is the ordinary one for a shared config: a base and its consumer both writing
  `"[*]"`. Those two blocks merge into one before `matchingSelectors` sees them - recording the
  chain on the merged block - and that block is then merged into a `result` that does not hold the
  key yet, so there was nothing to chain onto and the source's chain was dropped.
  - Measured: a base declaring `clean.include: ['build']` and a consumer's `"[*]"` deriving from it
    answered `['dist']`, losing `build` outright. An **unmarked** key and a **differently named**
    selector always worked - they merge into a target that already holds the key - which is why this
    went unnoticed.
  - Grafted by copying, never in place: a chain is shared by every package that resolved through
    that layer.
  - **Layer order is the selectors' declaration order, across files.** A base's `"[pkg-a]"` is the
    last word even when the consumer's `"[*]"` sits in the closer file - the documented rule, and
    the cost of having dropped specificity ranking.
- **`+key` carried a bug `value` does not, and that is part of why it is gone.** Appending onto a
  value that was a sole expression returning an array **nested** it - measured with a control,
  `{ base: '${{ ["a","b"] }}', '+base': ['c'] }` gave `[['a','b'],'c']` while a literal `['a','b']`
  gave `['a','b','c']` - because the merge promoted the expression *string* to a list and
  interpolation only later turned that element into the array. Removed rather than fixed.

**A value function computes and returns; it must never act - and `FileScope` must never gain a way
to.** Both halves are the same rule, and the rule is about *when*: this runs while the config
resolves, which every command does, so anything a value function or a `file` member *did* would
happen on `rman list`, `rman info` and `rman config`, once per package, with nothing having asked
for it. `file` therefore stays three read-only members (`exists`, `resolve`, `resolveFirst`) - **do
not add `copy`, `write` or `mkdir`**, however reasonable the request sounds.

It has already been tried, in the only way a function that does not exist can be: a shared config
reaching for `file.copyMany(...)` made **every** rman command exit 1 (measured, `list` and `info`
among them). The loud failure was the lucky outcome - had the member existed, `rman list` would have
quietly copied files. And nothing is lost by refusing: work goes in a step, which is the one thing
rman runs on purpose, and a step can be a function too.

## Function steps: a step written as JavaScript

[`src/core/run-step.ts`](../../packages/rman/src/core/interfaces/run-step.ts). `run.<script>.before`/`.exec`/`.after`,
`version.before`/`.exec`/`.after` and `run.<script>.if` each take a **function** as well as a string.
Six step slots and one condition - and that list is the whole surface, because it is exactly the set
of keys whose value is a shell command the *author wrote*. `rman exec <cmd>` takes its command from
argv, and `ci`/`publish`/`docker-publish` build theirs from data (`packageManager`, an image name),
so none of them has anything a function could replace.

- **The reason is *when*, not taste, and it is the whole justification.** A `${{ }}` expression is
  evaluated while the config resolves - which every command does, `rman list` included - so it can
  only see the state the config loaded in, and anything it *did* would fire on every invocation.
  Measured, and it is how this started: a shared config with `after: '${{ file.copyMany(...) }}'`
  made **every** rman command exit 1, `list` and `info` among them. A function runs when its turn
  comes. Don't answer "I want to run JS in a step" by adding a side-effecting member to the `file`
  scope; `file` answers what is on disk and must stay a query.
- **A string step stays a shell command**, and dropping the `${{ }}` does not turn one into an
  expression - the string goes to `/bin/sh` verbatim (measured:
  `syntax error near unexpected token`). There is no third form between the two.
- **`process.cwd()` is never changed, and cannot be.** A shell step is a child process and gets a
  real working directory; a function runs inside rman's own, and `run` executes packages
  **concurrently** - one `process.chdir()` would move the ground under every step running beside it.
  So `ctx.cwd` is handed over and a relative path in a step resolves against wherever rman was
  invoked. Measured, and silent: a hook writing `fs.appendFileSync('steps.txt', ...)` landed in the
  repository root while the shell steps beside it wrote to the package. `ctx.runBin` is pre-bound to
  `cwd`, so a binary run through it needs no care.
- **`ctx.vars` is the slot's own scope** (`scopedVars` in `run.service.ts`): the top-level `vars`,
  then each block down to the script - `run.vars`, `run.<script>.vars`, or `version.vars` in a
  version hook - closest last, exactly what `${{ vars.x }}` resolves to beside it. It was missing,
  so a function step could see no scoped `vars` while a shell step in the same slot could:
  `@panates/rman-preset` moved `copyFiles` into `run.build.vars`, its `after` function read
  `pkg.config.vars`, and README and LICENSE stopped reaching the build directory. Read back from
  `pkg.config`, which keeps every resolved `vars` block, rather than re-walking the interpolator.
- **The context is `pkg`, not `package`** - matching `${{ pkg }}` rather than
  `CommandContext.package`. `package` is a reserved word, so that spelling forces every author to
  rename while destructuring (`{ package: current }`, as `check.js` does). The two contexts
  therefore disagree on this one name, deliberately; an object either way, so a member added later
  breaks nothing.
- **Failure is a throw**, as a non-zero exit is for a shell step and as `runBin` already rejects. A
  step that can only report trouble by returning something nobody reads is a step that passes while
  doing nothing.
  - **Its message is reported by `runFunctionStep`, because nothing else does it.** A shell step's
    reason arrives on its own - the output streams out and `exec` names the command and its exit
    code - while a function step's throw goes to the catch that marks the package failed and
    rethrows an error the CLI treats as already-logged. Measured on a real config whose build step
    threw a worded explanation of a missing `tsconfig.json`: the run printed
    `error build pkg-forgot ┆ exec failed ┆ buildWithTsc`, exited 1, and the message appeared
    nowhere - so the one line that said what to do was the one line dropped. Written where a shell
    step's output goes: through `onLine` with the panel on, to stderr with it off.
  - **A *falsy* throw used to read as success.** `let stepError: any` plus `if (stepError) throw
    stepError` meant `throw undefined` - legal JavaScript, and what a rejection carrying nothing
    gives you - printed **success** and exited 0. Normalized to an `Error` now. Only the panel-off
    path had it; with the panel on there is no local catch. Found by the spec written for the
    message fix above, which is the only reason it is not still there.
- **One console patch for the whole run, routed per step by `AsyncLocalStorage`**
  (`RunService.withCapturedConsole`). Patching per step and restoring "the original" works for one
  step and corrupts the console for every run with two:

      A patches   -> A's "original" is the real console
      B patches   -> B's "original" is *A's patch*
      A restores  -> console is real again
      B restores  -> console is A's patch, for the rest of the process

  Measured on a twenty-package build with sixteen running at once: afterwards `printSummary`'s own
  `console.log` calls went into a finished package's log array, so the run printed **no recap and
  no failure logs at all** - 16 failures, and the only thing on screen was `✖ build 30.9s`. The
  depth counter is what restores the *pristine* console rather than whatever was installed when
  this step started.
  - **`AsyncLocalStorage` is what makes one shared patch route correctly.** The steps interleave on
    the event loop, so the call stack cannot say which package a `console.log` belongs to, and
    `await` inside an author's function is exactly what it propagates through. A log from outside
    any step - a timer a step left running - finds no store and reaches the real console.
  - **Exported from the namespace as a seam.** A spec cannot reach it through `run()`: the panel is
    `isTTY && progress`, so under a test runner it is off and no capture happens at all. The three
    cases drive it directly, and the control (per-step restore) turns the concurrency one red.
- **`console` is always redirected, panel or not**, into the step's `output` events. It used to be
  panel-only, and with no panel a function's `console.log` was then the one kind of step output a
  plain run could not lead with its package, and that `--json` and the log file never saw.
  - **That surfaced a leak**: `withCapturedConsole` chained its restore onto
    `Promise.resolve(consoleSink.run(...))`, and a plain function throwing synchronously left before
    the promise existed - the depth never came down and every later step captured nothing. Seen as
    two specs in another describe block failing only after the function-step ones; pinned by "hands
    it back when a step throws synchronously", with its control run.
- **Only the JS config forms can hold one** - YAML cannot, and don't paper over that with a
  `js: './file.mjs'` step: it buys nothing over the `node ./file.mjs` a YAML repo would write
  anyway, and adds a second mechanism. A YAML `.rmanrc.yml` that `extends` a JS config **does** get
  that config's functions (measured), so a shared config package can use them on behalf of
  repositories that stay in YAML.
- `.rmanrc.cjs` is checked before `.mjs`/`.js` and beats `.rmanrc.yml`. **`require('rman')` in a
  `.cjs` is not safe on every supported Node**: rman is ESM-only and `require(esm)` arrived in
  20.19, while the engine floor is `>=20.0`. The `/** @type {import('rman').RmanConfig} */` form
  imports nothing and always works - which is why `@panates/rman-node` uses it.

**Two things this fixed on the way, both of which were bugs on their own:**

- `normalizeScriptValue` used to `return []` for anything it did not recognize, so a function in
  `after` produced `1 succeeded, 0 failed` with the step never run (measured). It throws now, naming
  the config path and the index. A configuration mistake has to be loud.
- **`VersionService` carried a second `normalizeScriptValue`** that joined an array with `' && '`
  into one shell line and dropped non-strings. Both had to go - a function cannot be a term in a
  `&&` chain, and `cd x && y` in one process was never the same as two steps. `RunService`'s is the
  only implementation now, and `runLifecycleSlot` takes a list rather than one joined string.

**Serializing a config is now a thing that can fail, so it goes through `printableConfig`**
([`src/utils/printable-config.ts`](../../packages/rman/src/utils/printable-config.ts)): `rman config` and
`--config` print `[Function: copyDocs]`. This was already broken before functions existed - a
`plugins` entry in its object form carries the plugin's seams, and `rman config --root` died with
`unacceptable kind of an object to dump [object Function]` on a repository that merely `extends`-ed
a plugin package. In `--json` it was worse and quieter: `JSON.stringify` drops a function-valued key
entirely, so the step simply vanished from the output.

**A failing command says its reason once, and used to say it twice** (three times for `rman
version banana`). yargs rejects `parseAsync` with the handler's own error, not with the one the
`fail` handler throws - so marking only the latter `logged` left `runCli`'s catch printing the same
line again on stderr. The `fail` handler marks the handler's error too now; pinned in `cli.spec.ts`
("a failing command"), whose control turns red without it.
