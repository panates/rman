## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).


## File layout: exported first, private below

Within any `src/**/*.ts` file, top-level exported declarations (functions, classes, namespaces,
interfaces/types) go first, right after the imports. Private (non-exported) helper
functions/consts/interfaces used only within that file go afterward, at the bottom - never above
or between exported declarations.

- This holds regardless of call order - a private helper referenced inside an exported
  function's body may sit far below it; JS/TS function hoisting and closures make this safe.
- When a `services/*.ts` module exports a `namespace` (e.g. `Changelog`, `Ci`, `Run`), the whole
  `export namespace X { ... }` block comes first, and every private module-scope helper it calls
  internally goes below it, outside the namespace.
- When adding a new private helper to an existing file, append it after the last exported
  declaration rather than near whichever exported function happens to call it.

## Config: who a declaration is about

[`src/core/config.ts`](src/core/config.ts). One sentence decides it: **what is written above reaches
below, and a `"[selector]"` narrows the audience.**

- **An unmarked key configures that directory and every package under it.** The repository root's
  own `.rmanrc` is therefore the baseline for the whole repository, the root package included.
- **A `"[selector]"` block narrows it.** Two audiences, and the second is a glob:

  | | |
  | --- | --- |
  | `"[/]"` | the **root package** alone |
  | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | the packages **below** this directory that the glob matches |

  - `/` for the root because that is what a repository root is called everywhere else, and no
    package can be named it.
  - **The CLI shares this vocabulary**: `--scope /` / `--ignore /` is the root package and a glob
    never matches it, so `"[*]"` and `--scope '*'` mean the same set. They disagreed until 2.0 -
    measured, `rman clean --scope 'rman*'` selected this repository's root. See the
    shared-flags section below.
  - **The root is never selected by name, and that one rule removes two traps.** A glob matches
    package names and the root is nobody's child, so `"[my-*]"` cannot quietly pick up a repository
    whose root package is called `my-repo`, and `"[*]"` cannot hand a package-shaped setting to a
    root with no build directory to apply it to. The root is addressed structurally or not at all.
    (That second trap was real: three specs in `repository.spec.ts` broke the day `"[*]"` reached
    the root, all `${{ file.resolve(...) }}` asking about a `tsconfig.json` the root does not have.)
  - **Precedence: unmarked first, then the selector blocks in the order they were written** - later
    wins, as `overrides` does in eslint, prettier and babel. Directory levels closer to the package
    still win over everything above them.
    - **Unmarked is the level's floor wherever it sits in the file.** Written below a selector
      block it still loses to it: it is not a fourth selector but the layer that also feeds the
      directories below, and making that depend on key order would be absurd.
    - **There used to be a ranking (`selectorRank`) and it was dropped on purpose.** Specificity
      only orders sets that *nest*, and globs do not: for `pkg-dialect`, neither `"[pkg-*]"` nor
      `"[*-dialect]"` contains the other, so any answer is an invented tiebreak - worse than the
      order the author typed. What was left was already declaration order with the catch-all lifted
      out of it. The cost, stated rather than hidden: a catch-all written *below* a narrower block
      now overrides it. Writing catch-alls first is a convention, not a rule.
  - **`"[ws:*]"` / `"[workspace:*]"` is accepted and means exactly `"[*]"`.** The qualifier said
    "not the root" back when a bare glob included it; the shape of the set says that now. Kept
    working rather than rejected because both spellings resolve to the same packages - an error
    would be friction with no reader to protect. Retired from the docs; don't write it in new code.
  - The root *package* is the one whose directory is the repository root - no other test, and none
    would be as reliable, since a name can be anything. In a single-package repository that is the
    only package, so `"[/]"` reaches it and `"[*]"` reaches nothing.
- **Every directory cascades, and whether it holds a package changes nothing.** This is the
  correction the design above *is*: the root used to be the one level whose unmarked config stayed
  put, so an intermediate `packages/` reached the packages below while the root beside it did not -
  what a file meant depended on whether a `package.json` sat next to it. `vars` then had to be
  carved out as an exception, which is what a rule fighting itself looks like.
  - **The reasoning behind the old rule was sound and is still true**: the same key does mean
    different things to a package and to the repository. It just does not justify a rule nobody can
    read. The answer is `"[/]"`, which says the audience out loud.
  - **The cost is real and lands on one subtree: `run.<script>`.** Its hooks on the root are a
    repo-wide bookend run once at the repository root; on a package they are that package's own
    hook run in its directory. Cascaded, one declaration is both - once at the root and once per
    package. **A repo-wide bookend belongs under `"[/]"`**, and that is the one migration step that
    is not mechanical. The measured failure it prevents: `node ../../support/postbuild.cjs`, written
    for a package, run at the root where it cannot resolve.
  - The other repo-wide keys (`allowBranch`, `version.*`, `githubRelease.*`, `packageManager`) may
    cascade or not without consequence - nothing reads them at package level - but `"[/]"` still
    reads better for them.
  - Migration from 1.2.x, in three mechanical rules plus that one: `"[ws:*]"` → `"[*]"`; old `"[*]"`
    (which included the root) → unmarked; a root key that is genuinely the root's → `"[/]"`.
- **`vars` is declared at any level of the config and scopes its own subtree**
  (`withScopedVars` in `config.ts`): a fresh copy per level, the level's own block merged **per key**
  over what the level above resolved to, so `run.vars` covers every script and `run.build.vars`
  covers one.
  - **Copied at every node, not only where a block appears**, and that is the difference between
    scoping and leaking: a value function is handed this object, so a write inside `run.build`
    would otherwise land in `run`'s object and `run.clean` would read it. Nothing written at a level
    reaches the level above or a sibling.
  - A level's own block is resolved **against the outer scope** before being installed, so
    `vars: { out: '${{ vars.x }}/dist' }` refines the `x` it inherits rather than reading its own
    half-built scope - which would make the answer depend on key order inside the block.
  - Installed as a plain property over the context's lazy top-level getter and restored in a
    `finally`; `walk` is depth-first and synchronous, so the window is exactly that subtree.
  - **`vars` is reserved at every level**, which costs a script that would have been called `vars` -
    `run.vars` is a scope. Nothing enumerates `run`'s keys as script names, so that is where the
    cost stops.
  - **Every nested options interface extends `ScopedVars`**, and a new one has to remember to: the
    runtime rule is general (any object node scopes) while a type states it one interface at a time,
    so they drift in exactly one direction. They *did* - `vars` worked at every level and
    type-checked at none until this was noticed. `config.spec.ts`'s `ScopedVars` block is a
    type-level pin, checked by `tsc -p packages/rman/test/tsconfig.json`, **not by mocha**.
  - **`run.vars` is the one place the runtime scopes and the type deliberately does not.** `run` is
    keyed by script name, so any encoding that admits `vars` widens the index signature's value type
    - and TypeScript then stops excess-property-checking *every* script's options. Measured on one
    file: with the widened index, `run: { build: { exce: 'tsc' } }` compiles clean; with the strict
    one the typo is caught and `run.vars` is rejected. A key-remapped index
    (`{ [K in string as K extends 'vars' ? never : K]: ... }`) was tried and does not help - the
    remap still produces an index signature claiming `vars`. Catching the typo across every script
    won; a typed JS config casts (`... as RmanConfig['run']`), and YAML is unchecked anyway.
- **`vars` used to be the one unmarked key that cascaded, and is not special any more.** Its
  carve-out is what showed the general rule was wrong: `vars: {x: 1}` means the number 1 to
  everyone, there was no second audience for it to be wrong for, and it had to be exempted one key
  at a time. It now cascades because *every* unmarked key does. Read as `${{ vars.x }}`, overridden
  **per key** by a directory below or a `"[selector]"` block (so redefining one var keeps the rest).

- Selector patterns are **globs over package names**, anchored both ends (`"[*-dialect]"` does not
  match `my-dialect-helper`) - glob, not regex, like every other pattern in rman. Which packages
  each *kind* of selector speaks for is the table above.
- **Trap: in YAML the quotes are mandatory.** A bare `[*]` is a flow sequence and `*` an alias
  indicator - the file fails to load. Write `"[*]":`.
- Any string value may embed `${{ ... }}` - **real JavaScript**, evaluated per package
  (`interpolateConfig`), in **every** string, so there is neither a list of "interpolated keys" nor
  a growing list of substitutions to memorize. Scope: `pkg`, `repository`, `file`, `env`, `semver`,
  `path` (Node's own `node:path`, the platform flavour), **plus the config's own top-level keys,
  bare**.
  - **`file`** answers what is on disk, against **`pkg.dirname`** - so one `"[*]"` declaration asks
    each package about its own directory. `file.exists(p)` returns the absolute path or **`''`**;
    `file.resolve(p)` returns it or **throws**; `file.resolveFirst(...p)` is the first that exists
    or throws naming every candidate - what a build config wanting whichever tsconfig a package
    happens to have should use, since an `exists() || exists()` chain ending in `exists()` leaves
    `tsc -b ` with no argument and tsc then falls back to the directory's default rather than
    reporting the package has none. The `exists`/`resolve` split is the point: the
    empty string is falsy, so `file.exists("tsconfig-build.json") || file.resolve("tsconfig.json")`
    takes the first that exists and *fails loudly* when none do. `''` rather than `undefined` also
    keeps a miss clear of the nullish-inside-a-string guard below. `exists` hands back a path rather
    than a boolean because the caller wants the path - a boolean test plus a second call to fetch it
    would read the disk twice and let the two answers disagree.
  - `pkg` and `repository` share one shape, because the repository root **is** a package: `name`,
    `scope`, `unscopedName`, `version`, `basename`, `dirname`, `relativeDir`, `provider`, `manifest`
    (**not** `json` - renamed, see `PackageScope`). `basename` is the *directory*, `name` the
    package - sqb's root is `sqb.v4` in a directory called `sqb`.
  - `repository` adds `monorepo`, `packages`, `package(name)` - and **nothing else**. Each of those
    says something about the repository *as a container of packages*, which is the only thing it
    knows that `pkg` does not.
  - **`git.{branch,sha,shortSha,dirty}` is top level, beside `env` - not `repository.git`**, which
    is where it was through 1.0.x. A branch name describes no package; it describes the working tree
    every package happens to be sitting in, which is the same kind of ambient fact `env` is. Moving
    it is a **breaking change** to the expression scope, folded into the same major as the core/plugin
    split.
    - **Lazy, and moving it up is what made that fragile.** It shells out to `git rev-parse`, and
      every command resolves config, so a repository never mentioning git must spawn none. One level
      down that was free: `interpolateConfig` did `vm.createContext({ ...scope })`, and a spread
      copies the `repository` *reference* without touching a getter inside it. At the top level the
      spread reads it. So the context is built from **property descriptors**
      (`Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope))`), which carries a
      getter over as a getter. Measured both ways on the same build: 0 git reads with descriptors,
      1 with a spread, on a config that never mentions git.
    - Cached on the **`Repository`**, not in `configScope`'s closure - `configScope` is called once
      per package, so a per-scope cache still means one subprocess per package. Non-enumerable, like
      `_repoScope`, so no deep walk of a package spawns git.
    - This is the same trap `pkg.targetVersion` documents from the other side: *it* is a throwing
      getter, and being enumerable is what made a spread fire it.
  - **`read(path[, format])`** answers what is *in* a structured file, where `file` answers where one
    is. `.json`, `.yml`/`.yaml`, `.ini` by extension; a name that says nothing takes the format
    explicitly (`read('.npmrc', 'ini')`), and an unrecognized extension is an error naming the three
    rather than a guess at JSON. Resolved against `pkg.dirname` like `file`, and it **throws** when
    absent like `file.resolve` - `file.exists(p) ? read(p) : fallback` is the optional form, so no
    second function is needed.
    - **`.env` is the one exclusion on principle**: `env` is already in scope, and a `.env` file
      exists to be loaded *into* an environment by something else - reading one as data would mean
      two different things called the environment. Nothing else is excluded by rule. "No new
      parsers" was tried as a line and did not survive `xml`, which *is* a new dependency
      (`@xmldom/xmldom`) and earns its place because a `pom.xml` or `.csproj` holds a version
      exactly the way a `package.json` does - which is the whole point of a language-agnostic rman.
      A format asking to be added is asking on those terms, not on the parser's.
    - **`xml` returns a DOM, not an object, and that asymmetry is deliberate.** An element can
      repeat, carry attributes and hold text at once, so any flattening picks a convention (`$`?
      `_text`? array-or-not?) and is wrong for somebody. Recognized by extension for the whole
      project-file family (`.csproj`, `.props`, `.nuspec`, `.plist`, ...), since a project file is
      XML whatever its extension calls itself.
      - **Freezing a DOM is safe - measured, not assumed.** A frozen `@xmldom/xmldom` document still
        answers `getElementsByTagName` for a tag first asked about *after* the freeze (the
        live-collection case that would have broken it), reads attributes, resolves namespaces,
        walks `childNodes` and serialises back.
      - **A malformed file must throw.** xmldom reports problems through an `onError` handler and
        otherwise carries on with what it salvaged, so without the check a truncated file came back
        as a half-parsed DOM and the expression reading it simply found nothing - the silent-wrong
        shape `read()` exists to avoid for JSON.
    - **`read('package.json')` works and is the wrong answer.** Which file a package's identity
      lives in belongs to the ecosystem, so that expression is already wrong in a Cargo package
      beside a Node one. `pkg.manifest` / `repository.package(n)?.manifest` is the answer.
    - **Cached on the `Repository`, keyed by `mtimeNs:size` rather than by path.** Both halves were
      measured. Per repository because `interpolateConfig` runs once *per package*, so a per-pass
      cache never helps across them - twenty packages reading one shared file would parse it twenty
      times. Keyed on the stat because **rman writes JSON while it runs**: `version` rewrites every
      bumped manifest and then re-interpolates its deferred hooks, and a path-keyed cache would hand
      those back as they were before the write. `statSync` is 1.3µs against 16.1µs for a read and
      parse, so the guard costs a thirteenth of what it saves; `mtimeNs` is nanoseconds, so a
      same-millisecond rewrite does not slip through.
    - **Deeply frozen once on the way into the cache, and shared.** Every package gets the same
      object, so a mutation would quietly change what the next one sees - the reason `pkg.manifest`
      has always been a copy. Freezing beats copying here: a copy costs 5.6µs on *every* call,
      freezing ~1µs *once*, and it turns the mistake into a `TypeError` rather than an effect at a
      distance.
  - **`${{ }}`, never `{{ }}`**: a config value may carry `{{...}}` for something else entirely
    (`helm template --set tag={{.Values.tag}}`). A bare `{{...}}` is left alone. A literal `${{`
    comes from an expression producing it (`${{ '${{' }}`), as in GitHub Actions.
  - A string that is *nothing but* one expression keeps that value's own type - otherwise a boolean
    setting like `run.<script>.skip` would be unreachable from an expression.
  - Detect that "sole expression" case by **counting matches**, never with an anchored `^...$`
    regex: a lazy quantifier still backtracks to reach the end anchor, so `"${{ a }} and ${{ b }}"`
    parsed as one expression running from `a` to `b` (measured, `Unexpected token '}'`).
  - `vm.createContext` here is a clean scope, **not a sandbox** (`node:vm` is explicitly not a
    security mechanism). None is needed: `exec: "..."` already runs arbitrary shell, so the config
    was never a trust boundary. Don't reach for `isolated-vm`.
  - **`pkg.targetVersion` is bound only inside `version.before`/`.exec`/`.after`.** The version a
    run writes doesn't exist until `version`'s plan is computed, so those three paths are listed in
    `DEFERRED_PATHS` and left *unevaluated* when the repository loads - `version` evaluates them
    itself from `pkg.config` (which holds those paths raw) with it bound, and hands the result to
    `RunService.runLifecycleSlot` as the fallback. Naming it elsewhere fails at load, on purpose.
    - **Trap: the unbound binding is a non-enumerable throwing getter, and both words matter.**
      Enumerable, it fired on the `{...}` spread inside `_repositoryScope` - so *every* command
      died building its scope (measured). Not a getter at all, it would hand back `undefined` and
      put an `app:undefined` somewhere plausible.
  - **A failing expression throws with the config path *and the file*** -
    `Invalid expression in "version.commitMessage" (shared/base.yml)`. A config is merged from a
    directory's own four forms, an `extends` base, every `"[selector]"` block and one layer per
    directory before anything reads it, so the key alone leaves the reader searching all of them.
    `mergeConfig` records the file per key under a symbol (`ORIGINS`), and `walk` keeps a depth-first
    cursor over it (`withOrigin`/`describeAt`). An `extends` base keeps **its own** file rather than
    the one that named it, since that is where the line was written. Relative to the cwd when it
    lies inside it.
    - **Non-enumerable, like `PREVIOUS_VALUES`, and for a measured reason**: `expect`'s `toEqual`
      compares symbol properties, so a plain assignment turned five config-shape specs into diffs
      about bookkeeping.
  - A failing expression throws with the config path holding it. Never pass a mistake through. A
    nullish result is allowed standing alone ("unset") but refused **inside a string**: splicing in
    the word `undefined` yields an `app:undefined` that looks plausible and is wrong.
  - A **changelog template file's** `{{package}}`/`{{version}}` are that file's content, not config
    values - a different system, untouched by this.
- Script hooks are `before` / `exec` / `after` (not `preScript`/`script`/`postScript`), in both
  `run.<script>` and `version`. A bare string in place of a whole `run.<script>` object is
  shorthand for `exec`.

**Trap: a single-package repository has no root bookend.** The root *is* the one package, already
running its own pre/post hooks in the same directory - `RunService` must keep skipping the bookend
when `!repository.monorepo`, or every hook runs twice (measured).

## Config inheritance: `extends`

[`src/core/extends-config.ts`](src/core/extends-config.ts),
[`src/core/merge-config.ts`](src/core/merge-config.ts).

- **`extends`** names configs merged *underneath* the file naming them (a package, a path, or a list
  in declaration order). Resolved **per directory**, after that directory's own forms combine, so
  the directory chain still layers on top unchanged. A bare name resolves through **that file's**
  `node_modules` - `createRequire` must be based on the config file, not on rman's own location, or
  it searches rman's dependencies instead of the repository's.
  - Top level only. `extends` inside a `"[selector]"` block **throws**: the recursive type makes it
    look valid and it would simply never resolve, and each form is checked against *its own* path so
    the error names the file that holds it.
  - **An inherited unmarked key behaves exactly like one written in that directory**: it reaches the
    directory's own package *and every package below it*. The rule doesn't bend for a base, in
    either direction - a shared config aiming at the root alone writes `"[/]"`, and one aiming at
    the packages writes `"[*]"`. (This bullet said the opposite until the selector redesign, and was
    measured wrong: a base declaring `group` unmarked resolves onto the root **and** `pkg-a`.)
- **There is no `+key`, and there was.** It appended instead of replacing; `value` says the same
  thing and says it better - it composes (three layers each deriving from the one below), it can
  reorder or filter rather than only append, and it needs no machinery keeping an append
  *outstanding* until the layer it belongs to turns up (which `finalizeConfig`, also gone, existed
  for). It also carried a bug `value` does not: appending onto a value that was a sole `${{ }}`
  expression returning an array **nested** it, because the merge promoted the expression *string*
  to a list and interpolation only later turned that element into the array - measured with a
  control, `[['a','b'],'c']` where a literal list gave `['a','b','c']`.
  - **A `+key` still in a config is refused, not ignored** (`mergeConfig`), naming the key, the file
    and what to write instead. rman validates no config keys - there is no schema behind `.rmanrc`
    any more - so an unknown key is dropped in silence: measured, a consumer's `+include: ['extra']`
    resolved to the inherited list unchanged, exactly as if the line were not there. A bare `+` is
    left alone, since it names no key.
  - `WithAppend<T>` is gone with it, and with it the two-clause trap on `RmanConfig` that generated
    the append forms for contributed keys.
  - **`plugins`, `commands` and `publishTargets` still append without being asked** - see
    `ALWAYS_APPEND`. There that is what the *key* means rather than a choice made per layer.

## The type is the only config surface - there is no JSON Schema

`rman` **shipped** a JSON Schema for `.rmanrc`/`.rmanrc.yml` (`rman/rmanrc.schema.json`, published
through 1.0.x). It is gone, on purpose, and the reason is the same one that made the plugin split
work: the type composes and a schema does not.

- **Autocomplete comes from `RmanConfig`, so it reaches the JS forms only** -
  `.rmanrc.cjs`/`.mjs`/`.js`, through `defineConfig` or a `/** @type {import('rman').RmanConfig} */`
  annotation. **rman loads no `.ts` config**, so a "`.rmanrc.ts`" in an example is wrong; the type
  reaches the file through the editor, never a compiler.
- **A plugin's keys arrive by `declare module 'rman'`**, so `rman-node`'s `defineConfig` is the same
  function with a narrower parameter and the import is what carries the augmentation.
- **`.rmanrc` and `.rmanrc.yml` are now unchecked, and that is the price.** rman validates config at
  no point during a run - no ajv, no key check anywhere in `config.ts` - so an unknown key in those
  forms was always silent at runtime and the schema was the only thing catching it. Recommend a JS
  config for anything non-trivial; do not answer a "my key is ignored" report with "the schema would
  have caught it".

**Do not re-add it.** Every route was measured, and each fails for a different reason:

- `allOf` + `$ref` *is* JSON Schema's `extends`, and a closed base defeats it:
  `additionalProperties: false` is evaluated against the properties of its **own** schema object
  only, so `{allOf: [core], properties: {clean}}` has the core branch reject `clean`. Draft 2019-09's
  `unevaluatedProperties: false` is annotation-aware and fixes that - but only for the schema
  *declaring* it, so a base closing itself with it rejects the extension just the same.
- An **open base plus a closed leaf** does work (measured, 11/11 on the real document), and then
  needs one published leaf **per combination of plugins** - which no plugin can publish, since it
  cannot know the others.
- **Merging the documents into one generated file** also works, on plain draft-07, keeping `$ref: "#"`
  recursion and the `+key` of the day (measured). But it is not a JSON Schema feature at all: it is a build step of
  our own, the merge semantics (arrays append? conflicts throw?) become ours to get wrong, a
  plugin's fragment alone is not a valid schema (its `$ref`s dangle into the core's definitions), and
  no other tool can read the result.
- None of the three has any answer for a **`.rman/*.mjs` command's own keys** - one repository's, and
  published nowhere. `vars` is the open slot such a command already has (`additionalProperties: true`
  in the schema that was; free-form in the type), and it cascades to every package.

## Which ecosystem a package belongs to

`Package.provider` - `'node'` for one the `node` built-in read, empty when no platform claimed the
directory. Comes from `Platform.name`, and that field means the **ecosystem**, not the file
(`manifestFile` already says `package.json`; a name repeating it carried no information, which is
why it went unused until this existed).

**`Platform` is the narrow type and `Plugin` is the broad one**, and the names were the other way
round until the split. `manifestProvider` is required, which makes the narrow type a *platform* by
definition - a package shipping only commands never touches it, because commands are a config key.
So a plugin carries `platforms?: Platform[]` and an `init`, may provide more than one technology
(`maven` and `gradle` are one plugin, two platforms), and a bare `Platform` is sugar for the plugin
providing only it (`registerPlugin` normalizes that, and the fixtures go through it rather than
poking the two registries).

- **Both must be declared** through `definePlatform`/`definePlugin`, checked by a non-enumerable
  brand. No shape test could replace it: an rman **1.x plugin was `{ name, init }`**, and under this
  split so is a 2.x plugin contributing nothing but an `init`.
- **The brand cannot be a module-scope `const`.** The file layout puts privates below the exports
  and `basePlatform`'s initializer *calls* `definePlatform`, so the const sits in its own temporal
  dead zone: measured, the whole suite failed to load with `Cannot access 'DECLARED' before
  initialization`. A hoisted function resolving `Symbol.for` fixes it, and two copies of rman in one
  process then agree about the mark.
- `RmanApplication` holds both: `platforms` is what every seam iterates, `plugins` is who
  contributed them. **Detection's second condition is `app.platforms.size`**, not `plugins` - what
  it would add is a platform, so what must not already be there is a platform; a plugin registering
  only a command says nothing about which directories hold packages.

- **The escape hatch for code that legitimately knows one technology**: check
  `if (pkg.provider === 'node')` before reaching into `manifest.raw` for something only npm has.
  Reaching in without the check is the bug this replaces.
- **Per package, not per repository**, because `Manifest.read` is asked per directory: a polyglot
  monorepo can hold a `node` package beside a `cargo` one, and a command sweeping `getPackages()`
  has to tell them apart. Measured, with both in one repo.
- Also bound as `${{ pkg.provider }}`, so one `"[*]"` declaration can address a single ecosystem
  (`if: "${{ pkg.provider === 'node' }}"`). Keep the two in step - the expression scope mirrors
  `Package`, and a property on one that is missing from the other makes them disagree about what a
  package is.
- Not a union type, and never make it one: the set of ecosystems is whatever `plugins` contribute,
  so narrowing it would mean the core naming plugins it cannot know about.
- **The *workspace* seam used to be the limitation here, and is not any more.**
  `Workspace.resolve` took the first provider that answered the *root*, so the ecosystem listed
  first in `plugins` decided which directories were packages at all. `Workspace.walk` descends
  instead - see below - so discovery is polyglot too.

## Discovery walks the tree

[`src/core/workspace.ts`](packages/rman/src/core/workspace.ts). `Workspace.Provider` is
`(dir) => string[] | undefined`: **the directories directly below `dir` that hold a package**, or
"not mine". The recursion is the core's (`walk`), so a platform only ever speaks about its own
packages - which is all a platform knows.

One step: take the directory's declared platform if its config names one, else `app.platformFor`;
ask **that** platform where its children are; repeat. `Repository.packages` is that tree flattened.

- **A declaration is held to it.** A platform named for a directory it does not recognize is an
  error naming the file it looked for. The failure it replaces is invisible: the manifest reads as
  nothing, so the package is named after its directory at `0.0.0` and the repository looks fine.
- **A directory is visited once**, or a provider naming an ancestor never terminates.
- **`Package` is handed its platform at construction**, so `Manifest.read(platform, dir)` takes one
  rather than searching. The platform is a fact about the directory, established by whoever found
  it, not re-guessed by whoever reads it.
- **`children` is enumerable and `parent` is not** - one edge, and only one direction can be the one
  a walk follows. `repository` is non-enumerable for the same reason and was the *older* half of why
  a `Package` could never be JSON-serialized: a repository holds every package, so one enumerable
  back-reference is a cycle whatever the tree edges do. Fixing only `parent` would have produced a
  tree that still cannot be dumped.
- **`declare readonly parent?: Package`, not a plain field.** A plain declaration is a *class field*
  under this target, so TypeScript emits `parent;` and every package gets an **enumerable**
  `undefined` that the later `defineProperty` only replaces where there is a parent. Measured:
  `Object.keys(rootPackage)` listed `parent` while `Object.keys(pkg-a)` did not.

## A selector addresses a package; a name is what it calls itself

`Package.selector` is what `"[glob]"` and `--scope`/`--ignore` match. A name is an *ecosystem's*
promise - npm guarantees `package.json#name` exists and identifies the package, and nothing else
does - so selectors matching `pkg.name` left a repository whose technology has no name concept with
packages it could not address at all.

Three sources, first that answers: the package's own `.rmanrc "name"`, its platform's
`ManifestProvider.selector`, the manifest's name. They coincide in every Node repository.

- **A selector is unique, and checked**, because two packages answering to one make `"[that]"` and
  `--scope that` ambiguous *silently*: the config reaches both and `getPackage` returns the first.
  `name` cascades like every unmarked key, so one declaration above two packages is the usual way
  in, and the error says so when that is what happened.
- **`name` and `platform` cannot sit in a `"[glob]"` block** (`assertSelectorBlocks`, beside the
  `extends` refusal): the glob matches the selector, and those are what the selector is derived
  from. `"[/]"` is exempt - the root is addressed structurally, which is the whole reason it is `/`.
- **`"[/]"` needs no selector, and that did not work.** `resolveConfig`'s gate was
  `if (packageName)`, so the walk skipped every selector block including that one, and `platform`
  under `"[/]"` silently did nothing. The gate is `selector !== undefined || isRoot` now.
- `Repository.listStatus` is keyed by selector too - by name, a technology that does not name its
  packages had all of them answering to `""`.

## PATH for a child process: `BinPath`

[`packages/rman/src/utils/bin-path.ts`](packages/rman/src/utils/bin-path.ts). `exec` and `runBin`
hand every child process a PATH with the repository's **locally installed** executables in front, so
a command an author wrote (`eslint .`) runs the repo's pinned copy rather than a global one. Split by
who owns which half:

- **Which directories** is the ecosystem's, and the core has none. `node_modules/.bin` walked up the
  directory chain is npm's layout; `rman-node` contributes it (`Platform.getBinPaths`). Measured: a
  `run` step calling a binary in `node_modules/.bin` fails with `command not found` in a repository
  naming no plugin, and runs with `rman-node` named.
- **How a PATH is spelled** is the OS's, and stays in the core: `PATH` everywhere but Windows, where
  the existing key's case must be *read* rather than a second one written, or the child inherits two.
- **Every provider contributes, in declaration order** - unlike `Manifest`/`Workspace`, which take
  the first that recognizes a repository. A PATH is a list, and a polyglot repo wants both
  ecosystems' binaries reachable.

**Trap, and it survived the move:** the npm provider puts the running `node`'s own directory on PATH
after its walk, so rman's own bin directory sits ahead of the inherited PATH - a nested `rman` inside
a `run` script resolves to the *globally installed* one. Shim it in `<root>/node_modules/.bin`, which
the walk reaches first.

## Config types: whoever reads a key declares it

[`packages/rman/src/interfaces/rman-config.interface.ts`](packages/rman/src/interfaces/rman-config.interface.ts)
is **purely a typing aid** - rman never reads it at runtime, it only ever sees the plain object a
config file exports. So the split is about who can *author* what, and it follows the code.

**`RmanConfig` is the *author's* view; `pkg.config` is `ResolvedConfig`, derived from it.** One type
cannot answer both questions, because a value may be written as a **function** and by the time
anything reads a config that function has been called. `Resolved<T>` (in `core/config.ts`) is that
derivation - one transform, applied at `Package.config` and at `interpolateConfig`'s return - so
there is no second type to keep in step by hand.

- **The direction was measured wrong first.** Widening `RmanConfig` while `Package.config` still
  used it moved the cast to every **read** - six sites. The widening was right and leaving the
  reader on the same name was not.
- **Deriving the other way round cannot work, and the reason is the name.** `RmanConfig` is also a
  **namespace** that `rman-node` augments; a `type` alias cannot merge with one, and the circular
  reference resolves to `{}` *silently* - every key then reads as "does not exist". A derived
  *reader* view needs no merge, which is why it is the derived half.
- **`Resolved` has two guards, and each was measured by leaving it out.** Steps are named first
  (`RunStepFn | RunConditionFn`), because `ConfigValueContext` carries an index signature and a
  `run.build.exec` function therefore matched the value-function pattern and collapsed to its return
  type. And `CODE_SUBTREES` is skipped **at every level**, not just the top, because the selector
  index (`[selector]: RmanConfig`) re-enters the config: without it the walk reached
  `Platform.manifestProvider.versionScheme` and rewrote its *methods* - `smallestBump(): string`
  became `string`, the rest became `{}`. **A function with fewer parameters is assignable to one
  with more**, so a zero-argument method matches too; this transform is unsafe over anything
  carrying methods, and the guard is what keeps one out of its way.
- `CODE_SUBTREES` is `as const` so the guard is `(typeof CODE_SUBTREES)[number]` - the runtime list
  and the type cannot name different keys.
- **Which keys may be written as a function is not a per-key judgement for the derived half.** Every
  `target: 'config'`/`'both'` option is a value by construction, so `CommandConfigFromMetadata`
  wraps them all in one place. Only hand-written `Extra` keys are decided one at a time, and only
  `VersionExtraKeys` actually holds both kinds (`stamp` is a value; the three slots are steps). The
  two mistakes are not symmetric - forgetting `ConfigValue` on a value key just means it cannot be
  written as a function yet, while putting it on a step key accepts a value function where a step
  runs - which is why nothing wraps `Extra` automatically.
- Pinned in `config.spec.ts` ("the author view and the resolved view"), by `tsc` rather than mocha,
  with a control per claim: reverting the step guard, the every-level guard, the reader's type or
  the author's widening each turns a different assertion red.

**A command-owned key is declared by the command**, not centrally: `version.*` lives in
`version.command.ts`, `publish.*` in `publish.command.ts`, and `CommandContribution` assembles the
block (see "How a command is declared"). A *target's* block likewise - `publish.docker.*` in
`targets/docker.target.ts`, `publish.npm.*` in `rman-node`. What is left in the one interface file
is what no command owns: `plugins`, `vars`, `logLevel`, `allowBranch`, `ignoreBranch`, `skip`,
`group`, `dependencies`, and `run`.

- **There used to be two files, both exporting a `RmanConfig`** - one for the config shape and one
  for the command declarations - and one package cannot export two things under one name, so the
  second was unreachable from outside rman entirely. They are one file now,
  `rman-config.interface.ts`: `RmanConfigKeys` for the keys no command owns, `CommandConfigs` for
  what the commands contribute, and `RmanConfig` extending both. (It was `rman-cfg.interface.ts`
  while the two coexisted, and took the plain name back once it was alone.)
- **`run` is the one key that stays hand-written, and `Extra` cannot take it.** `CommandContribution`
  wraps a contributed block in `ConfigBlock`, which folds in `ScopedVars` - and `run` is keyed by
  script name, so `vars` would have to satisfy the index signature too. Measured both halves:
  `ConfigBlock<RunConfig>` *does* keep catching a typo inside a script (`run: { build: { exce } }`),
  and `run: { vars: {...} }` still fails with `Property 'vars' is incompatible with index
  signature`. Contributing `run` would gain nothing and add a `vars` nobody can write.

- **`ConfigBlock` gives a contributed key the same shape a hand-written one had** - the keys, their
  `vars`. A hand-written interface said that with three clauses
  (`extends XKeys, ScopedVars`) and every new one had to remember each.
- **Trap: an augmentation only applies where its module is in the program.** The contributions live
  in `src/commands/*.command.ts`, so `index.ts` imports [`src/commands.ts`](packages/rman/src/commands.ts)
  for them - not just `cli.ts`. Reached from `cli.ts` alone, the keys existed for rman and for
  nobody else: `rman-node` reading `pkg.config.publish` got `Property 'publish' does not exist on
  type 'RmanConfig'` (measured). Pinned in `custom-command.spec.ts`.
- **A plugin adds its keys by declaration merging**, not by a separate type nobody's code reads:
  `declare module 'rman' { interface RmanConfigKeys extends NodeConfigKeys {} }`. That is what keeps
  `pkg.config.clean` typed at the place it is *read* (`CleanService`), which a standalone
  `RmanNodeConfig` could never do - the reader holds a `Package`, and `Package.config` is the core's
  type. The augmentation is evaluated where it is used, so `clean` is typed at the place it is
  read.
- **`RmanNodeConfig` (exported from `rman`, with its own `defineConfig`) is the authoring name** - so the import that carries the augmentation is explicit instead of a side effect someone
  has to remember. Named, not a second `RmanConfig`: one name per meaning.
- **One `declare module` block per *package name*, or the others stop applying** - measured while
  the plugin shipped separately: a second `declare module 'rman'` silently disabled the first, and
  `SystemInfo.PackageManager` went unresolved at four call sites with nothing pointing at the cause.
  Bundled, the node plugin augments **module paths** like every built-in command's contribution
  does, so the limit is gone and each interface is augmented where it lives.
  **The replacement trap is `index.ts`**: an augmentation applies only where its module is in the
  program, so `src/index.ts` imports `plugins/node/augmentation/rman.augmentation.js` for its types
  alone - without it `clean` and `publish.npm` exist for rman and for no consumer, and no spec can
  see it (see `npm run smoke`). Every type augmentation therefore lives in
  [`packages/rman/src/plugins/node/augmentation/rman.augmentation.ts`](packages/rman/src/plugins/node/augmentation/rman.augmentation.ts),
  beside the others rather than next to the code it describes. The *runtime* half of an augmentation
  still lives with its own subject (`augmentSystemInfo()`, `augmentManifest()`, ...).
- Measured both ways: with the core alone, `{ clean: ... }` and `{ publish: { npm } }` are
  rejected; with the plugin in the program, `rman-node`'s own `pkg.config?.clean` type-checks.
- `packageManager` is `rman-node`'s. It was core "because `info` reads it", and that stopped being
  true when `SystemInfo`'s npm half moved out: measured, **nothing in the core read it any more** -
  only the declaration was left, and its value set was npm's tooling all along.
- **`dependencies` is core, and must stay.** It layers on top of whatever
  the plugin's manifest provider read, and it is the only way a repository with *no* provider has a
  graph at all - a repo whose manifests rman cannot read can still state its edges by hand.
  - **A `string[]`, and only that.** It used to accept a `Record<string, string>` as well, documented
    in both the interface and the schema as "an explicit name -> range map" - and the ranges went
    nowhere: the single reader took `Object.keys` and dropped the values. Nor could they ever mean
    anything here, since the cascade works from groups and severities and a sibling's range is
    rewritten in the *manifest* - a range declared only in `.rmanrc` has no file to be written to.
    The key states an **edge**, and an edge needs two ends and nothing else. Don't re-add the object.
  - **Each entry is a package name *or* a repository-relative directory**, tried in that order
    (`_resolveDeclaredPackage`). The path form is what makes the key usable outside npm: a name
    identifies a package only where the ecosystem guarantees uniqueness, while a directory is unique
    by construction - the same reason `Package.dependencies` holds references and `Workspace.Layout`
    carries paths. Name first because that is what a Node repo writes, and a package name that is
    also an existing directory path in the same repository does not occur. An entry matching neither
    is ignored, as an unknown name always was.
  - **Trap when writing a fixture for this:** a `"[selector]"` matches **package names**, not
    directory names - `"[app]"` matches nothing when the package in `packages/app` is called
    `pkg-app` (measured, twice).
- **`PublishTarget` is `string`, and both halves of the bug it used to be are gone.** It was
  `'npm' | 'docker'`, the type half of a bug whose runtime half was a hardcoded `['npm']` default in
  `list`/`docker-publish` - so `rman list --json` reported `publishTargets: ["npm"]` for a Cargo
  package. Publish targets are contributions now (see below), so the union would mean the core
  naming plugins it cannot know about, exactly as `Package.provider` must not; and the default is
  `PublishTarget.claims`, answered by the ecosystem that read the manifest. **Never narrow it
  again.** A name nothing implements is caught by `publish` itself, naming the targets the
  repository does have.
## `rman config` - the resolved config, for the directory you are standing in

[`src/commands/config.command.ts`](packages/rman/src/commands/config.command.ts). Prints
`Package.config` for `Repository.currentPackage` (the root package otherwise, and with `--root`),
which is the *resolved* object - directory cascade, `"[selector]"` blocks, `extends` and
`${{ }}` all already applied. It computes nothing of its own; the value it prints is the one every
command reads, which is the point of having it.

- **YAML by default, `--json` for piping.** The header and notes are `#` comments so the YAML form
  is a loadable document.
- **Colour only when `process.stdout.isTTY`, and that is correctness rather than taste.** An escape
  sequence inside a `#` comment makes the document *unloadable*: `rman config > rmanrc.yml` wrote a
  file js-yaml refuses with "the stream contains non-printable characters" (measured - `ansi-colors`
  does not disable itself for a pipe here). Its spec strips colour rather than assuming there is
  none, because mocha run from a terminal *has* a TTY and would otherwise fail only on a developer's
  machine.
- **It must say when a value is printed raw.** `version.before`/`.exec`/`.after` are in
  `DEFERRED_PATHS`, so `${{ pkg.targetVersion }}` is still an expression here - printed among
  resolved values with no note, it reads as interpolation being broken.

## `--config`: what a command would run with

A **global** flag - `rman <anything> --config` prints and runs nothing. Three sections, and each
answers a different question the other two cannot: `options` (the parsed argv - what this
invocation asked for), `packages` (the set after `--scope`/`--ignore`/`--deps` and `skip`, computed
through `filterPackages` the way the command computes it), and the `.rmanrc` those packages carry.

- **Applied once, by wrapping `program.command`** (`interceptConfigFlag` in
  [`src/cli.ts`](packages/rman/src/cli.ts)), because every command - built-in, a plugin's, a
  `.rman/*.mjs` one - is registered through that one method. An option per command would have been
  twelve edits plus a rule for plugin authors to remember, and a global flag that quietly does
  nothing on whichever command forgot it is worse than no flag. It must be installed **before** any
  command is registered.
- **Which keys to show is `configKeys`, declared on the command itself** (`ConfigKeys` in
  `core/custom-command.ts`) - a `string[]`, or a function of argv where the answer depends on it
  (`run <script>` reads `run.<script>`). Beside the command rather than in a central map, so it
  cannot drift from the code doing the reading, and a plugin or `.rman/*.mjs` command can declare
  it too. **Absent, it prints the whole effective config** - the honest answer when nothing has
  said which half matters.
  - **Trap: `toCustomModule` in `cli.ts` builds a *new* spec object**, so a field it does not copy
    is silently lost. `--config` printed the whole config for every plugin command until
    `configKeys` was on that list (measured, on `clean` and `ci`). It applies to the
    `CustomCommand` form only - a **declared** command goes through `toYargsCommand`, the same
    function the built-ins use, so there is nothing to forward and nothing to forget.
  - **`configKeys` needed a `declare module 'yargs'` augmentation** of `CommandModule`, not just a
    field on our own `CustomCommand`: `program.command({ ... })` takes a literal, and TypeScript's
    excess-property check fires on a literal however the parameter is typed - nine commands failed
    to compile at once. The augmented parameters must be spelled exactly as yargs spells them
    (`T = {}, U = {}`) or the merge is refused.
- **The root package is always in the config section**, even when it is not a target: a repo-wide
  key is read off the root, so showing only the targets answered `rman ci --config` with
  `pkg-a: {}` - which reads as "nothing is configured" about the one key `ci` reads (measured).
- Distinct from [`rman config`](docs/cli/config.md), and keep them distinct: that prints one
  package's whole config with no command involved; this answers "what would *this command* do".

## `skip`, `--from-root` and `--scope /`, the flags every command should share

- **Top-level `skip`: "leave this package alone", honoured by every command that *acts*** -
  `run`/`build`/`test`, `exec`, `clean`, `publish`, `version`, `changelog`. Applied inside
  `filterPackages` itself, not as one of its options: it is the *repository's* standing filter,
  where `--scope` is the caller's ad-hoc one. Dropped **before** `--deps`/`--dependents`, so a
  dependency edge cannot drag a skipped package back in.
  - **`filterPackages`' third argument is the only opt-out, and `list` is the only caller that uses
    it.** The test for a new command: does it *do* something to the packages, or *report* on them?
    An inventory hiding part of the repository answers a different question than the one asked.
    `changed` follows `version` (it honours skip), because its whole job is to say what `version`
    would do.
  - The finer-grained keys stay, and are not the same statement: `run.<script>.skip` stops one
    script, `publish.skip` means "never distributed, by any target" - which `changelog` reuses on
    purpose - and `version` deliberately honours *neither* of those (a package can be meaningfully
    versioned without ever being published). A blanket `skip` replacing them would flatten that.
- **`--from-root`/`-r` comes from one `fromRootOption(verb)`** (`applyFromRootOption` for the
  hand-written builder form), not from four near-identical option blocks. It means something **only
  where a command scopes by the current directory** - `run`/`build`/`test`, `exec`, `clean`,
  `changelog`, `diff` narrow to `Repository.currentPackage` when you stand inside a package, and
  this is the escape hatch. Do **not** add it to `version`, `publish`, `list` or `changed`: they
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
    `run`/`build`/`test` (`repository.packages` holds the members only, and the root contributes
    just its `pre`/`post` bookends, so there is nothing to select); identical to `--from-root` on
    `diff` (which is already `rootPackage` with no pathspec); already what `--from-root` does on
    `config`; answerable with `cd $(git rev-parse --show-toplevel)` for `exec`. On `clean` it would
    be **actively misleading**: measured, the root's own sweep recurses through `packages/*`, so a
    flag named "root only" deletes *more* than a package-scoped run. Where the root genuinely is a
    candidate, `--scope /` says so - see below.
- **`--scope /` is the root package, and a glob never matches the root** (`ROOT_SELECTOR` /
  `selector` in `package-filter.ts`, `Package.isRoot`). One vocabulary with `.rmanrc`'s `"[/]"`, and
  the same justification: *the root is never selected by name.*
  - **Both halves are the feature.** `/` alone would be sugar - `--scope <root's name>` already
    worked (measured on this repository: `rman clean --scope 'rman*'` selected the root). Leaving
    globs able to reach it keeps exactly the trap the config selectors were redesigned to remove,
    and for `clean` it is destructive rather than merely surprising.
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

## Change and release detection

Three separate questions in rman look like "what changed". They are answered from different
sources and are **not** interchangeable. Before touching a command, establish which one it answers.

| | Question | Criterion | Commands |
| --- | --- | --- | --- |
| **A** | Which packages have **changed** since their last release? | the package's last release tag + commits after it whose files fall under that package | `changed`, `version`, `changelog` (+ `github-release`, for release notes only) |
| **B** | Which packages' current version is **not on the registry yet**? | the target's own registry (branches per package) | `publish`, `github-release` |
| **C** | Which packages have I **touched** right now? | working tree + `git cherry` (`Repository.listStatus`) | `list --changed`, `run --changed`/`--changed-since` |

**A and B are uncorrelated.** Never write code that derives one from the other:

- Tag at HEAD, no commits since, but the previous publish failed → A says "unchanged" (correct),
  B says "publish it" (correct).
- Never tagged, never published → A resolves no boundary at all, B says "publish it".
- Making A registry-based would mean: a failed publish leaves the registry behind, A then reports
  "changed", and `version` **bumps again for zero commits**. Severity only ever comes out of commit
  messages anyway - no registry can say *how much* or *why*.

### `ChangeHashService.detect` - the single boundary source for A

[`packages/rman/src/services/change-hash.service.ts`](packages/rman/src/services/change-hash.service.ts).
Every command asking A calls this; no command reimplements its own tag lookup. In order, first match
wins:

1. **An explicit `from`** (anything but `"npm"`) is returned as-is and applies identically to every
   package. No detection runs at all.
2. **The package's own latest release tag** (`findLatestTag`), pattern from `.rmanrc
   "changelog.tagPattern"`:
   - Pattern contains `{name}` (e.g. `{name}@*`, independent versioning) → `git tag --list`, highest
     by version. Reachability is irrelevant; the tag already belongs to that package.
   - Pattern has no `{name}` (the default `v*`, one repo-wide tag) → `git describe`, i.e. the nearest
     tag **reachable from HEAD**. No single package owns a repo-wide tag, so ancestry is the right
     criterion.
3. **No tag → the package's own ecosystem.** `Platform.manifestProvider.publishedVersion(pkg)` - `npm view`
   for a `node` package, whatever a plugin supplies elsewhere, **nothing at all** for a repository
   naming no plugin. The version it returns is turned into a tag name via `expandTag` and used only
   if **that tag actually exists in git**. The one real scenario it covers: a tag exists but isn't in
   HEAD's ancestry (release cut on another branch, rewritten history, shallow clone). With no tag in
   git at all this step resolves nothing either. **This is not a "has it been published" check** - it
   only borrows a version string to guess a tag name, and never compares against the local manifest
   version (that is B's job).
   - **Per package, not per repository**, and that is the whole reason it sits on the manifest
     provider rather than behind a repo-wide hook: a registry belongs to an *ecosystem*, so a
     polyglot repo asks npm about its `node` packages and crates.io about its `cargo` ones. It is
     also the test seam - register a provider that answers from a file instead of stubbing a
     network call, which exercises the real path (measured: `changed since v0.9.0` with an answer,
     `unreleased commits` without).
4. **`catchUpFile` (a changelog file), if given and present** → the result is merge-based with that
   file's own last-modifying commit, **widening** the boundary backwards. Purpose: if the changelog
   stalled at 1.1.0 while 1.5.0 shipped, the versions in between aren't silently skipped. With no
   tag, the file's commit is used alone.
5. **Nothing matched → `undefined`** → nothing has ever been released, so callers treat the whole
   history as unreleased (`listAllCommits`). `version` and `changelog` agree here deliberately -
   "not yet pushed" would read as empty the moment a first release is pushed, and for a repo with
   no remote at all.

Tag naming also has a single source: `ChangeHashService.expandTag` (forward: version → tag name) and
`.findLatestTag` (backward), both in that same file. Don't build a tag name anywhere else.

**`--from` takes a ref or the keyword `auto`** (`ChangeHashService.AUTO`), which is what omitting it
already means. It used to be `npm`, which named a *source* and the wrong one - most of detection is
git, and the registry part is the ecosystem's now. A rename, not an alias: `--from npm` means a ref
called `npm` and fails as one.

**Both of these live in `services/`, as namespaces**: `ChangeHashService` and
`ConventionalCommitsService`, whose members are named for what they do rather than repeating the
subject (`detect`, not `detectChangeHash`; `parseSubject`, not `parseConventionalCommit`).

A commit counts toward whichever package's directory its files fall under. `VersionService` does
this directly (`belongsToPkg`); `ChangelogService` additionally attributes "repo-wide" commits -
those touching more than half of all packages - to the root instead of repeating them in every
package (`ownersOf`/`BROAD_COMMIT_THRESHOLD`). Version bumping makes no such distinction: every
touched package counts as changed.

### `changed`

- **Question A.** `VersionPlanService.getPlanner().getPlan` filtered to `status === 'bump'`; writes
  nothing.
- Takes its boundary from the planner's `detectBoundary` (`detectChangeHash` for every planner so
  far). **Never asks a registry whether a version is published** - the one registry call in that
  path borrows a version string to guess a tag name for a package that has no tag at all, and is
  used only if that tag exists in git. That is not B.
- **Empty output does not mean "nothing to publish"** - it means "no package needs a new version".
  Don't gate a CI release pipeline on it; that decision belongs to B (`publish`).

### `version`

- **Question A**, from the same plan `changed` shows
  (`VersionPlanService.getPlanner().getPlan`); `VersionService.applyPlan` does the writes.
- **`VersionPlanService` is abstract - a technology supplies the planner** (`Platform.versionPlanner`,
  `rman-node`'s `NodeVersionPlanService`), and `version`/`changed` fail naming that key when none
  is registered. It does not degrade to a built-in default - a wrong boundary or cascade releases a
  plausible, untrue set of packages.
- **Two roles, and they resolve differently.** `app.versionPlanner` is the **orchestrator**: one
  slot, last registration wins, driving groups, the commit→size reading, the cross-group ripple and
  the root's release identity - none of which belongs to any one technology, and all of which is
  computed for the whole repository at once. The two decisions that *are* a technology's are asked
  per package instead:
  - **`detectBoundary`** through `plannerFor(pkg)` = `pkg.platform.versionPlanner ?? this`;
  - **`cascade`** through `cascadeFor(members, bump)`, once per group.
  - **This was a real bug, of exactly the shape the `['npm']` publish default was.** Both came off
    the single slot, so in a polyglot repository a Cargo package's boundary fell back to `npm view`
    and its cascade assumed npm's caret ranges - whichever plugin registered last decided for
    everyone. Pinned in `version-plan.polyglot.spec.ts`, with a negative control: reverting the two
    delegations makes both cases fail.
  - **A group whose members disagree takes the *widest* cascade**, and the direction is deliberate:
    too narrow releases too little, which `cascade`'s own doc calls the invisible failure; too wide
    releases a package that did not strictly need it, which is visible and harmless.
  - Abstract are exactly the two decisions no repository-in-general has an answer to:
    `detectBoundary` (which registry stands in when a package has no release tag yet) and `cascade`
    (how far into its group a bump reaches). **`cascade` is a statement about dependency *ranges*,
    not versions** - patch reaches only the changed packages because `^1.2.0` already resolves to
    `1.2.1`; an ecosystem pinning exact versions must release every dependent for a patch too.
    Groups, the commit→size reading, the cascade mechanics and the root's release identity stay in
    the core: none of them is a technology's business, and moving them out would have every plugin
    copy them.
- **The bump *names* belong to the version scheme, not to rman** (`VersionScheme.bumpNames`,
  smallest first). `patch`/`minor`/`major` are semver's words for how a *number* moves, and a
  `major.minor.build.revision` scheme has four sizes and no `patch` - so `rman version <bump>`
  validates against `bumpNames`, `--help` lists them, and the "invalid bump" error names them plus
  the scheme (`VersionScheme.name`). Never hardcode the trio in a message, a help string or a
  comparison.
  - **The order is the ranking**: `highestBump` (what a group takes when members disagree) and
    `smallestBump` (what a package bumped only because a dependency moved gets) read it. Both, and
    `highestVersion`, are *implemented* on the abstract `VersionScheme` and overridable there - they
    derive from `compare`/`bumpNames`, so requiring every scheme to restate them would be boilerplate
    and a second place to disagree, but each is a real decision (parallel 1.x/2.x lines have their
    own "highest"; a four-part scheme may reserve `revision` and want `build` for the ripple).
    Subclass `SemverScheme` to change one thing without restating semver.
- Two steps, and they must stay apart: **what happened** is `ChangeKind` (`breaking`/`feature`/`fix`)
  read off the commit - `feat!:`/`BREAKING CHANGE:` → breaking, `feat:` → feature, anything else
  (`fix:`, an unknown type, a non-conventional subject) → fix; **how the number moves** is then
  `VersionScheme.bumpFor(kind)`. Three kinds because three is what a commit message distinguishes,
  which is a fact about commit messages and not about any numbering. Never add a fixed `bump` input
  to CI - it would apply identically to every future run.
  - The single-commit escape hatch is a `Release-As:` footer, naming a **bump** (not a kind).
    **Trap: it must be checked against `bumpNames` and otherwise treated as no override at all.**
    Ranking an unrecognized word lowest is not the same as ignoring it - ranked low it still
    replaces what the commit's own subject said, which turned a `feat:` carrying release-please's
    `Release-As: 1.2.3` into a patch (measured). A typo has to be inert, not quietly decisive.
- **`VersionService` runs no command of its own.** The hooks around the write go through
  `RunService.runLifecycleSlot(pkg, 'version', slot, fallback)`; `version.service.ts` supplies only
  the `fallback` - its own `.rmanrc version.<slot>`, interpolated there because those three paths
  are in `DEFERRED_PATHS` and `${{ pkg.targetVersion }}` binds nowhere else.
  - The package's *own* declaration pre-empts that fallback, slot by slot, and it arrives through a
    step source: npm spells the lifecycle `preversion`/`version`/`postversion`, which is the same
    `pre<script>`/`<script>`/`post<script>` shape `rman-node` already maps onto
    `before`/`exec`/`after` - so this needed no second seam and no extra line in the plugin. **Never
    read `manifest.raw.scripts` from core again**, and don't re-add a script runner here: the
    own-beats-fallback rule belongs to `RunService`, which applies the identical rule for `run`.
- **Never consults `.rmanrc "publish.skip"`.** A package that is never published can still be
  meaningfully versioned.
- When folding the changelog into the bump commit (`--changelog`, or `.rmanrc "version.changelog"`)
  it passes `ChangelogService` an **explicit** boundary: the pre-bump tag (`expandTag(pkg,
  entry.from)`). It cannot be left to auto-detection - see the trap below.
- **`applyPlan` returns what it did (`ApplyResult`), not the plan it was given.** It used to
  `return plan` - the same array, never touched - so its one caller could only re-print the table it
  had already printed, while the commits, the tags and the push stayed silent. Those are the three
  things a reader does not already know: a run makes one commit per group **plus** a monorepo root's
  informational sync, tags each group, may add a repository release tag, and leaves an
  already-existing tag alone.
  - `updated` is narrower than the plan's `'bump'` entries **on purpose**: a monorepo root's entry
    is never written. The old per-package roll-call listed it as `updated <root> 1.0.12 -> 1.1.1`,
    which reads as a write that did not happen.
  - `tags` carries `created: false` for one that was already there. The case that guard exists for
    is a tag **unreachable from HEAD** (a release cut on another branch) - putting the same tag *on*
    HEAD instead empties the plan, since the boundary then has no commits after it, and nothing is
    tagged at all. A spec written the obvious way tests nothing (measured).
  - `GitHelper.commit` returns the new short sha for this, instead of `void`. A commit helper that
    cannot say what it committed leaves every caller unable to report itself.
- Writes more than `package.json`: a bumped package's Dockerfile
  `org.opencontainers.image.version` label is rewritten to the new version and folded into the
  **same commit** (`stampVersionLabel`). Keep it here, not in a build script - the label is by
  specification the version of the packaged software, so `version` is the only thing that knows
  it, and a build-time rewrite leaves the edit uncommitted (`publish` then reads a dirty tree) and
  records a stale label in the commit that was actually tagged. Reads the same path
  `DockerPublishService` builds from (`publish.docker.dockerfile`), never a second guess at it.
  Never *inserts* a label - which labels an image carries is the author's call. The same pass
  rewrites the version in every file `.rmanrc "version.stamp"` lists. **Stamp the source, never the
  build output**: rewriting `build/constants.js` from a build script leaves the checked-in file on a
  placeholder, so anything running from source reports it, the tagged commit never records the
  released version, and the rewrite has to be redone every build.
  - **How a version is *declared* is the manifest provider's `stampVersion` answer, not the core's**;
    which files hold one is the repository's, which is why the list is config and the rewrite is a
    seam. `stampVersionConstant` is exported as the helper most providers delegate to - measured, it
    reaches a Go `const version = "…"`, a Gradle/TOML `version = "…"` and a JS `const version =
    '…'`, so it is not npm-shaped; what it cannot reach is anything with a type annotation between
    the name and the value (Rust's `pub const VERSION: &str`, and equally TypeScript's own `const
    version: string`), an unquoted value (`pom.xml`'s `<version>`), or another spelling unless the
    entry names it (`{ file, constant: 'Version' }`).
  - **The identifier used to be unnameable**: the helper took a `name` and nothing ever passed it,
    so only the exact lowercase word `version` was matched and `VERSION`/`Version`/`__version__`
    were silently skipped.
  - **A listed file that exists and holds nothing rewritable is an error, raised before anything is
    written.** A missing file stays a silent no-op (that is what one `"[*]"` declaration relies on),
    but the two are not the same thing: the second means "not this package", the first means the
    repository asked for something and did not get it - and silently released a tagged commit with a
    stale constant. It is a *configuration* mistake, so the check runs first: finding it mid-write
    left the manifest bumped on disk with no commit and no tag (measured, exit 1 and a dirty tree).
  - **`undefined` from a stamper means "nothing matched", never "no change needed".** Conflating
    them made that error message a liar - a file already sitting at the target version is not a file
    holding no version.
- Also decides the **repository's own** release identity (the monorepo root's version) and, on a
  calendar version, creates the repository release tag alongside the per-group ones - see
  "Release identity" below.

### `changelog`

- **Question A.** The boundary is auto-detected per package via `detectChangeHash` by default;
  `--from <hash>` bypasses that entirely and applies identically to every package.
- **Trap:** run *after* a tag has been created, auto-detection finds that new tag and reports
  nothing changed. Hence: in CI, release notes are generated **before** `version`; and any code path
  running after the tag exists (`version --changelog`, `github-release`) passes the boundary
  **explicitly**. Do the same for any new note-generating path.
- Skips a `.rmanrc "publish.skip"` package by default; `--include-skipped` brings it back.

### `publish` - the core's command; a *target* is what a plugin contributes

[`src/commands/publish.command.ts`](packages/rman/src/commands/publish.command.ts),
[`src/core/publish-target.ts`](packages/rman/src/core/publish-target.ts).

- **Question B.** Each target asks its **own** registry whether this version is already out there:

  | Criterion | Source | Claims by default? | Implementation |
  | --- | --- | --- | --- |
  | **b-1** npm-targeted packages | the local version is among the registry's published `versions` | a package `rman-node` read the manifest of | `NpmPublishTarget` → `PublishService` (`rman-node`) |
  | **b-2** docker-targeted packages | `docker manifest inspect <image>:<version>` | nothing - opt-in | `dockerPublishTarget` → `DockerPublishService` (core) |
  | **b-3** the repository itself (see `github-release`) | a GitHub Release exists for the repository's release tag | n/a - never optional, and not a target | `GithubReleaseService` (core) |

- **`publish` was `rman-node`'s command, and that had the ownership backwards.** Everything the
  command does is about a *repository* - which packages are candidates, dependency order, the
  plan/confirm/apply shape, `--dry-run`, the JSON a CI gate reads - and none of it is npm's. What an
  ecosystem owns is one answer to "is this version on the registry, and how do I push it", which is
  the whole of `PublishTarget`. The measured consequence of the old arrangement: Docker publishing
  was implemented in the **core** all along, and `publish --target docker` in a repository with no
  JavaScript in it still required installing a Node plugin to reach it.
- **A target owns three things and no more**: `claims` (which packages are its own when a package
  declares no `publish.target`), its **own CLI options**, and `getPlan`/`applyPlan`. Registered on
  `RmanApplication.publishTargets` - a registry, not a service, because the answer is a *sum*: a
  package may ship to npm and Docker Hub at once.
  - **A target's flags are merged into `publish`'s where the command is built**, which is why the
    command can take `app` and still be declared rather than built by hand. `--access`, `--tag`,
    `--otp`, `--registry`, `--userconfig`, `--contents`, `--package-manager` are the `npm` target's;
    `--docker-namespace` is `docker`'s. A target reads them off `ctx.args`, untyped on purpose - the
    target declared them, so it is the only thing that can know their names.
  - **Two targets colliding on an option name throws**, naming both. npm has a `--registry` and so
    would a Cargo target; any rule for picking a winner (registration order, last wins) produces a
    flag that silently means the other target's thing. Name it for the target.
  - **`--target`'s `choices` come from the registry**, and a name in `publish.target` that nothing
    implements is an error naming what *is* installed. That check used to be the type's job and can
    no longer be - see `PublishTarget` above.
- **`claims` is where the `['npm']` default went, and it must stay per-ecosystem.** `npm`'s answer
  is `pkg.provider === 'node'`; `docker` has none, so it is opt-in. The core cannot write either
  down, which is exactly why the old hardcoded default was wrong for a Cargo package.
- **Which packages a target is asked about is `shipsTo`/`targetsOf`, never a second read of
  `publish.target`.** `DockerPublishService` and `ListService` both go through it, so `publish` and
  `rman list --json` cannot disagree about where a package ships.
- **B asks whether *this version* is published, never what `latest` points at.** The npm target
  runs one `npm view <name> version versions --json`: `versions` decides `up-to-date` vs `publish`,
  `latest` is only what the entry *reports* (`entry.registryVersion`). They are not the same
  question and they part company as soon as a prerelease ships under its own dist-tag - `latest`
  stays on the old stable however many betas follow, so the old `latest ==` comparison kept
  proposing an already-published beta until npm answered 403. It was wrong in the other direction
  too: a package whose local version sits *behind* `latest` was proposed just as wrongly.
  - **A spec about this has to spell out both halves of the fake registry**, or it proves nothing.
    Measured: with the fixture deriving `latest` from the end of the `versions` list, reverting the
    fix left the spec green - the two answers coincided. `publish.service.spec.ts`'s `registry()`
    therefore takes a `{ latest, versions }` form, and the beta specs use it.
- **A prerelease publishes under its own identifier, derived rather than asked for**
  (`distTagFor`). `2.0.0-beta.1` -> `beta`. `npm publish` with no `--tag` writes `latest`, so a
  beta published that way is what every plain `npm install` resolves to from then on; npm is
  content to point `latest` at a prerelease, and `npm dist-tag` can move it back only after
  everyone who installed in between already has it. One forgotten flag with no clean undo is not
  something to leave to the caller.
  - **This started as an `'error'` telling the caller to type `--tag beta`, and that was the wrong
    call.** The reasoning was "don't guess, fail loudly" - but it conflated guessing something
    *unknowable* (whether a module's export is a plugin or a config, which `loadPlugins` rightly
    refuses to decide) with *reading* something written in the data. The identifier is in the
    version; `semver.prerelease` returns it. The error message even named the answer.
  - **Derived is not silent, and that distinction is the whole design.** The tag is decided in
    `getPlan`, stored as `Entry.distTag`, put in `detail` so the plan line and `--dry-run --json`
    both show it, and read back by `applyPlan` - which must not recompute it, or the plan and the
    publish could disagree about where a package is going. Pinned: a spec asserts the *command*
    carries `--tag beta`, because a plan that says `beta` while the command says nothing would put
    the beta on `latest` anyway and read as though it had not.
  - **Two cases still refuse, because there is nothing honest to derive.** An explicit
    `--tag latest` on a prerelease - the one thing deriving must never reach, and someone who typed
    it is likelier confused than deliberate (bare `npm publish --tag latest` is the escape hatch) -
    and a prerelease whose identifier is numeric (`2.0.0-1`), where a dist-tag called `1` would be
    invented rather than read.
  - **`VersionScheme.prereleaseId` is where the identifier comes from**, beside `isPrerelease`:
    implemented (not abstract) returning `undefined`, overridden by `SemverScheme`. Both questions
    are the scheme's, so the npm target never reaches for `semver` directly.
  - **`tag` is therefore a plan option, not an apply-only one.** The tag is *decided* in the plan,
    so it has to be visible to `--dry-run` and to the JSON a release pipeline gates on.
    `npm-publish-target.ts` reads `--tag` in `planOptions`, not only where the publish command is built.
  - **A calendar version has to be ruled out first**, and that is not a detail: `2026.9.15-1430`
    carries a semver prerelease identifier because that is how the time is spelled. `distTagFor`
    makes the same pair of checks `github-release`'s `resolvePrerelease` does - `!isCalendarVersion`
    plus the *scheme*'s `isPrerelease`, never `semver.prerelease` directly - and they agree
    deliberately. `isCalendarVersion` is exported from `rman` for this caller, which is in a plugin.
    Pinned with a negative control: dropping the calendar clause turns the calendar spec red.
- **Never looks at whether `version` ran** - deliberately. It only inspects what's on disk and on the
  registry, so it behaves the same right after a bump or days later. Re-running is safe.
- In CI, gate the release pipeline on **this** plan, not on `changed`.
- `.rmanrc "publish.skip"` excludes a package from **every** target.
- `publish.target` is about **package distribution only** - which registry a package's artifact
  goes to. `"github"` as a value would read as *GitHub Packages* (`npm.pkg.github.com`), which is
  what it will mean if it is ever added; it must never again mean the repository's GitHub Release.
- **A target contributes its config keys too**, through the `PublishTargetConfigs` slot
  `publish.command.ts` exports: the core's docker target declares `publish.docker`, `rman-node`'s
  npm target declares `publish.npm.directory`, each from its own package. A slot rather than a second
  declaration of `publish`, because a key arriving from two places does not compile - see
  "Config types". Every target's block is named after the target: `publish.docker.*` and
  `publish.npm.*`, the latter renamed from a bare `publish.directory` that read as though it
  belonged to publishing in general. **The old spelling is refused, not ignored** - `PublishService`
  raises an `'error'` entry naming the new key, because ignoring it would silently fall back to the
  package's own directory and push the *source tree* to npm.

- **Publishing from a build directory** (`publishConfig.directory` > `.rmanrc "publish.npm.directory"` >
  `--contents`): the manifest in that directory is **generated by `publish`**, at publish time, and
  is deliberately unconfigurable. Removed from the copy: `devDependencies`; every `scripts` entry
  except `preinstall`/`install`/`postinstall` (the only ones a consumer's install runs - dropping
  those would silently break every native-module package); `private` (publish refuses a private
  package anyway); `publishConfig.directory` (it pointed *here*). `"workspace:"` ranges are resolved
  in it, and it is deleted again afterwards.
  - **This whole section is the `npm` target's**, not `publish`'s: a build directory, a generated
    manifest and `"workspace:"` ranges are all facts about npm. `PublishService` in `rman-node` is
    where it lives, reached through `NpmPublishTarget`.
  - **The `"workspace:"` protocol lives in `rman-node`** (`utils/workspace-range.ts`), not in the
    core: it is a statement about a `package.json` dependency field, and the core never read it -
    it was only exported from there because `publish` needed it before `publish` itself moved out.
  - Generated here, not by a build script, for the same reason the Dockerfile label moved into
    `version`: a build script writes it when the *build* runs, so a later bump publishes a manifest
    that disagrees with the package. And the `"workspace:"` rewrite only ever touched the package's
    own file, so it never reached the copy npm actually reads.

### `github-release`

- **Question B, at the repository level**: does a GitHub Release already exist for the repository's
  release tag? Plus one A-flavored part - `applyPlan` builds the body via `ChangelogService`. The
  split stays clean: B decides *whether it is cut*, A decides *what the notes say*.
- **Not a `publish` target and not opt-in**, and neither of those is a style choice:
  - A target says where a *package's artifact* ships (npm, Docker Hub, GitHub Packages). A release
    is the *repository's* record that a version shipped; its tag covers the whole source tree, so a
    per-package release would have to invent a tag no package owns.
  - There is no useful repository that releases its code and wants no record of it. Making it
    configurable only means some repos silently stop having one - which is exactly what a consumer
    of the CI workflow experienced when it *was* opt-in.
- It follows that **nothing in `.rmanrc` may gate it** - `githubRelease` carries details only
  (`repository`/`draft`/`prerelease` at the root, `assets` per package). `publish.skip` and
  `"private"` do not apply: they exclude registry candidates, and a release is not a registry.
- Idempotent by construction: the tag already having a release reads `up-to-date`, so CI runs it
  unconditionally, after `publish` (a failed registry push must not leave a release announcing code
  that never arrived).
- A missing release tag is an **error**, never a silent skip - the notes' boundary is the previous
  release tag, so releasing without one would quietly produce notes covering the entire history.

### `clean` - in `rman-node`, not the core

Everything its built-in behaviour knows how to delete is a **TypeScript** fact: a compiled
`.js`/`.js.map`/`.d.ts` beside its `.ts` source, a `*.tsbuildinfo`, and a `node_modules` to skip
while looking. Nothing in it would fire for a Cargo or Go repository - both of which ship
`cargo clean`/`go clean` anyway - so a core `clean` was a command that only appeared general.
Measured after the move: without the plugin `rman clean` is `Unknown argument: clean`; with it all
four behaviours still fire.

- **`clean.*` is contributed by the command**, like every built-in's own key: `skip` derived from
  its `config` block, `include`/`exclude` through `Extra` because a `CommandOption` cannot say "a
  glob *or* a list of them" - and that union is what a config author writes. **The contribution is
  declared in `rman.augmentation.ts`, not beside the command**, and only because of the one-block
  rule: re-measured while moving it, a second `declare module 'rman'` left
  `SystemInfo.PackageManager` unresolved at four call sites. rman's own commands augment a *module
  path*, which has no such limit.
- **`clean.include`/`clean.exclude` moved with it**, and they are genuinely ecosystem-neutral - that
  is the cost of the move, named rather than hidden. A repository wanting only the globs has to name
  the plugin, or write the `rm` lines as a `run` script. The alternative was a stub `clean` in the
  core plus this one, i.e. two commands with one name and a precedence rule between them.
- A `.d.ts` with **no** matching `.ts`/`.tsx` is left alone - that is a hand-written declaration,
  not build output. Don't "simplify" that check away.
- Never touches `node_modules`; that is `ci`'s job.
- `clean` and `ci` are the two commands still wholly `rman-node`'s. `publish` is no longer one of
  them - see above. Both are **declared**, not built, like every built-in.

### `list` / `run`

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

### Release identity (repo-level)

A GitHub Release belongs to the repository - the tag covers the whole source tree - so a run
produces **one** (see `github-release`), named after the monorepo root's version. That version is **derived, never
configured** (`usesCalendarVersion`, `src/utils/release-version.ts`):

```
calendar = the last repository release tag is a calendar version   (authoritative: tags record
        || the root's current version is a calendar version         what actually shipped)
        || group count > 1                                          (the first-time decision)
```

- The decision is **structural** (group count), not value-based. Two independent groups can sit on
  the same version today and diverge tomorrow; keying off the values would move the scheme under
  the repo's feet.
- With one group the root simply follows it, so repo and packages share one number - unchanged
  behavior for every existing repo.
- With several groups there is no shared number to report. The old "highest among the groups" rule
  is the bug this replaces: a *lower* line releasing left the root standing still (measured:
  `root 3.4.0 -> 3.4.0` while `pkg-api` went 1.2.0 → 1.3.0), so a release had no identity at all.
  A semver-looking identity would anyway claim something untrue about packages on other lines.
- The last two clauses make it **sticky**, and that is not optional: `1.3.0 → 2026.9.15-1430`
  increases, but `2026.9.15-1430 → 1.4.0` **decreases**. Once calendar, always calendar.

**Format: `YYYY.M.D-HHmm`, nothing padded** (`2026.9.5-930`). This is not a style choice - semver
forbids leading zeroes in numeric identifiers, so `2026.09.15-1430` and `2026.9.15-0930` are both
invalid, and the root's `package.json` has to hold a valid version. Do not "tidy" it with padding.

**Trap: the release tag pattern must never match a package's.** `.rmanrc "version.releaseTagPattern"`
defaults to `release-*` precisely because the default *package* pattern is `v*` and `findLatestTag`
resolves a repo-wide pattern with `git describe --match`. A release tag matching `v*` would be
picked up as some package's own last release, corrupting both its changelog boundary and the
version its entry is headed with.

**Trap: `git tag --points-at HEAD` returns the wrong tag in a multi-group repo.** Each group gets
its own commit and tag, so whichever group was committed last owns HEAD (measured: `pkg-lib@3.4.1`
on HEAD with `v1.3.0` one commit behind). Read a release tag with `git describe --match <pattern>`,
never by what happens to sit on HEAD.

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

### The value kind: the JS spelling of `${{ }}`

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
  (`unsetValue` in `config.ts`). That case is not exotic: a value written to extend an inherited
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

[`src/core/run-step.ts`](packages/rman/src/core/run-step.ts). `run.<script>.before`/`.exec`/`.after`,
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
- **`console` is redirected only while the progress panel is on**, which is the same split `exec`
  already makes (`stdio: 'pipe'` + `onLine` with the panel, `'inherit'` without). A function writing
  to the real stdout would print *over* the panel it is being rendered inside. Steps should prefer
  `ctx.logger`.
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
([`src/utils/printable-config.ts`](packages/rman/src/utils/printable-config.ts)): `rman config` and
`--config` print `[Function: copyDocs]`. This was already broken before functions existed - a
`plugins` entry in its object form carries the plugin's seams, and `rman config --root` died with
`unacceptable kind of an object to dump [object Function]` on a repository that merely `extends`-ed
a plugin package. In `--json` it was worse and quieter: `JSON.stringify` drops a function-valued key
entirely, so the step simply vanished from the output.

**Known, pre-existing, and not this feature's:** an error thrown from a command handler without the
`logged` marker is printed **twice** - once to stdout by yargs' `.fail()`, once to stderr by
`runCli`'s catch. Measured on untouched paths too (`rman version banana` prints it three times).
Don't take a doubled message as evidence that a new throw site is wrong.

## How a command is declared

[`src/interfaces/rman-config.interface.ts`](packages/rman/src/interfaces/rman-config.interface.ts),
[`src/core/command-builder.ts`](packages/rman/src/core/command-builder.ts). **A command says what it
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

[`src/core/custom-command.ts`](src/core/custom-command.ts). A module there becomes `rman <its file
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
- **`runBin` vs `exec`** ([`src/utils/run-bin.ts`](src/utils/run-bin.ts)): `runBin` takes **argv as
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
    ([`packages/rman/src/utils/child-tracker.ts`](packages/rman/src/utils/child-tracker.ts)), so an
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
  [`src/cli.ts`](packages/rman/src/cli.ts)): it walks the same `commandRegistry` the commands are
  registered from, so the two cannot disagree and adding a command can't quietly leave a
  repository's own able to shadow it. It was a hand-maintained array pinned by a spec, which is what
  declaring commands replaced. Aliases count (`ls` is `list`); `completion` is yargs' own and is the
  one name still written down. It covers **built-ins only**, which is why the rule above differs for
  plugins - and note that `publish` crossed that line when it moved into the core, so a
  `.rman/publish.mjs` that used to win silently is now a clash that throws.
- **A bare name in `extends` resolves through the *repository's* `node_modules` first, and falls
  back to whatever is installed beside rman itself** (`resolveConfigTarget` / `resolveBesideRman` in
  [`src/core/resolve-target.ts`](packages/rman/src/core/resolve-target.ts)). **`extends` is now its
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
- **`plugins` arrives through `extends` too, commands and seams alike.** `Repository.create` reads
  it off `readDirConfig(rootDir)`, which has already resolved `extends` - so a shared config package
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

## `plugins`: one shape, and always additive

- **A `plugins` entry is the plugin itself, or a glob naming `.js` modules that `export default`
  one** - the same two forms `commands` and `publishTargets` take. The instance is what a JS config
  uses to declare a plugin without publishing a package, and it is the form a plugin package's own
  config holds.
- **A package name is not one of the forms, and `plugins: ['rman-node']` is never valid.** That
  package's entry point exports an rman *config* - `{ plugins, commands, publishTargets }` - and a
  config's way into a repository is `extends`. The two are different statements: `extends` inherits
  everything the package declares, while `plugins` names the technologies themselves. Refused with
  a message saying so, rather than half-read.
- **A plugin package exports an `RmanConfig`, never a plugin** - `rman-node`'s entry point is
  `export default defineConfig({ plugins: [new NodePlugin()], commands, publishTargets })`. A
  package exposing exactly one plugin was the shape of the plugin it happens to contain: a second
  one would change what every repository importing it receives, where a config is the same kind of
  thing as the file naming it and simply grows.
  - **`manifestProvider` is checked at load, and it is the one member that is not optional.**
    Every other seam is answered by its absence (`basePlugin`); this one is what makes a plugin a
    *technology* at all. Checked at runtime because the type cannot reach a JavaScript config, and
    an rman **1.x plugin** is exactly the object that got all the way in: `{ name, init }` was the
    whole of one, `name` was all the loader looked at, so it registered successfully and then died
    *inside its own `init`* with `ctx.addCommand is not a function` - measured while converting
    `@panates/rman-node`, fifteen failures naming neither the plugin nor the version it was written
    against. `init` still exists in 2.0, so nothing earlier gives the shape away.
  - **Never re-accept a module that exports the plugin directly.** Supporting both meant deciding
    which it was at runtime, and there is no reliable test - `name` is a key a config may have too,
    so it came down to "a name plus at least one seam", a guess. Guessing "plugin" registers nothing
    and reports success. It is refused now, with a message naming the fix; the seam list survives
    only inside `describeExport`, where it shapes a sentence and decides nothing.
  - **Nothing is read *out of* an imported config any more** - that recursion is gone with the
    package-name form. A config reaches a repository through `extends` and by no other route, which
    is what keeps installing a package from configuring the repository on its own.
- **`plugins` always appends (`ALWAYS_APPEND` in `merge-config.ts`), so there is no `+plugins`.**
  Every other key lets a closer layer overrule a value, but a plugin *adds* commands and seams, and
  a repository naming one never means "and drop the ones my shared config brought". Replacement was
  the silent failure: `extends` a toolchain config, add a plugin of your own, and what you noticed
  was `Unknown argument: publish`.
  - An entry already in the list is dropped, by identity - two layers naming `'rman-node'` is
    ordinary, not a mistake. De-duplication is for these keys only, and it is why `appendList`
    checks `ALWAYS_APPEND` rather than de-duplicating everything it merges.
  - `register` also allows **one registration per plugin name**, which catches what identity cannot
    (two objects claiming a name, an object duplicating a named package). Registering twice defines
    its commands twice, which yargs does not survive.
**A root `platform` declaration naming a built-in puts it at the front of `plugins`**
(`expandBuiltinPlugins`), so the whole built-in arrives - technology, commands, publish targets.
Saying which technology a repository *is* is saying it has it; making an author write both was a
distinction only rman could see, and the measured cost was `rman list` working with a `node` column
beside `Unknown arguments: clean`.

- **At the front**, because `platformFor` takes the first platform that recognizes a directory. Only
  observable with **two** built-ins - rman ships one, so a control swapping the ends passes until a
  second is stubbed into `BUILTIN_PLUGINS` (`detect.spec.ts` has the pattern).
- Read from the unmarked key **or** from `"[/]"`, since both are the root speaking.
- **Only a built-in is promoted**, checked after the loader's dynamic import: a third-party platform
  is loaded by the `plugins` entry that brings it, and pushing its bare name in would hand the
  loader a glob matching no file - the failure reads as the plugin being missing while it is
  registered perfectly well.
- **Below the root it loads the technology alone**, and that is structural: `plugins` is read once,
  at the root, before any package exists, so a nested declaration cannot contribute commands even in
  principle.

- Don't extend `ALWAYS_APPEND` casually: an always-appending key can never be *un*-said by a closer
  layer, which is only acceptable where the value is a set of contributions rather than a decision.

**`--version` and `--help` must not need a repository.** `rman -v` is what you reach for when
something is wrong - to find out which rman is even installed - and a broken `.rmanrc` took it away:
`Repository.create` runs before yargs sees any flag, so `rman -v` in a repository naming a plugin it
could not resolve answered with that error and exit 1 (measured).

- `--version`/`-v` is answered from `_argv` **before the repository is touched**, and returns.
- `--help`/`-h` is answered from the `catch`: the command list genuinely needs the repository (every
  built-in's `initCli` closes over it, and a plugin's commands *are* the repository's), so help
  degrades to the global options and says why the rest is missing. The reason goes to **stderr**, so
  `rman --help | less` is still just help.
- **Nothing else degrades.** An ordinary command in a broken repository must still print the reason
  and exit 1, or a broken repository looks like a working one - pinned by a spec beside the other
  three.

**Trap: a setup failure used to exit 0.** `runCli`'s top-level catch printed the message and
swallowed it, so `rman info` in a directory with no `package.json` reported failure on stdout and
success to the shell (measured, and true of the published 1.0.10 too). It rethrows now, and the
entry point exits 1. Any new throw path before `parseAsync` inherits that - keep it that way.

## Tests: every spec declares its own ecosystem

The core has no manifest provider, no workspace provider, no step source, no `BinPath` provider and
no version planner - so a spec that needs one **brings it**.

- **There is no root hook any more, and that is what `RmanApplication` bought.** There used to be
  one (`support/mocha-root-hooks.ts`), emptying five module-global registries before every single
  test: mocha runs both packages' specs in one process, so without it whichever spec ran first
  decided the answer for the rest - `Manifest.read` takes the first provider that recognizes a
  directory, so `rman-node`'s answered for core specs that registered nothing, and the core
  *appeared* to work in tests that never set it up. Every registry lives on an application now and
  each `createRepository` builds its own, so there is nothing left that could survive a case. The
  file is deleted; don't reintroduce a global registry that would need it back.
- **A spec never calls `Repository.create` directly** - it calls the fixture's `createRepository`,
  which is what seeds the application with the fixture's technologies. Anything else that spawns or
  reads a manifest takes an app too: `createApp()` for a bare `new Package(dir, app)` or an
  `exec(cmd, { cwd, app })`, and `Repository.app` (non-enumerable) wherever one is already in hand.
- **[`packages/rman/test/_fixture.ts`](packages/rman/test/_fixture.ts)** is the core's synthetic
  ecosystem: `useTestEcosystem()` arranges a `testPlugin` named `'test'` (not `'node'`) - a
  manifest reader, a workspace provider and a step source in one - plus a `TestVersionPlanService`,
  and `createApp()`/`createRepository()`/`runCli()` put them on a fresh application.
  `service(name)`/`planner()` read one back off the last application built. **It must not import
  `rman-node`** - that package depends on this one, so borrowing its plugin would invert the build
  order and make the core's tests pass because its own plugin happened to be right.
  - `registryVersions` / `registryCalls` replace the old `npmViewVersion` injections: a spec fills
    the map instead of stubbing a function, so `ChangeHashService.detect` is exercised through the
    real provider - and `registryCalls` can assert the registry was **not** consulted, which a
    throwing stub only ever did by accident.
  - `usePlugin(plugin)` adds a **second technology**, for a spec about a polyglot repository.
    **A spec's own plugins are registered first, and that is load-bearing**: `pluginFor` takes the
    first whose manifest provider recognizes a directory, and the fixture's claims anything with a
    `package.json` - which every package the fixture writes has. Registered after it, a second
    technology could never claim one, so a polyglot repository was not expressible at all.
    `useLocalBin`'s stack recognizes nothing, so being first costs it nothing.
  - `useLocalBin()` adds a bin-only `Plugin` offering `<dir>/local-bin` **at every level from
    cwd upward**. Walking up is not decoration: `exec` runs a step in the *package's* directory, so a
    provider offering only `<cwd>/local-bin` serves a command run at the repository root and nothing
    else. Measured, and the failure was dangerous - a stubbed `docker` was invisible from
    `packages/a`, the **real** `docker` ran, and it got as far as `registry-1.docker.io`. A test must
    never be one credential away from pushing an image.
    - **It only reaches a child process that was handed the application.** A stack contributes
      directories through `BinPath`, which is asked *of an app*, so an `exec`/`runBin` call with no
      `app` gets the inherited PATH and the real binary. That is how `docker-publish`'s specs found
      the real `docker` again the moment the service stopped threading it - every spawn site inside
      a service must pass `pkg.repository.app` (or `this.repository.app`).
- **`packages/node/test/_fixture.ts`**: `declarePlugin()`/`runCli()` for the command path (a real
  `plugins` load, which is the only way a plugin's *commands* exist), `useNodeEcosystem()` for specs
  that call a service directly. `declarePlugin` writes to `Workspace.findRoot(dir)`, not to `dir` -
  a `plugins` entry dropped inside a package is never read, since `findRoot` takes the outermost
  `.rmanrc` (measured as `Unknown argument: clean`). Its `plugins` entry names `src/index.**ts**`:
  `resolveConfigTarget` checks the filesystem and there is no `.js` before a build.
- **A fixture writing a workspace must mark the root** with an `.rmanrc` (or a `.git`).
  `Workspace.findRoot` runs *before* the plugins that would know what a package is, so `workspaces`
  in a `package.json` means nothing to it. One spec deliberately writes no marker - that is the case
  under test.
- `expectCliFailure()` wraps a CLI call expected to fail, **inside** `captureLogs`, not outside: a
  rejection thrown through `captureLogs` loses the lines the assertions were going to read. It
  replaced a `process.exit` stub that was only ever needed because `runCli` exited from inside the
  library; it also asserts the failure, which the stub never did.
  - **A failure thrown during *setup* prints to `console.error`, which `captureLogs` does not
    patch.** Anything thrown while `Repository.create` runs - a plugin that will not load, no
    manifest to find - never reaches the `logged` convention, so `runCli`'s own catch prints it.
    Left through, it does worse than clutter the report: the reporter and the stray write race for
    the same stream and a line comes out spliced (measured -
    `Plugin "./p.mjs" must export an rman conf      ✔ throws a clear error...`). A spec expecting a
    setup failure silences **both** streams - see `plugin.spec.ts`'s own `expectCliFailure`.
  - The quickest way to find a leak is to diff a run's output against what mocha itself prints:
    every line that is neither a suite title nor a result came from the code under test.
- **A fixture repository sets `user.email`/`user.name` in its own config, right after `git init` -
  never per command with `-c`.** The code under test commits too (`applyPlan` makes one per group
  plus the root's version sync) and cannot be handed an identity, so a fixture that configures only
  its *own* commits passes on any machine with a global identity and fails on a fresh CI runner
  with `fatal: empty ident name`. That is exactly how it failed, in GitHub Actions and nowhere else.
  - **Reproduce a runner locally with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`**,
    which is the whole difference and takes one run rather than a push. Worth doing for any change
    that touches a fixture's git setup.
- **The test tree must load exactly ONE copy of the core, and `tsconfig-test.json`'s `paths` is what
  enforces it.** Map *every* specifier the specs can reach it by - `"rman"` **and** `"rman/cli"`,
  and any subpath export added later. With `"rman/cli"` unmapped, a spec importing it got the built
  copy out of `node_modules` while `"rman"` gave the source one: two module instances, two sets of
  module-global registries. `rman info` then ran the build copy's `SystemInfo` while the plugin had
  augmented the source copy's, and reported `Binaries: [Node]` with no npm.
- **`--parallel` hides a broken suite, so verify with `--parallel=false` whenever a change touches
  a registry, an augmentation or a fixture.** Measured, and not a small margin: a run reporting
  **636 passing** in parallel was **595 passing / 41 failing** serially, on the same commit. Workers
  load only the files assigned to them, so a spec that depends on another file's import-time side
  effect - or is rescued by one - passes there and nowhere else.
- **A fixture registers the plugin class itself (`new NodePlugin()`) - never the module's default**,
  which is an rman *config* (`{ plugins: [new NodePlugin()] }`). Reading the default silently
  registered nothing: `plugin.manifest` and friends were `undefined`, so a service-level spec had no manifest
  provider, no version planner, and **no `BinPath` provider** - which left `exec` resolving the real
  `npm` from the inherited PATH. The suite reached `registry.npmjs.org` with an actual
  `PUT /pkg-a`, and only `ENEEDAUTH` stopped it. The docker rule applies here word for word: a test
  must never be one credential away from publishing.
- **A spec that patches a core function captures the original in `beforeEach`, not at module
  scope.** At module load, whether `SystemInfo.getSystemInfo` is already augmented depends on
  whether the plugin's entry point happened to be imported first - a function of file order, and
  therefore of `--parallel`. Restoring a module-scope capture put the *un-augmented* function back
  for the rest of the process and broke a spec two files away.
- `import { expect } from 'expect'` - the named form. The default import works at runtime through
  CJS interop and produced ~287 type errors, which is why the test tree never type-checked. Both
  `test/tsconfig.json`s are clean now; keep them that way.
- **`npm run typecheck` is what keeps them that way, and it exists because nothing else looks.**
  `npm test` runs mocha, which transpiles without type-checking, and `npm run build` compiles `src`
  only - so a spec can be wrong about a type indefinitely. Measured on the exact mistake that
  prompted it (a *core* spec typing its fixture with `rman-node`'s `clean`): `typecheck` reports
  `'clean' does not exist in type 'RmanConfig'`, mocha reports `1 passing`.
  - One pass per package (`tsc --noEmit -p packages/*/test`) covers `src` too, since each test
    tsconfig includes `../src/**/*.ts` - and covers it under the settings the *specs* load it with,
    which is where the one-copy-of-the-core `paths` mapping lives.
  - In CI as its own job on one Node version, beside `lint`: the answer does not vary by runtime, so
    running it inside the test matrix would pay for it three times.

## `npm run smoke` - what the suite structurally cannot see

[`support/smoke.cjs`](support/smoke.cjs), [`support/smoke-types/`](support/smoke-types).
**Mocha resolves `rman` through `tsconfig-test.json`'s `paths` to `src`, which is a different
module graph from the compiled one**, and `packages/rman/test/tsconfig.json` includes every source
file. Two whole classes of failure are invisible to 843 passing specs because of it, and both were
live at once:

- **An ESM cycle that is fatal in `build/` and harmless in `src`.** The built CLI did not start, on
  any command, from the commit the node plugin moved inside rman:
  `ReferenceError: Cannot access 'VersionPlanService' before initialization`, through
  `core/repository -> plugins/detect -> plugins/builtins -> plugins/node/... -> version-plan`.
  `detect.ts` imported `builtins.js` statically; `config.ts` already imports it dynamically and
  documents the same cycle from the other side. **Any new static import into `plugins/` from `core/`
  is this bug again.**
- **A `declare module` augmentation that reaches rman and nobody else.** The node plugin's lives in
  `plugins/node/augmentation/rman.augmentation.ts`, imported by the *plugin's* entry point, which
  `index.ts` did not reach - so `clean` and `publish.npm` were typed inside rman and were
  `does not exist in type 'RmanConfig'` for a consumer. The same trap `commands.ts` records, and it
  reappeared because until the fold a consumer imported `rman-node` and got the augmentation with
  the package. **A spec cannot pin it**: the test tsconfig loads the augmentation whether or not
  anything imports it, so an assertion that `clean` is typed passes with the fix reverted.
  `support/smoke-types/` resolves `rman` to the built `index.d.ts` **and to nothing else**, which is
  the only vantage point that can tell.

Four checks: `--version` (the module graph alone), `list` (repository, workspace, config cascade),
`clean --dry-run` (a *contributed* command existing at all), and that consumer typecheck. Run after
`npm run build`; in CI beside `typecheck`. Each was verified by reintroducing the bug it exists for.

It also caught a second casualty of the same fold: this repository's own `.rmanrc.yml` still said
`extends: './packages/node/build/index.js'`, a path into the deleted package, so every command here
exited 1.

## The build must not need rman

`npm run build` is `npm run build -w packages/rman && npm run build -w packages/node` - plain npm,
in that order, never `rman build`.

**It was `rman build`, and that is a bootstrap loop that only bites on the release that matters.**
The `rman` on PATH is whatever is *published*, so a version introducing a config feature cannot
build itself: the repository's own `.rmanrc.yml` already uses `plugins` and `"[*]"`, neither of
which 1.0.x understands. The failure lands exactly when a release is being cut.

- **Order is the whole content of the script**, and `rman` first: `rman-node`'s build resolves
  `rman` from `packages/rman/build/index.d.ts`, and each package's `postbuild` writes its published
  manifest. `packages/node/tsconfig.json` does carry `references: [{ path: "../rman" }]`, so `tsc`
  would order the *compilation* on its own - but not the pre/post hooks around it, which is what the
  script sequences. Two packages, so the order is written out rather than derived; deriving it would
  mean reimplementing the thing being bootstrapped away from.
- npm runs each workspace's `prebuild`/`postbuild` itself, so nothing else moves.
- **CI needed no change, and that was worth checking rather than assuming**: the release workflow
  (`panates/github-actions/.github/workflows/node-release.yaml@v1`) calls rman nowhere - packages
  come from `gh-repository-info`, publishing from `release-npm`, the release from `ncipollo`. Its
  `build_script` input defaults to `npm run build`, so `npm run build` was the single place CI
  depended on rman at all.
- Measured from a clean tree with rman absent from PATH entirely: both packages build in ~2.6s, and
  the output is what `rman build` produced - generated manifests, README/LICENSE copied, `bin` at
  755, the version constant stamped (`node packages/rman/build/cli.js --version` reports the new
  one).

Dogfooding is not gone, only off the critical path: `npx rman build` still works once a build
exists, and is the right thing to run when changing `RunService`.

## Linking a built package into another repository

**`packages/<name>/build` *is* the published package** - `postbuild.cjs` writes a `package.json`
there whose `exports` are relative to it. So the way to try a local build in another repository is to
symlink that directory as the package itself:

```bash
ln -s <rman>/packages/rman/build  <other-repo>/node_modules/rman
ln -s <rman>/packages/node/build  <other-repo>/node_modules/rman-node
```

Two things this measured, both of which cost more time than the linking did:

- **`tsc` writes a bin at 644, and npm is what normally makes it 755.** Linked rather than installed,
  `node_modules/.bin/rman` then points at a file the shell refuses - `permission denied`, with the
  shebang present and correct, which sends the reader to look at the shebang. `postbuild.cjs` now
  chmods every `bin` entry, so it survives each rebuild.
- **A plugin resolves `rman` from its own location, not from the repository using it.** So
  `rman-node`'s `import 'rman'` walks up from `<rman>/packages/node/build` and lands in **this**
  repository's `node_modules` - linking it elsewhere changes nothing about that. Its `node_modules/rman`
  therefore has to resolve too, and pointing it at `packages/rman/build` (rather than at
  `packages/rman`, which npm's workspace link does) is what makes it: the build directory is the
  published layout, so no dev-time bridge file is needed at all. The same link makes the whole test
  suite run - `packages/node/test/*` imports `'rman'` by name.
  - Caveat worth stating: with that link, node's specs run against the **built** core rather than
    `src`, so a stale `build` is silently what gets tested. `npm install` restores npm's own
    workspace links and undoes all of this.

## Docs: two reference files, and a baseline in each

**There were four, two per package, and there is one package now.** The split existed so a reader
asking what `rman` is need not know which half of the answer is npm's; `rman-node` was folded in, so
`docs/node.md` and `docs/cli-node.md` are **deleted** rather than stale. Don't recreate them.

| | |
| --- | --- |
| [`docs/cli-rman.md`](docs/cli-rman.md) | every command, plus global options, the shared option groups, and **Where a command comes from** |
| [`docs/rman.md`](docs/rman.md) | the programmatic API, the config reference, and **The `node` built-in** |

- **`docs/cli/*.md` stays one page per command**, which was always the right unit and is now
  unarguable: a reader looking up `rman clean` did not need to know which package shipped it, and
  there is nothing left to know.
- **Named `cli-rman.md`, not `cli/rman.md`.** The latter was tried and reverted within the hour: a
  `docs/cli/rman.md` beside a `docs/rman.md` makes every relative link ambiguous to a *reader*, who
  sees `rman.md` in two places meaning two different documents.
- `SystemInfo` is the exception worth remembering, and not an inconsistency: the service and the
  `info` command are the **core's**, so they are in `rman.md`; the npm half the plugin augments in
  is a short section of `node.md` pointing back at it.
- **Check anchors with github-slugger's rule, never by eye - and it is not a dependency here**, so
  the pass implements it inline: lowercase, drop everything that is not a letter, number, mark,
  connector, hyphen or space, then spaces to hyphens. Verified against the two cases below. Two long-standing links never jumped:
  `#configuration-rmanrc-rmanrcyml` needs **two** hyphens (the ` / ` in the heading becomes one each)
  and `#expressions--` needs **three**. A link to a missing anchor silently lands at the top of the
  page, so nothing reports it.
- A **published README must not carry relative `docs/` links.** `packages/*/README.md` ships to npm,
  where no `docs/` directory exists - and since the READMEs moved under `packages/`, a relative link
  was broken in the repository too. Use the full `https://github.com/panates/rman/blob/main/docs/...`
  URL.

Each file starts with an HTML comment block (`docs-baseline`) recording the git commit, package
version, and date it was last verified against source - see that block for the exact format and the
`git diff <commit>..HEAD -- <its own src>` command it documents.

Rules:
- Whenever you write or update these API docs, record (or update) that baseline block with the
  commit you verified against - so a later session can diff from a known point instead of
  re-reading everything from scratch.
- Before trusting/updating the docs, diff that package's `src/` (and its `test/**/*.spec.ts` for
  examples) between the recorded commit and `HEAD` to see what actually changed, then update only
  the affected doc section(s) - don't regenerate everything unless the diff is broad enough to
  warrant it.
- After updating, bump `git-commit`/`package-version`/`date` in the baseline block to the new
  `HEAD` (only once the docs are verified accurate as of that commit).
- **Re-read a signature from source before moving a section between these files.** The move looks
  mechanical and is not: the sections moved out of the old `docs/api.md` were at a baseline three
  refactors old, and carried a `getSystemInfo(packageManager, options)` and a `detectChangeHash`
  that no longer existed.
- **`docs-api.spec.ts` is the only thing that ever looks at these docs.** It imports every name
  `docs/rman.md`'s Installation block advertises and type-checks its command-declaration example
  verbatim, so a name the package stops exporting fails at compile time. It is a **floor, not a
  contract**: a name *added* to the package does not fail it, and no prose is checked at all. The
  whole arc that made services classes, merged the plugin seams into one `Plugin` and introduced
  `RmanApplication` left the page describing none of it, because nothing looked - mocha transpiles
  without type-checking and no spec imported what the page claims.
- **Check anchors after any heading change.** The last full pass: **243 links, 1 broken** - and that
  one is `packages/rman/README.md -> LICENSE`, which resolves in the *published* package, where
  postbuild copies the root LICENSE beside the README. A link to a missing anchor lands silently at
  the top of the page, so nothing else reports it.
