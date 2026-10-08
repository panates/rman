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

## A class's own steps are `protected` members, not module functions

**The rule above is about a module's helpers; this one overrides it for a class.** Whatever a class
uses to do its work - a helper function, a list of names it checks against - is a `protected` method
or field on the class, never a module-scope `function` or `const` below it.

- **A module function cannot be replaced, and that is the whole cost.** It is unreachable from
  outside its file, so a subclass can override the public method and nothing inside it: the one
  seam a technology needs (`NodeVersionPlanService extends VersionPlanService` replacing
  `detectBoundary` and `cascade` while keeping the orchestration) is exactly the shape a private
  function forbids. A spec cannot stub one either, and per `Service` a stub that *can* be written
  has to be - mutating a module is the failure CLAUDE.md already records, where restoring a
  module-scope capture broke a spec two files away.
- **A list a step checks against is a `protected readonly` field**, for the same reason and with
  one extra rule: type it `readonly string[]` rather than letting the literal infer, or the declared
  type is those exact strings and no other list satisfies an override. `ConfigService.configFiles`
  is the worked example - and it comes in a pair with `configFileKind`, because a subclass adding a
  name also has to say how that name is read. A field a subclass can widen while a sibling method
  still refuses what it added is half a seam.
- **`CODE_SUBTREES` is the exception, and it is not a class's.** It is a module const because
  `type CodeSubtree = (typeof CODE_SUBTREES)[number]` derives from it - a class field has no type
  to derive. The test is whether a *type* reads the value, not whether the value feels constant.
- Pure functions of their arguments that no class uses stay plain exported functions - the line
  `Service` already draws. This rule is about the steps of a class that exists.

## Class member order: the shape, then the door, then the API, then the workings

```
static constants
public fields
protected fields
private fields

static factories          // create(), from() - they stand in for the constructor
constructor

get / set
public methods
protected methods
private methods
static helpers            // protected/private statics
```

**This is `@typescript-eslint/member-ordering`'s default with one deviation**, and the default is the
closest thing to a standard here. The deviation: the rule puts *every* static method after the
accessors, which buries a factory - and a factory is how you get an instance, so it belongs beside
the constructor it replaces. `Workspace.create` sitting below `packageAt` would hide the only door
into a class whose constructor is `protected`.

- **Public before private, at every level**, which is the same rule as the file layout above: what
  is written for a caller comes first. Inverting it inside a class while the file around it says the
  opposite is two directions in one file. `Workspace` opening on `_levels` and `_configReader` -
  two bookkeeping Maps - is what that costs.
- **Fields before behaviour**, so the shape of the object is visible before what it does. That is
  the half of the common "private fields first" habit worth keeping; the visibility half is not.
- **Not enforced by lint yet.** Adding `member-ordering` turns most existing files red at once, so
  it is a rule to apply to new and rewritten classes first. Enforce it when the tree has caught up -
  a checked rule beats a remembered one, and this one is easy to forget.

## TSDoc is for the caller; the reasoning goes in a block comment beside it

**A `/** ... *&#47;` block is API documentation and nothing else** - what the thing does, what it
takes, what it gives back, what a caller has to know to use it. It is what an editor shows on hover
and what a doc generator publishes, so everything in it is read by someone who only wants to call
the function.

**Everything else - and this repository has a great deal of it - goes in a plain `/* ... *&#47;`
block immediately below the TSDoc.** The measurement behind a decision, the alternative that was
tried and failed, the trap a future editor would otherwise fall into, the spec that pins it: all of
that is for whoever *changes* the code, not for whoever calls it.

```ts
/**
 * Builds and initializes a workspace.
 */
/* **`new this()`, not `new Workspace()`.** In a static method `this` is the class the call was
 * made on, so a subclass inheriting this factory builds itself; hard-coding the name would let
 * someone override `_init` and never see it run. */
static async create(...)
```

- The split is by **audience**, not by length. A one-line note about why a parameter exists is still
  a note; a paragraph a caller genuinely needs is still TSDoc.
- **Inline comments inside a body stay where they are.** This rule is about the block attached to a
  declaration, which is the only one an editor surfaces.
- The same applies to a `protected` member: its TSDoc is read by a subclass author, and the reason
  it is shaped that way is not.
- Do not simply delete the reasoning when it does not belong in the TSDoc - this repository's
  comments *are* its record of what was measured, and losing one costs the next session the
  measurement. Move it down, do not drop it.

## `config.ts` is gone - five files, each with one subject

It was 1528 lines holding the reader, the interpolator, the filesystem scope, the types and the path
constants at once, and its spec was `core/config.spec.ts`. Where each half went:

| | |
| --- | --- |
| [`core/config/config-reader.ts`](packages/rman/src/core/config/config-reader.ts) | what the **files say** - one config per directory, `extends`, presets, `plugins`/`platforms`, selector parsing |
| [`core/workspace.ts`](packages/rman/src/core/classes/workspace.ts) | which directories hold packages, what each answers to, and the **cascade** into `Package.rawConfig` |
| [`core/config/config-interpolator.ts`](packages/rman/src/core/config/config-interpolator.ts) | what those words **evaluate to** - every `${{ }}`, every value function, `defer(...)`'s second pass |
| [`core/config/config-file-scope.ts`](packages/rman/src/core/config/config-file-scope.ts) | the `file` and `read(...)` members of the expression scope, and the parse cache |
| [`interfaces/config-scope.interface.ts`](packages/rman/src/interfaces/config-scope.interface.ts) | what an expression can **name**: `ConfigScope` and its members |
| [`interfaces/rman-config.interface.ts`](packages/rman/src/interfaces/rman-config.interface.ts) | `RmanConfig`, and the author/reader pair `ConfigValue` / `Resolved` / `ResolvedConfig`, plus `defineConfig` |
| [`core/config/config-paths.ts`](packages/rman/src/core/config/config-paths.ts) | `CODE_SUBTREES`, `STEP_PATHS`, `DEFERRED_PATHS` |

- **The split is by *lifetime*, not by size.** Reading happens per directory, before any package
  exists; interpolating needs `pkg`, `repository`, `file` and `git`, which only exist afterwards.
  One class holding both would have a method that throws when called in the wrong order - which is
  what the old module was, with the ordering kept by convention.
- **`config-paths.ts` is three module consts and stays that way.** `CodeSubtree` derives from
  `CODE_SUBTREES` with `(typeof ...)[number]`, so the value has to be a value a *type* can read -
  the one exception to "a class's own steps and lists are `protected` members". `DEFERRED_PATHS` has
  five readers across `core/`, `commands/` and `services/`, which is why the three live together
  rather than on whichever class happens to walk them.
- **The scope interfaces are `interfaces/`, not `core/`.** Nothing in them runs, and the audience is
  a config author - the same line `rman-config.interface.ts` already drew. `ConfigValue` moved in
  beside `RmanConfig` for a smaller reason that is still worth stating: that file *imported* it, so
  the move removed an import rather than adding one.
- **`core/config.spec.ts` is `core/rman-config.interface.spec.ts`**, and holds only the type-level
  pins - checked by `npm run typecheck`, not by mocha. The behaviour it used to cover is in
  `config-reader.spec.ts`, `config-interpolator.spec.ts`, `config-file-scope.spec.ts` and
  `workspace-create.spec.ts`, each self-contained.
- **Two pins nearly went missing in the move, and the rule is to look for them.** `FileScope`
  exposing *exactly* `exists`/`resolve`/`resolveFirst` - the spec that stops someone adding a
  plausible `copy` - and "the directory is untouched" lived in the old spec and had no equivalent in
  the class's; both are in `config-file-scope.spec.ts` now. A behaviour with a duplicate
  implementation does not mean it has a duplicate *spec*.

## Config: who a declaration is about

[`ConfigReader`](packages/rman/src/core/config/config-reader.ts) reads it and
[`Workspace`](packages/rman/src/core/classes/workspace.ts) cascades it. One sentence decides it: **what is written above reaches
below, and a `"[selector]"` narrows the audience.**

- **An unmarked key configures that directory and every package under it.** The repository root's
  own `.rmanrc` is therefore the baseline for the whole repository, the root package included.
- **A `"[selector]"` block narrows it.** Three audiences, and what each is matched against:

  | | | matched against |
  | --- | --- | --- |
  | `"[/]"` | the **root package** alone, structurally | - |
  | `"[platform:node]"`, `"[platform:node,cargo]"` | every package of those **technologies**, the root included | `pkg.platform.name` |
  | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | the packages this directory holds that the glob matches - **in a monorepo those are the ones below it; in a single-package repository it is the root, which is the one package** | `pkg.selector` |

  - **Only a glob is held off the root, and only a *monorepo's*** (`Workspace._speaksFor`). The two
    reasons are both about names and both are statements about a container: `"[my-*]"` must not pick
    up a repository whose root package happens to be called `my-repo`, and a catch-all must not hand
    a package-shaped setting to a root with no build directory. Neither survives in a repository the
    root has nothing below - there it is not a container sharing a name shape with its contents, it
    *is* the package, and it does have the build directory. Neither applies to `platform:node`
    either, which is not a name and is not a catch-all - so a platform block answers about the root
    like any other package. It read the other way "for consistency with a glob" until nesting
    arrived, and that made `"[platform:node]" > "[/]"` unanswerable.

  - `/` for the root because that is what a repository root is called everywhere else, and no
    package can be named it.
  - **The CLI shares this vocabulary**: `--scope /` / `--ignore /` is the root package, a glob never
    matches a monorepo's root and does match a single-package repository's, so `"[*]"` and
    `--scope '*'` mean the same set. They disagreed until 2.0 - measured, `rman clean --scope
    'rman*'` selected this repository's root. **Change one and you must change the other**
    (`package-filter.ts`'s `selector()` carries the identical clause), or a repository's config and
    its `--scope` disagree about what a package is. See the shared-flags section below.
  - **A monorepo's root is never selected by name, and that one rule removes two traps.** A glob
    matches package names and a monorepo's root is nobody's child, so `"[my-*]"` cannot quietly pick
    up a repository whose root package is called `my-repo`, and `"[*]"` cannot hand a package-shaped
    setting to a root with no build directory to apply it to. There the root is addressed
    structurally or not at all. (That second trap was real: three specs in `repository.spec.ts` broke
    the day `"[*]"` reached the root, all `${{ file.resolve(...) }}` asking about a `tsconfig.json`
    the root does not have - and all three are monorepo fixtures, which is why they stayed green when
    the rule was narrowed to monorepos.)
  - **In a single-package repository `"[/]"` and `"[*]"` both reach the one package**, and are
    layered in declaration order like any two siblings. That overlap is not a conflict to resolve:
    `"[/]"` says *the repository* and `"[*]"` says *its packages*, and in a repository of one those
    are the same object.
    - **What the blanket rule cost, measured on `panates/postgrejs`**: `@panates/rman-preset`
      declares its whole package block under `"[platform:node]" > "[*]"` - `run.build`,
      `publish.npm.directory`, `version.stamp`, the build directory's `clean.include` - and *none* of
      it reached that repository. `rman build` answered `No package defines a "build" script.` and
      `rman config` simply lacked the four keys, with nothing reporting that a block had matched
      nobody. The workaround would have been for every single-package repository to restate the
      preset's block under `"[/]"` - the duplication a shared preset exists to remove, and not even
      writable in YAML, since two of those values are JavaScript functions the preset keeps to
      itself.
    - **`Workspace.monorepo` is the one derivation** (`packages.length > 0`, a getter).
      `Repository.create` used to compute it again for the constructor argument; two copies of it
      could disagree silently, resolving a config under one answer and building the package list
      under the other.
    - **`_assertNestable` still refuses `"[/]"` nested with a glob, in every repository.** The
      refusal is now a false negative for a single-package one, where both would match - and it
      stays, because `ConfigReader` runs per directory *before* any package is known and so cannot
      ask the question. Nothing is lost: there `"[/]"` alone already reaches everything.
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
  - **A selector block may hold further selector blocks, and nesting is an AND**
    (`Workspace._matchingSelectors`, `ConfigReader._assertSelectorKeys`). A nested block applies
    where its own audience *and* every audience it sits inside all match:

    ```yaml
    "[platform:node]":
      group: node
      vars: { tier: base }
      "[pkg-*]": { group: node-and-pkg, vars: { tier: narrowed } }
    ```

    - **It was refused outright until 2.0.0-beta.4, and the reason given does not survive being
      written out.** "Selectors do not intersect, because `selectorRank` was dropped" answers a
      different question: ranking orders two *siblings*, and nesting asks nothing of the sort - a
      nested block is resolved depth-first in declaration order, which is the rule already in force
      one level up. What it cost was the only way to narrow a whole block; `if:` is per key and
      exists on run steps alone, so `vars`, `clean.include` and `publish.npm.directory` were out of
      reach. The user asked for it directly ("her şeyin başına if koyamayız, özellikle variables
      lara") and was right.
    - **Nesting narrows the audience; it does not raise precedence.** Depth-first **pre-order**: a
      block's own keys, then the blocks inside it, then the next block beside it. So
      `"[platform:node]" { a, "[pkg-*]" { b } }` then `"[*]" { c }` layers `a, b, c` and the
      catch-all still wins - the same cost the dropped ranking already documents, not a new one.
    - **A matching block is merged *stripped*** (`_stripSelectors` on the block, then recurse), or
      its nested keys land in the resolved config as literal `'[pkg-*]'` entries. That is exactly
      how the old no-op showed up: measured, a package matching *neither* resolved to
      `{ group: 'node', '[pkg-*]': { group: 'node-and-pkg' } }`, so the outer block applied to
      everyone and `rman config` showed the inner one looking as though it had worked. **Silence is
      the half of the old refusal worth keeping**, and the two checks below are what keep it.
    - **A selector under a *setting* is refused** - a setting is not an audience, so
      `"[*]" > run > build > "[pkg-*]"` could never be applied. One walk does both jobs
      (`_assertSelectorKeys`), and `at.length > enclosing.length` is the whole test: the two arrays
      stay equal while every ancestor is a selector and `at` runs ahead the moment one is not.
    - **`"[platform:node]" > "[/]"` is the pair the whole thing is for**, and getting it wrong once
      is why this is written out. It means *the root, when the root is a node package*, and it plus
      `"[platform:node]" > "[*]"` is a technology's entire shared config in one block - `vars`
      included, since those are the parent's own keys and reach both. It was refused at first on a
      misdiagnosis: the audience is not empty, `_speaksFor` merely asked `isRoot` before it asked
      the platform question. **A narrower repair was tried and measured wrong** - let a chain reach
      the root only where it *names* `"[/]"`, keeping a plain `"[platform:node]"` off it. That
      answers the pair and still breaks the case: the nested block came back `vars is not defined`,
      because `vars` is the parent's key. Narrowing an audience and hiding the enclosing block's
      settings from it are different things.
    - **A nested pair that could never match together is refused** (`_assertNestable`), rather than
      loading and matching nobody. Two are decidable: **`"[/]"` paired with a glob**, either way
      round (a glob matches a name and the root is nobody's child), and **two platform blocks naming
      nothing in common** (a package carries one `platform.name`;
      `"[platform:node,cargo]" > "[platform:node]"` narrows and is fine). `ParsedSelector.names`
      exists for that intersection - `test` alone answers "does this one match", not "can anything".
      **A glob pair is deliberately not checked**: glob intersection is a real computation with a
      wrong answer available both ways, where a platform set is `includes`, and `"[pkg-*]" >
      "[lib-*]"` matching nothing is what a top-level `"[lib-*]"` already does unreported.
    - **`platform` is the one key a nested `"[/]"` cannot carry.** Which technology claims a
      directory is settled before any block is matched, so `Workspace._declaredPlatformName` reads
      the level's own key or a **top-level** `"[/]"` and nothing deeper - and inside a platform
      block it would be deciding whether its own block applies.
    - **`vars` and the contribution keys are exempt**: their contents are not config keys. `vars` is
      free-form by contract and `CODE_SUBTREES` hold plugins, commands and publish targets, whose
      key space rman does not own. A bracketed name in either is data.
    - **`_stripSelectors` carries the object's own symbols, and leaving them behind was a measured
      loss that predated nesting.** `mergeConfig` reads a key's `ORIGINS` and `PREVIOUS_VALUES` off
      the *source*, so a copy holding only string keys arrives with neither. Measured on one
      repository: an unmarked `group: "${{ nope.boom }}"` reported `Invalid expression in "group"`
      with **no file**, while the identical expression inside `"[*]"` named `.rmanrc` - because a
      block was merged as itself and only the unmarked layer went through the copy. Nesting would
      have spread that to the blocks too. Pinned in `repository.spec.ts` across all three layers.
  - **`"[ws:*]"` / `"[workspace:*]"` is accepted and means exactly `"[*]"`.** The qualifier said
    "not the root" back when a bare glob included it; the shape of the set says that now. Kept
    working rather than rejected because both spellings resolve to the same packages - an error
    would be friction with no reader to protect. Retired from the docs; don't write it in new code.
  - The root *package* is the one whose directory is the repository root - no other test, and none
    would be as reliable, since a name can be anything. In a single-package repository that is the
    only package, so `"[/]"` and `"[*]"` both reach it.
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
  - The other repo-wide keys (`allowBranch`, `version.*`, `githubRelease.*`) may
    cascade or not without consequence - nothing reads them at package level - but `"[/]"` still
    reads better for them.
  - Migration from 1.2.x, in three mechanical rules plus that one: `"[ws:*]"` → `"[*]"`; old `"[*]"`
    (which included the root) → unmarked; a root key that is genuinely the root's → `"[/]"`.
- **`vars` is declared at any level of the config and scopes its own subtree**
  (`ConfigInterpolator._withScopedVars`): a fresh copy per level, the level's own block merged **per key**
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

[`ConfigReader._resolveExtends`](packages/rman/src/core/config/config-reader.ts),
[`src/core/config/merge-config.ts`](packages/rman/src/core/config/merge-config.ts). It was `extends-config.ts`,
beside a `readDirConfig` in `config.ts`; both are `ConfigReader`'s methods now, which is what closed
the gap below about a `.cjs` base loading differently from a `.cjs` config.

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
- **A bare `extends` package that cannot be found is a warning and a question, not a refusal**
  (`ConfigReader`'s `onMissingExtends`, `cli.ts`'s `confirmMissingPresets`). The case: a repository
  whose `node_modules` is not installed has its shared preset nowhere, and refusing to start left
  `rman ci` - the command that installs it - unable to run. The CLI lists them, leaves their
  settings out and asks (Enter goes on, Esc cancels); `--yes` (now a **global** option, beside the
  per-command ones of the same name) goes on; with no terminal it stays an error, since a release in
  CI quietly built without its preset is worse. A relative path still throws (the repository's own
  file, so a typo), and so does a library caller that passes no callback. `--help` never stops.
  - **A spec must not leave `process.stdin.isTTY` true** when it reaches this: mocha run from a
    terminal has one, and the run would wait on a key. `cli.spec.ts` sets it false for its cases.
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
  - **`plugins`, `platforms`, `commands` and `publishTargets` still append without being asked** -
    see `ALWAYS_APPEND`. There that is what the *key* means rather than a choice made per layer.

### Presets: `extends: "rman:node"`, and the ones laid down by default

[`src/builtins/presets/`](packages/rman/src/builtins/presets), `ConfigReader._applyPresets`. **A preset is an rman
config, not a type of its own** - `platforms`, `commands` and `publishTargets`, which are keys that
already existed. `extends: "rman:node"` resolves the `rman:` prefix against rman's own module and
merges it underneath, exactly like any other base; a polyglot repository writes
`extends: ['rman:node', 'rman:cargo']` and gets both, because every key a preset holds appends.

- **A function, not a value** (`export default nodePreset`), and `_readConfigFile` calls whatever a
  config module exports. `augmentSystemInfo()` mutates the core's `SystemInfo` in place, so a preset
  evaluated at *import* time would have `rman info` reporting npm's tooling in a repository that
  never named it.
- **Its contributions must be identical across calls**, or a repository naming a preset that is
  *also* laid down by default contributes it twice. `appendList` de-duplicates these keys by
  identity, so `nodePlatform` and the two commands were already safe and `new NpmPublishTarget()`
  was not: measured, two targets called `npm` reached `publish`, whose own collision guard fired on
  a target colliding with itself (`both declare an option named "packageManager"`). The instance is
  a module singleton now. **A new preset has to do the same.**

**`DEFAULT_PRESETS` is laid under every repository root**, so a repository that writes no config at
all still has the `node` technology, `clean`, `ci` and the npm target. `Workspace` passes it to the
**root level only** - everything below inherits what the root settled on - and a caller passing
`presets: []` gets a bare core, which is what every case in `workspace-create.spec.ts` does.

- **Loaded *after* whatever the config declared, and that is the whole safety of it.**
  `platformFor` takes the first technology that recognizes a directory, so a repository writing
  `extends: 'rman:cargo'` has its own platform ahead of node - and a root holding both a
  `Cargo.toml` and a tooling `package.json` resolves to what it declared. Pinned in
  `workspace-create.spec.ts` ("lays rman's own presets under the root, **behind** whatever the
  repository declared"), where a `manifest.json` platform keeps a root that also has a
  `package.json`.
  - **The config's own `platforms` array runs the other way round** (`[node, ...declared]`, because
    the presets merge underneath like any base) and nothing reads it. `context.platforms` /
    `Workspace.platforms` is the order-bearing list; the array is the record of what was
    contributed. Worth knowing before reading one off `rman config` and expecting it to say who
    claims what.
- **A list of names, never an import** ([`src/builtins/presets/index.ts`](packages/rman/src/builtins/presets/index.ts)
  exports `DEFAULT_PRESETS` and imports nothing). A preset module pulls in a platform, its commands
  and its services, one of which extends a core service - so a static `core/` → `presets/` import is
  the ESM cycle that stopped the *built* CLI dead on every command and that `npm run smoke` exists
  to catch. `_resolvePreset` goes through the same dynamic `import()` an `extends` does.
- **This replaced detection** (`plugins/detect.ts`'s `detectBuiltin`), which asked each built-in
  "is this directory yours?" *without turning anything on*, then merged the matching preset
  underneath. What it bought was a repository not growing a technology's commands unasked; what it
  cost was a catalogue module, a `Builtin` type, a per-directory memo, a `DETECTED_BUILTIN` symbol
  and a gate that had to decide what counts as having "said something" - three conditions, the third
  of which (a technology already on the application) was measured as worth ten specs. The platform
  answers the same question now, from the ordinary registry, once loaded.
  - **The cost, stated rather than hidden**: a repository of some other technology carries node's
    `clean` and `ci` in `rman --help`, `rman info` reports npm's tooling, and every package's
    `rman config` shows the preset's contribution keys. rman ships one preset, so none of that is
    visible today. **Split this list's presets in two - the platform apart from the commands - if
    that stops being acceptable**; the alternative considered and rejected was making the default
    layer conditional again, which is detection with extra steps.
- **`presets: []` is the opt-out**, on `Repository.create`, `runCli` and `Workspace.create` alike -
  a caller that brought an ecosystem of its own. **The core's own fixture passes it, and that is a
  safety rule rather than tidiness**: with the presets in, `publish.command.spec.ts` ran a **real
  `npm publish` against registry.npmjs.org** and only a 404 stopped it - the npm target arrived in
  a synthetic repository, claimed a package and published it. Same failure `useLocalBin`'s doc
  records for `docker`, by a new route. A spec that wants the shipped preset asks for it:
  `plugins/node/_fixture.ts` writes `extends: ['rman:node']`, and the cases about the default call
  `Repository.create` directly.

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
  no point during a run - no ajv, no key check in the reader at all - so an unknown key in those
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

## `builtins/`: what rman ships, filed by what each thing *is*

```
builtins/platforms/node/            the Node.js ecosystem - package.json, workspaces,
                                    node_modules/.bin, the version planner
builtins/publish-targets/npm/       the npm registry - npm view, npm publish
builtins/publish-targets/docker/    a registry of images - docker manifest inspect, docker push
builtins/presets/                   the configs that hand those to a repository
```

**Filed by subject, not by who uses it.** That is the same rule the config classes follow, and it is
easy to argue the other way by accident: "move X next to its caller" and "move X to drop a
dependency edge" are both statements about *usage*, and neither says what X is.

- **`npm-view.ts` is under the target, not under the platform, and it is the worked example.**
  `platforms/node/` is about the Node.js *ecosystem* - a package there can be private, published to
  another registry, or never published, and nothing about the platform changes. `npm view` is the
  npm registry's CLI, which is what `publish-targets/npm/` is named after.
  - The argument for moving it to the platform was that two files under `platforms/node/` import it,
    so moving it would drop a cross-edge. That is a graph argument wearing a subject argument's
    clothes; it was made and withdrawn.
  - **The edge it leaves is a true sentence, so leave it**:
    `platforms/node/node-manifest.provider.ts -> publish-targets/npm/npm-view.ts` reads as *the Node
    ecosystem's manifest provider asks the npm registry what version is out there*, which is exactly
    what `ManifestProvider.publishedVersion` is for - deliberately per package and per ecosystem, so
    a polyglot repository asks npm about its Node packages and crates.io about its Cargo ones. A
    `cargo` platform would depend on a `crates-io` target's client the same way, and that is the
    shape working rather than leaking.
  - **One file, two questions, and they stay together.** `npmViewPackage` answers B (is *this
    version* on the registry) for the target; `npmViewVersion` answers a step of A (borrow a version
    string to guess a tag name) for the platform. A and B are uncorrelated - see "Change and release
    detection" - but *how you ask npm anything* is one fact, and splitting it would put that fact in
    two places.
- **A barrel is a folder's front door, not a re-export habit.** `platforms/node/index.ts` and
  `publish-targets/npm/index.ts` exist because `presets/node.ts` composes a built-in through them;
  `publish-targets/docker/index.ts` because `RmanApplication` registers that target. `src/index.ts`
  reaches past all of them with deep paths on purpose - what rman *exports* is a separate decision
  from what a folder contains.
- **Trap when moving a file: a `declare module` with a relative specifier is resolved against the
  declaring file**, and it does not look like an import, so an import rewrite misses it.
  `docker-publish.service.ts` carries `declare module '../core/service.js'` for its `ServiceMap`
  entry; moving the file two levels deeper left that path pointing at nothing, and the error came
  out at the *caller* - `'dockerPublish' is not assignable to parameter of type 'keyof ServiceMap'`
  in `application.ts`, with nothing pointing at the augmentation.
- **`core/` may not statically reach a *platform*, and a preset counts because it pulls one in.**
  Not "may not reach `builtins/`" - that would be a rule the tree already breaks. What the
  existing edges look like, and why each is safe:

  | from | to | why it is fine |
  | --- | --- | --- |
  | `core/application.ts` | `publish-targets/docker/index.js` | a leaf - its service extends `Service` and nothing extends it back |
  | `core/workspace.ts`, `core/config/config-reader.ts` | `presets/index.js` | strings and `node:path`; it imports no preset |

  The thing to keep out is the shape in the `npm run smoke` section: a platform pulls in its
  services, one of those extends a core service, and the core's own module graph comes back through
  it. That killed the *built* CLI on every command (`Cannot access 'VersionPlanService' before
  initialization`) while `npm test` stayed green, because mocha resolves `src` through
  `tsconfig-test.json`'s `paths` and reaches the two in the other order. A preset is exactly that
  import, which is why `presets/index.ts` holds names and `ConfigReader` reaches the preset itself
  through the dynamic `import()` an `extends` already goes through - and why `PRESETS_DIR` lives in
  that file rather than being computed from the reader's own location.
  - **`npm run smoke` is the only thing that looks**, so run it after any move that changes who
    imports whom. `tsc` cannot see it and the suite cannot reproduce it.

## Which ecosystem a package belongs to

`Package.provider` - `'node'` for one the `node` platform read, empty when no platform claimed the
directory. Comes from `Platform.name`, and that field means the **ecosystem**, not the file
(`manifestFile` already says `package.json`; a name repeating it carried no information, which is
why it went unused until this existed).

**`Platform` and `Plugin` are two unrelated things now, not a narrow type and a broad one.** A
**platform** is one technology - `manifestProvider` is required, which is what makes it one - and it
reaches a repository through the `platforms` config key, the same route `commands` and
`publishTargets` already took. A **plugin** is a name and whatever it wants to do at a stage.

```ts
interface Plugin {
  name: string;
  afterInitApplication?(ctx: { app }): void | Promise<void>;
  afterInitRepository?(ctx: { app, repository }): void | Promise<void>;
}
```

- **`Plugin.platforms` is gone, and the measurement is why it could go without ceremony**: nothing
  in rman produced one. No built-in shipped a technology through a plugin - the `node` preset
  declares `platforms: [nodePlatform]` as a config key - and the field's only two readers were
  plumbing, one of which (`Repository.create`) duplicated the loop three lines below it. `init` had
  no production producer either; every occurrence in the tree was a test fixture.
  - It went with the wrapper it existed for: `registerPlugin` used to normalize a bare `Platform`
    into `{ name, platforms: [entry] }` so everything downstream dealt in one shape. It is two
    registries and a question with two honest answers now.
  - `loadPlugins` went at the same time - the old loading path, already uncalled, and the only thing
    left reading either member. `plugin-loader.ts` is 61 lines holding `registerPlugin`,
    `checkCustomCommand` and a key name; **its name is now wrong and it should be renamed.**
- **Two stages, named for *when* rather than for what they touch.** `initRepository` was the first
  spelling and it reads as *initialize the repository*, which is not what a plugin does there - the
  core has already done that. Both carry `afterInit` so neither has to be read twice.
  - **`afterInitRepository` exists because the workaround did not cover everybody.** The advice was
    "anything wanting the repository belongs in a command's factory, which runs once there is one" -
    true, and no help to a plugin contributing no command. `afterInitApplication` runs inside
    `Repository.create` before any package is known, so `ctx.app.repository` throws there.
  - **Two moments, and deliberately not a hook bus.** Every later point a plugin might want already
    has a mechanism it would compete with - `run.<script>.before`/`.after`, `version.<slot>`,
    `publishTargets` - and a second way in means a precedence rule between them that nothing can
    make obvious. These two are the only boundaries the core itself has. **Add a third only when
    something concrete cannot be done**, the way this one could not.
  - The `on` prefix (`onRepositoryReady`) was the alternative, and is this repository's convention
    for a hook - `getRunSteps` is deliberately *not* `on*` because it is a query. It names a state
    where `afterInit…` names the core operation you can go and read.
- **Both must be declared** through `definePlatform`/`definePlugin`, and **the mark says which** -
  one non-enumerable `Symbol.for('rman.declared')` whose *value* is `'platform' | 'plugin'`
  (`declaredKind`). No shape test could replace the mark itself: an rman **1.x plugin was
  `{ name, init }`**, and a 2.x plugin doing nothing but `afterInitApplication` is a plain object
  too.
  - **The kind is what made two of three refusals facts rather than guesses.** The mark used to be
    a bare `true`, so the only question askable was "declared at all?" and everything else got one
    message about rman 1.x plugins. Measured on two exports: a module returning a *config*
    (`{ plugins: [] }`) and one returning the string `'oops'` both came back as
    `Plugin "undefined" … was not declared` - naming a type the value is not and quoting a name it
    does not have. Now a platform found in `plugins` is told which key it belongs in, and the mirror
    holds for `platforms`.
  - **One key carrying the kind, not one key per type.** Same information, less machinery: the key
    has to be a hoisted function (below), which every extra key would repeat; `isDeclared` stays one
    lookup rather than an OR someone must remember to extend; and a third declarable is a new string
    - `publishTargets` is still checked structurally (`typeof target.name === 'string'`) and is the
    obvious next one. Nothing is built for it yet.
  - **`isPlatform` reads the mark, not `manifestProvider`.** The structural test was the only one
    available while a single type was both halves; as a question about an arbitrary import it is a
    guess that gets the common mistake backwards. The cost, stated: an *undeclared*
    platform-shaped object is no longer a platform. Everything arriving through a config must be
    declared anyway, and every `registerPlugin` caller in the tree passes a `definePlatform(...)`.
  - **The one remaining guess is which sentence to write, never what something is.** Once a value
    is unmarked the refusal is already decided; the config-shaped check (`extends`, `plugins`,
    `platforms`, `commands`, `publishTargets` as keys) only picks the more useful message. A wrong
    guess costs a vaguer error, not a plugin loading as the wrong thing - which is the line
    `plugins` draws everywhere else.
- **The brand's key cannot be a module-scope `const`.** The file layout puts privates below the
  exports and `basePlatform`'s initializer *calls* `definePlatform`, so the const sits in its own
  temporal dead zone: measured, the whole suite failed to load with `Cannot access 'DECLARED' before
  initialization`. A hoisted function resolving `Symbol.for` fixes it, and two copies of rman in one
  process then agree about the mark.
- `RmanApplication` holds both registries, and they no longer overlap: `platforms` is what every
  seam iterates, `plugins` is everything else a repository loaded.

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

[`src/core/workspace.ts`](packages/rman/src/core/classes/workspace.ts). `Workspace.Provider` is
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
- **`"[/]"` needs no selector, and that did not work.** The cascade's gate was `if (packageName)`,
  so the walk skipped every selector block including that one, and `platform` under `"[/]"` silently
  did nothing. It is `Workspace._speaksFor` now, which asks `isRoot` before it asks about a name.
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
anything reads a config that function has been called. `Resolved<T>` (beside `RmanConfig`) is that
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
`builtins/publish-targets/docker/`, `publish.npm.*` in `builtins/publish-targets/npm/`. What is left in the one interface file
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
  program, so `src/index.ts` imports `builtins/platforms/node/augmentation/rmanrc.augmentation.js` for its types
  alone - without it `clean` and `publish.npm` exist for rman and for no consumer, and no spec can
  see it (see `npm run smoke`). Every type augmentation therefore lives in
  [`packages/rman/src/builtins`](packages/rman/src/builtins/platforms/node/augmentation/rmanrc.augmentation.ts),
  beside the others rather than next to the code it describes. The *runtime* half of an augmentation
  still lives with its own subject (`augmentSystemInfo()`, `augmentManifest()`, ...).
- Measured both ways: with the core alone, `{ clean: ... }` and `{ publish: { npm } }` are
  rejected; with the plugin in the program, `rman-node`'s own `pkg.config?.clean` type-checks.
- **`packageManager` is a map keyed by platform - `packageManager: { node: pnpm }`.** The key is
  the core's and names no technology (`PackageManagers` is an empty slot, like
  `PublishTargetConfigs`); the node built-in contributes `node` and is the only reader
  (`CiService.resolvePackageManager`: `ci` asks the root, `publish` each package, `info` the root).
  - **It was a bare `packageManager: pnpm` at the root, and the user's objection was the reason it
    moved**: the package manager is a technology's question - npm/pnpm/yarn for Node, pip/poetry/uv
    for Python - so a key not saying whose it is cannot serve a polyglot repository. Subject first,
    owner second, the order `publish.npm.*` already uses; `node.packageManager` was the alternative
    and opens a `node` block everything would drift into.
  - **The bare string is refused, not read** - rman validates no config keys, so read as a map it
    would have no `node` entry and a pnpm repository would install with npm in silence. No
    repository of the organization wrote it, so the refusal shipped in a minor.
  - **An entry for a platform the repository does not load is ignored**, so one shared preset can
  name several technologies' tools.
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

## The run log: global `--json` and `--log-file`

[`core/classes/log-sink.ts`](packages/rman/src/core/classes/log-sink.ts), built per invocation in `cli.ts`'s
`interceptStatusLines` and held on `RmanApplication.logSink`. `--json` makes stdout JSON Lines
events (`start`/`output`/`end`/`summary`/`message`) and nothing else; `--log-file` writes the same
log to a file, JSON under `--json` and text otherwise.

- **Global, not per command - the user's call, and the reason is the subject.** It decides the
  *console's format*, which is a property of the invocation; a per-command `--json` would be a
  second place to state it for every command that grows a log.
- **A log is not an answer, and the six commands with their own `--json` keep theirs**
  (`list`, `version`, `publish`, `config`, `info`, `github-release`, detected as `ownsJson` from
  `'json' in meta.config` and carried through `toYargsCommand` like `printsDocument`). The shared
  release workflow `jq`s `rman publish --dry-run --json` and `rman list --json`; their stdout must
  stay one document. **The `!spec.ownsJson` guard is not reachable today** - none of those writes
  to the log - so `cli-log.spec.ts` pins the contract and its control stays green (measured).
- **Only `RunService.schedule` writes events**, so `run`/`build`/`test` and any `forEachPackage`
  command. Everything else given either flag warns on stderr (`warnUnhonoured`), detected from
  `sink.used` rather than listed. Warn, not refuse: a log option must not be the reason a release
  step fails. Not under `--config`, which runs nothing on purpose.
- **Under `--json` there is no screen reporter at all** (`RunService.reportersFor`), so nothing
  but the sink's events reaches stdout. The panel is constructed disabled, and the recap is counted
  once with `panel.tally()` and then reported - a screen reporter prints it from that same tally,
  so the summary event and the prose recap cannot disagree.

### Reporters: an event is produced once, and rendered by each

[`core/classes/log-sink.ts`](packages/rman/src/core/classes/log-sink.ts) (`Reporter`, `LogSink`),
[`core/classes/run-reporters.ts`](packages/rman/src/core/classes/run-reporters.ts) (`PlainReporter`,
`PanelReporter`). `RunService.schedule` builds `start`/`output`/`end`/`summary` events and hands each
to every reporter the run has: the screen (the panel's rows, or plain lines, or nothing under
`--json`) and `LogSink` (`--json` stdout and `--log-file`).

- **It replaced four branches at the place a line was produced** - panel row, plain screen,
  `--json`, file - and the package prefix is what showed the cost: one more thing to do with a line
  meant touching each branch. A new destination is a reporter now, never another branch.
- **winston and consola were weighed and not taken**, on the user's question. Both offer the shape;
  both would mean translating these typed events into a log record and back, while the set of
  destinations is closed. winston also writes files asynchronously, which loses the last lines of an
  interrupted run - the ones that say why. pino writes from a worker thread, which loses ordering.
  The panel and spinner are not logs in any of them, so that reporter would be ours either way.
- **A plain run leads every line with its package** (`pkg ┆ line`). Packages run at once and a
  step's status line comes only after its output, so unlabelled, an error read as the package
  printed just above it - reported on opra, `@opra/api-ui`'s TS2307 under `@opra/openapi ┆ after
  success`. The log's `output` event carries the package as a field instead.
- **A reporter writes a step's lines to the stream, never through `console`**: a function step's
  `console` is captured and arrives as `output` events synchronously, inside that step's async
  context, so a `console.log` from the reporter would be captured again. Step lines and the recap are
  written outside any step and keep using `console`.
- **`childEnv` is the reporter's to say**: the plain screen asks for `FORCE_COLOR` where our stdout
  is a terminal; the panel does not, since a row's width is measured and escape codes would count as
  text.
- **A nested `rman` in a step is not told**, so its own status line and recap arrive as `output`
  events. Measured in opra (`before: rman check`): correct, and visible in the log.
- **Measured in opra under `script`**: 444 lines, every one parses, no escape codes, and the file is
  byte-identical to stdout.

## The status line around every command

[`utils/status-region.ts`](packages/rman/src/utils/status-region.ts), installed by
`cli.ts`'s `interceptStatusLines`. A spinner, the command's name, the repository and a clock
counting up while it runs; a `✔`/`✖` line with the elapsed time when it ends.

- **The complaint it answers is "did it even run".** `rman lint` on a clean repository is silent for
  several seconds - eslint says nothing when it has nothing to say - and a static start line answers
  "did it start" without answering "is it still going".
- **One interception point, not a line per command**, which is the rule `--config` already follows:
  every command reaches yargs through `program.command`, so wrapping that one method is what makes
  it universal. A line each command remembers to write is the same failure one step removed.
- **`printsDocument` is the opt-out, declared on the command** - `config`, `list`, `info`, `diff`,
  `changelog`. Their stdout *is* the answer, and for `config` a line above it makes the YAML
  unloadable. Declared rather than listed in `cli.ts`, which is the rule `builtInNames` follows: a
  central list is a second place to state a fact the command owns, and it could not reach a
  *contributed* command at all.
  - **The field has to be carried through `toYargsCommand`**, beside `configKeys`. Measured by
    leaving it out: `config` declared `printsDocument: true` and still printed a status line above
    its own document, because `cli.ts` reads the *registration* and the flag never got there. Pinned
    by the one spec that turns red when that line is reverted.
- **`--json` and `--config` are checked, not declared**: any command may grow a `--json`, and a
  consumer doing `rman version --json | jq` must never receive prose.
- **On stderr, and `LiveRegion` took a `stream` parameter for it.** A command's answer goes to
  stdout, so `rman changelog > NOTES.md` has to leave the notes alone in the file - cursor-movement
  codes in there are worse than noise. `ProgressPanel`'s region keeps stdout, unchanged.
- **The command's own writes are moved above the spinner** (`StatusRegion.guardWrites`): while the
  line is live, every `process.stdout`/`process.stderr` write erases it, writes, and draws it again
  below. Measured with `script`: `rman deps` printed its plan with `console.log`, the final erase
  moved up one row from *below* the plan, and its last line - the one dependency it was reporting -
  was gone, leaving a "not updated" heading with nothing under it; `version --show` lost "Nothing to
  version." the same way. A rule that every command route its output through `passThrough` is one
  each new command would have to remember, so the region does it.
  - **Left alone while suspended** - the panel that took over writes to stdout itself - and **a
    write ending mid-line holds the next frame back**, or the frame's `\r` + erase would wipe it.
  - **A child process is not covered**, because its writes never pass through this process's
    streams. That is what the next bullet is about.
- **A live region forces `runBin` to pipe**, and that is not a preference. The region redraws by
  moving the cursor up N rows; a child writing straight to the terminal scrolls the screen, so the
  next redraw erases what the child just printed. So output goes through `passThrough` - erase,
  write, redraw below - which is the arrangement `RunService` already makes for the progress panel.
  `FORCE_COLOR=1` goes with it, or eslint sees a pipe and drops the colour it had.
  - **It is added *onto* a base environment and must never be written as one.** `BinPath.env`'s
    `env` option is the environment to *derive from* - it stands in for `process.env` rather than
    extending it - so `{ FORCE_COLOR: '1', ...options.env }` handed over with no `options.env` left
    the child holding that single variable and a PATH of nothing but the contributed directories.
    Shipped in 2.3.0 and it broke every `runBin` call made while a region is live, which is all of
    them. Measured on `panates/sqb`: `rman test` still *found* npm - the node walk ends at the
    running interpreter's own directory, where npm sits - and npm then died `spawn sh ENOENT`,
    because `/bin` was not on the PATH it was given.
  - **Why it took a repository to find it.** A binary run straight out of `node_modules/.bin`
    survives a PATH like that: its `#!/usr/bin/env node` shebang is resolved by absolute path and
    `node` is the one entry the walk does append. eslint, prettier and tsc all pass. What fails is a
    child that spawns a *shell* - `npm run` being the one every repository types - so the preset's
    `lint`, `check` and `format` were green while `test` was not. **A spec covering a `runBin` env
    has to run something that spawns `sh` itself**, which is what `run-bin.spec.ts` does.
- **Only one region draws at a time, and `suspend`/`resume` is what enforces it.** `LiveRegion`'s
  doc has claimed this since it grew a `stream` parameter and nothing held it: every command gets a
  status region, and `run`/`build`/`exec`/`clean`/`ci`/`changelog` additionally start a
  `ProgressPanel`, so two regions redrew on one terminal. Each moves the cursor up by **its own**
  line count, so interleaved every redraw lands on the other's rows - on screen the bottom lines
  swap places several times a second. Reported on `rman ci`; `rman build` had it too, by a second
  route (`runBin`'s pass-through went to the status region while the panel was drawing).
  - `ProgressPanel.start(statusRegion)` takes the terminal and `stop()` hands it back. **Every
    panel site passes `app.statusRegion`** - five of them, and a new one that forgets reintroduces
    the flicker with nothing reporting it.
  - **A disabled panel hands the terminal to nobody, and the status line is silenced anyway.** This
    said the opposite - "a disabled panel owns nothing, and suspending the status line would remove
    the one thing such a run still shows" - and that held only while children inherited the
    terminal. With no panel, `run` now pipes every child and prints its lines itself (below), and a
    spinner redrawing in place moves the cursor up over whatever was printed since. Under
    `--no-progress` the CLI never draws the line at all; `schedule` silences a live one for the run
    in the other cases (config `progress: false`, or stdout redirected while stderr is a TTY).

- **With no panel, a child runs without a terminal** (`pipe` + `onLine`, printed by `PlainReporter`
  to the stream it came from, led by its package). A child that finds a TTY draws its own live output, and a build is mostly
  other CLIs - the shared preset's `run.build` is `rman check`, `rman lint`, `rman clean`, `tsc`.
  Reported as `rman build --no-progress` printing progress and losing its logs; under a real
  terminal one short build had **149 spinner frames and 154 cursor-ups, 0 and 0 after**.
  - **No TTY rather than telling children about `--no-progress`.** An environment variable was
    built first and dropped: it reaches nested rman and nothing else, while `npm`, a test runner's
    reporter or `docker build` would go on drawing. No TTY is the convention every well-behaved CLI
    already honours - nested rman included, whose panel reads `process.stdout.isTTY`.
  - **`FORCE_COLOR` brings the colour back and nothing else** (`colorsPrintedOutput`: our stdout is
    a terminal, `NO_COLOR` unset). Tools gate their live output on `isTTY`, which stays false.
  - **`runBin`'s `onLine` buffers per stream now**, as `exec`'s always did. It split each `data`
    chunk on its own, so a line arriving in two pieces became two lines - harmless while the only
    reader was a panel row's last line, wrong once every line is printed.
  - The cost, stated: a child cannot prompt. Nothing in a run step should.
  - **Measuring it needs a pseudo-terminal** (`script -q out.txt <cmd>` on macOS) - without one
    nothing draws either way. And count escape codes with `grep -E`: BSD grep's basic regex has no
    `\|`, and a `\|` pattern reported zero colour codes in output holding 1800.
  - **`live` stays `true` while suspended, deliberately.** It answers "does something own this
    terminal", which is what `runBin` reads to decide to pipe a child rather than let it scroll the
    screen; the answer to *which* region is `takeover`, which `passThrough` forwards to. Making
    `live` false instead would have let every `runBin` child inherit the terminal and scroll over
    the panel - the failure the piping exists to prevent.
  - **The panel's header carries the suspended line's content** (`ProgressPanel.detail`, set to
    `repository.name` at all five sites). Suppressing the status line without moving its content
    took the command and the repository off the screen, which was reported immediately. The badge
    already names the command, so what moved is the repository - **at the right end of the header,
    not between the badge and the bar**: there it would push every column right by the length of a
    repository name, so the bar, the counts and the clock would sit somewhere different in each
    repository. The tail is empty space in every terminal the panel fits in.
  - **`TerminalRegion` is `passThrough` and nothing else.** `StatusRegion.live` and
    `ProgressPanel.enabled` are the same question under two names, and `ProgressPanel.live` is the
    `LiveRegion` itself - putting `live` in the contract would force a rename for no gain.
- **The region lives on `RmanApplication.statusRegion`**, not in a module-level singleton. `runBin`
  and `exec` are handed an `app` already - the same seam `BinPath` uses - so nothing reaches for
  ambient state and one spec's application cannot affect another's. That is what the removed root
  hooks were about.
- **The spinner's interval is `unref`'d**, or a command that finishes its work waits out the frame
  before the process can exit.
- **Not drawn when stderr is not a TTY**, where the escape codes mean nothing - but the result line
  still prints, which is the half a CI log wants. `cli.spec.ts` therefore sees **one** line, not
  two; the live half is `status-region.spec.ts`, which builds the region with `enabled` forced on.

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
- **The contribution keys are left out** - `plugins`, `platforms`, `commands`, `publishTargets`
  (`CODE_SUBTREES`), through `withoutContributions` in
  [`utils/printable-config.ts`](packages/rman/src/utils/printable-config.ts). They are code, and
  this command answers what a repository is *configured* to do. It stopped being a detail the day
  presets went under every root: measured on this repository, `rman config` printed the npm target's
  entire option table, a platform's manifest provider and `commands: ['[Function]', '[Function]']`
  above the two keys the `.rmanrc` actually sets - forty lines of metadata over three of config.
  - **Silently, and that was argued the other way first.** A note announcing the omission looked
    like the sibling of the deferred-paths one below, and is not: that note explains a *visible*
    oddity, this announced an absence the reader was not looking for. What settled it was measuring
    the condition meant to make it rare - presets go under every root, so every config carries all
    four and the line printed **every time**, which makes it a banner rather than a report. At this
    repository's root it was one line of three. A reader asking which technologies are loaded is
    asking `rman info`; one asking whether their command registered is asking `rman --help`.
  - **`--config` does the same**, in its "in full" branch only - its narrowed branch already picks
    the keys the command reads. The two printers cannot disagree about what the config is.
  - **Distinct from `printableConfig`, which makes a value serializable rather than deciding what is
    worth showing.** A step written as a function still prints as `[Function: copyDocs]`; that one
    *is* a setting. Both live in the same module because both callers are printers.
  - **It imports `CODE_SUBTREES` rather than listing those four names again.** Two lists that can
    disagree is the failure this tree had already: `presetNames()` held a hardcoded `['node']`
    beside a resolver that looked somewhere else, and the error message named the preset it had just
    failed to find.
- **The first line is the config file the directory declares** (`ConfigReader.findConfigSource`,
  public for this caller), because the reader's next question is which file to open. Omitted where
  the directory declares none - naming one that is not there sends them to create a file when the
  answer is a level above.
  - **It is the package's *own* file and the printed config is more than it**: the directory chain
    above, every `extends` base and each `"[selector]"` block are all in there. The per-key answer
    is `ORIGINS`, which a failing expression's message already names; this line is a starting point,
    not the provenance.
  - **Find the header, don't index it.** Three cases asserted `lines[0]` and all three broke on a
    change that was about something else; `config.command.spec.ts` has a `headerOf(lines)` helper.
- **Syntax colour, on a terminal only** ([`utils/color-yaml.ts`](packages/rman/src/utils/color-yaml.ts),
  shared with `--config`). Key in cyan, `${{ }}` in magenta, literals in yellow, list markers and
  `[Function]` in grey - and a plain string value left alone, because it is the content and
  colouring it competes with the key for attention.
  - **`${{ }}` in magenta earns its place**: `version.before`/`.exec`/`.after` are printed raw, so
    an unresolved expression among resolved values is *correct* here, and the colour is what keeps
    it from reading as interpolation being broken.
  - **A line-based highlighter, with one piece of state: an open block scalar.** `lineWidth: 100`
    makes js-yaml fold a long string into `key: >-` plus deeper-indented prose, and a continuation
    line holding `(default: ...)` would otherwise have half a sentence coloured as a key, with a
    `#` in one read as a comment. Everything else is per line; a value's own colon is not a problem
    because js-yaml quotes any scalar holding one and the key pattern stops at the first.
- Distinct from [`rman config`](docs/cli/config.md), and keep them distinct: that prints one
  package's whole config with no command involved; this answers "what would *this command* do".

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
    purpose - and `version` deliberately honours *neither* of those (a package can be meaningfully
    versioned without ever being published). A blanket `skip` replacing them would flatten that.
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

## Change and release detection

Three separate questions in rman look like "what changed". They are answered from different
sources and are **not** interchangeable. Before touching a command, establish which one it answers.

| | Question | Criterion | Commands |
| --- | --- | --- | --- |
| **A** | Which packages have **changed** since their last release? | the package's last release tag + commits after it whose files fall under that package | `version` (`--show`/`--json`), `changelog` (+ `github-release`, for release notes only) |
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

### `changelog.tagPattern` has no fixed default - it is derived from the group count

`v*` with **one** version line, `{name}@*` with several (`resolvePattern` in
`change-hash.service.ts`). The same structural rule `usesCalendarVersion` already applies to the
root's scheme, and for the same reason: reading the versions instead would move the answer under
the repository's feet.

- **A repo-wide pattern is resolved with `git describe --match`**, i.e. the nearest tag HEAD
  descends from *whichever package it belongs to* - correct while everything releases together and
  **silently wrong** the moment it does not. Measured on a two-line repository: releasing `pkg-a`
  put `v1.1.0` on HEAD, and `pkg-b` - holding a committed, unreleased `fix:` of its own behind that
  tag - reported `no-change` and shipped nothing. Under `{name}@*` the same repo answers
  `bump 1.0.0 -> 1.0.1, changed since pkg-b@1.0.0`. This is the sibling of the trap already
  recorded for `version.releaseTagPattern`; it was only ever fixed for the *release* tag.
- **The bridge: a derived `{name}` pattern falls back to the repo-wide `v*` tag while a package has
  no tag of its own.** That is the boundary that *was* correct - before the split every package
  genuinely shared it - so the first run after grouping reads the same commits as yesterday and
  writes a `{name}` tag every later run finds directly. Without it the transition is destructive:
  measured on a four-package repository, every package came back `unreleased commits` and three
  jumped a major on a `feat!:` buried in the full history.
- **Only for a *derived* pattern**, never over a repository's own declaration - borrowing a `v*`
  tag it never asked about could hand a package a boundary belonging to something else, and reading
  too little is the failure that ships nothing and says nothing. `resolvePattern` returns
  `{ pattern, derived }` for exactly this; `tagPattern` exposes only the pattern.
- **The root keeps `v*`.** It is never a group member, so the count says nothing about it, and the
  one caller (`github-release`'s `releaseTagGlob`) asks only when the root is *not* on a calendar
  version - the single-line case, where `v*` is the answer anyway.
- A group's members each get **their own tag at the group's shared version** - `applyPlan` expands
  per entry into a `Set`, so `v*` dedups to one tag and `{name}@*` yields one per package. Measured:
  a two-member group produced `pkg-a@1.0.2, pkg-b@1.0.2`, and each found its own on the next run.
- **`groupKeyOf` is in [`utils/version-group.ts`](packages/rman/src/utils/version-group.ts) and
  `VersionPlanService.resolveGroupKey` delegates to it.** Two copies of those five lines would be
  easy to write and impossible to keep in step, and the failure is silent: a boundary computed under
  one answer, a tag written under the other. `resolveGroupKey` stays `protected` so a planner can
  still override the batching; what it cannot do is leave the tag pattern behind.
- **`change-hash.service.spec.ts` cannot see any of this** - it builds a bare
  `new Package(dir, createApp())`, which belongs to no repository, so `versionLineCount` answers 1
  and every pattern is `v*`. The whole file stayed green when the default changed. The specs that
  do see it are in `version.command.spec.ts` ("which pattern names a release tag"), end to end on a
  real repository, reading the tags a run actually creates.

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

**`ChangelogService` matches a commit against where each package was *then***
(`ChangelogService.packageHomes`, `homesAt`, `GitHelper.moveHistory`). Measured on
`panates/syncbridge`: one commit moved every package under `packages/<scope>/`, so every earlier
commit touched paths no package sits at any more and `--write` under `groupBy: package` wrote the
root's file alone - while git held 259 commits of hl7's and 283 of iomt's.

- **Read from the manifest's moves**, one `git log --follow` per package, run at once (40ms each
  there, 120ms on `panates/sqb`).
- **`--follow` is not trusted as it is, and both refusals were measured on the same repository.** A
  **copy** (`C`) stops the walk: hl7's manifest came back as `C054` of another package's that was
  never deleted. And a **rename** counts only where more than half of the old directory's files
  went too (`GitHelper.movedShare`): `packages/builtins` was split ten ways and git paired its
  manifest with serialport's at `R052` - for 3 of 43 files. git pairs the old manifest with *every*
  new one, so the piece holding most of the files is the one that gets the history, and where none
  does it stays the root's.
- **A fixture for this needs a long manifest.** A one-line `{ name, version }` changes too much with
  its name and git reads it as a new file (`A`), so neither trap is set and a spec about it passes
  with the guard removed - measured, which is why the specs write a multi-line one.
- **`VersionService.belongsToPkg` does not do this yet.** It asks only from the last release, so it
  matters for the first release after a move, and there the move commit itself touches every moved
  package.

### `changed` was removed - `version --json` is the machine-readable plan

**Don't re-add it.** It answered the same question as `version --show` from the same `getPlan`, and
what it added was a filter: `status === 'bump'`. Two things fall through that filter in opposite
directions, and measured together on a dirty tree they produced the worst possible answer - an array
holding exactly **one** name, the repository **root** (`buildRootEntry` reports `'bump'`, and the
fact that it is informational lived only in `reason`), with `pkg-a`, the package that had actually
changed, missing because a package with uncommitted changes is `'error'`. A CI script reading that
saw one thing to release and it was the one thing that must never be published.

- **`--json` prints the plan unfiltered**, every entry carrying its own `status`, with `isRoot`
  stated rather than left to be inferred from `group === 'root'`. A consumer selects what it wants
  and can see what it is leaving out. Printed before `printPlan` and before the dirty-package
  throw, so stdout holds one JSON document and nothing else.
- **It resolves even with a dirty package**, where `--show` exits 1: a person needs stopping, a
  pipeline needs the rows that explain why, and overloading the exit code would make it bail before
  reading them.
- **`list --changed` is not a replacement and never was** - it is question **C** (working tree +
  `git cherry`), so it empties out the moment you push. Measured on one repository with everything
  pushed and clean: `list --changed` found 0 packages while `version --show` reported one waiting to
  be released. The two cannot be merged; that was checked before `changed` was removed.
  - Its own `--changed` help text said "since the last **publish**" in five places (the CLI
    describe, `run`'s, `list`'s doc, `test`'s, the README) while the code reads `git cherry`, i.e.
    not **pushed**. That wording is most of why `list --changed` looked like it could stand in for a
    release question. Fixed; keep it fixed.
- Boundaries still come from the planner's `detectBoundary`. **Nothing here asks a registry whether
  a version is published** - the one registry call in that path borrows a version string to guess a
  tag name for a package that has no tag at all, and is used only if that tag exists in git. That is
  not B.
- **Empty output does not mean "nothing to publish"** - it means "no package needs a new version".
  Don't gate a CI release pipeline on it; that decision belongs to B (`publish`).

### `version`

- **Question A** (`VersionPlanService.getPlanner().getPlan`); `VersionService.applyPlan` does the
  writes, and `--show`/`--json` stop before them.
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
    (how far into its group a bump reaches). **`cascade` is a statement about what a *published
    artifact* still needs, not about versions** - an ecosystem pinning exact versions must release
    every dependent for a patch, and one resolving from source may need no release at all.
    - **npm's table is `dependents` / `dependents` / `group` by patch / minor / major, and `patch`
      answered `'changed'` until 2.4.** The range argument for the old answer is sound and too
      narrow: `^1.2.0` does resolve to `1.2.1`, so a consumer receives a fix with nothing
      downstream republished - but a dependent's *artifact* was built against the old code, and
      anything that bundles or vendors it keeps shipping the pre-fix version until it is released
      again, which under that default never happened. Widening prefers visible churn over an
      invisible miss, which is the asymmetry `cascadeFor` already resolves by taking the widest.
    - **The cost, stated rather than hidden**: `patch` and `minor` are now the same answer, so the
      table no longer distinguishes them and a future reason to treat a patch differently has
      nowhere to live. They are kept as two entries for that reason. And `'changed'` is now
      unreachable under npm, which makes `version.cascade: changed` a no-op in a Node repository -
      still meaningful as "no floor of my own", since it is a floor and never a ceiling.
    Groups, the commit→size reading, the cascade mechanics and the root's release identity stay in
    the core: none of them is a technology's business, and moving them out would have every plugin
    copy them.
  - **`.rmanrc "version.cascade"` is the repository's floor under that answer, and it exists because
    `cascade` was carrying two different questions.** The ecosystem's half is right and stays: a
    caret range already carries a patch to a dependent, so npm answers `changed`. What it cannot
    answer is whether a repository wants **one number across its whole product**, which is a release
    identity decision and had nowhere to be stated - `cascade` is a `protected abstract` method, so
    no config could reach it.
    - **Measured on `panates/sqb`**: 17 packages, `group: true`, every one published at 6.0.10 ever
      since it moved off rman 1.x's `version.unified: true` - and a `fix:` in two of them planned
      `6.0.10 -> 6.0.11` for those two and `no-change` for the other fifteen. Correct on ranges (all
      39 internal edges are caret peers, so the fix reaches dependents with no republish) and the
      wrong answer for that repository: the divergence is **permanent**, since a group's next
      baseline is `highestVersion(members)`.
    - **This is what `group`'s own documentation promised.** "`true` = one repo-wide version line"
      reads as lockstep, and was lockstep in 1.x; the cascade table quietly made it true of majors
      only. Two rules in this file contradicted each other and the user hit the seam.
    - **A floor, never a ceiling** (`cascadeFor` adds it to the technologies' answers and takes the
      widest). A repository may ask for a *wider* release than npm requires and cannot ask for a
      narrower one, because the two mistakes are not symmetric - too wide republishes a package that
      did not need it, too narrow leaves a dependent's published range floor wrong, which is a
      broken install. So `cascade: changed` still reaches in-group dependents on a **patch** and the
      whole group on a **major**; it means "no floor of my own", never "at most the changed
      packages". With npm's patch answer now `dependents`, `changed` narrows nothing at all there.
    - **`group` is the only value that changes anything in a Node repository**, which is worth
      knowing before reaching for the other two: `dependents` equals the default, `changed` is a
      no-op, and `group` is lockstep. The three are kept because the key belongs to the core and an
      ecosystem answering `'changed'` would honour all of them.
    - **It is not a safety valve.** A change that can break a dependent is a `feat:` or a `feat!:`;
      renumbering the dependent does not make a behavioural break safe. The lever for that is the
      bump size, which comes from the commit message. Don't answer "a patch might break my
      dependents" with this key.
    - **An explicit `rman version <v>` never consults it**, and `computeGroupPlan`'s doc used to say
      the opposite ("reaches the changed members alone"). `getPlan` marks *every* eligible package
      changed with reason `explicit version <v>` and a group's members come from `eligible`, so all
      of them move already. A declared cascade read on that path was written, measured unreachable
      and removed; the spec that asserted the narrow reading is the only reason it was caught.
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
    - **`{ file, optional: true }` waives that refusal, and exists because the entry and the
      expectation can have different authors.** "Somebody asked and did not get it" is the whole
      justification, and somebody is not always the repository: a *shared preset* naming
      `src/constants.ts` for every package of a technology means "stamp it where there is one" and
      cannot know which of forty repositories keeps a constant there. Measured on
      `panates/postgrejs`, which extends `@panates/rman-preset`: the file exists, has never held a
      version constant (`git log -S"export const version" -- src/` is empty), and `rman version`
      refused the release over a line nobody in that repository wrote.
    - **A bare string still throws**, and that asymmetry is the feature - it is what catches a
      typo'd path or a renamed identifier. The `file.exists()` / `file.resolve()` split again: the
      optional form and the throwing form, chosen by the caller.
    - The two specs are each other's control: same file, same missing constant, opposite outcome.
      A third pins that `optional` waives the *refusal* and not the *work* - a file that does hold a
      version is still stamped, or "skip it" and "ignore the entry" would be indistinguishable.
  - **`undefined` from a stamper means "nothing matched", never "no change needed".** Conflating
    them made that error message a liar - a file already sitting at the target version is not a file
    holding no version.
- Also decides the **repository's own** release identity (the monorepo root's version) and, on a
  calendar version, creates the repository release tag alongside the per-group ones - see
  "Release identity" below.

### `changelog`

- **Question A.** The boundary is auto-detected per package via `detectChangeHash` by default;
  `--from <hash>` bypasses that entirely and applies identically to every package.
- **`--write` does not use that boundary - it uses the file's own** (`resolveBoundary` in
  `changelog.service.ts`). An append has to start where the last one stopped, and a release *tag*
  does not move between two writes: measured, a second `--write` re-listed every commit since the
  tag on top of the entry already holding them, so one commit appeared twice under two headings
  carrying the same version number. Three cases, in order: **a marker** in the file -> that commit;
  **no file at all** -> the whole history (measured, the tag boundary documented only what came
  *after* the last tag and the commits before it were never written anywhere); **a file with no
  marker** -> ordinary detection, where `catchUpFile` still earns its place by widening backwards.
  - The marker is `<!-- rman:documented-up-to <sha> -->`, one per file, **rewritten** on each write.
    HEAD, resolved once per run rather than per package, so a commit made mid-run cannot straddle
    two entries.
  - **Not parsed back out of the entry headings**: `changelog.template` is the repository's, so the
    heading is a shape rman did not choose. **Not the file's last-modifying commit** either - that
    is `catchUpFile`, and as a *boundary* it silently drops every commit between an unrelated edit
    (a typo, a hand-written note) and the last real write. Widening-only is safe; narrowing is not.
  - **A print run ignores all of it**, deliberately: nothing is being appended, so the question is
    "the notes for this release", not "what is still undocumented". `ChangelogService.Options.write`
    exists for exactly that distinction and is set by `generateToFile`, never by a caller.
- **`{{date}}` is the tag's date, not `new Date()`** (`resolveHeading`). The version half of a
  heading is read back from the package's latest tag, so taking the date from the clock made the two
  halves describe different releases - measured, `## @panates/eslint-config v2.1.6 (2026-09-25)` for
  a v2.1.6 tagged days earlier - and made a regenerated file differ from itself every day. The
  **committer** date, since a rebased release commit was authored before it shipped. Today's date
  stays for `--release-version`, which is the case it was written for: that caller is describing a
  release with no tag to read.
- **The range is cut at every release tag inside it** (`splitByRelease`), one entry per release,
  newest first. An ordinary run has no tag inside the range - the boundary *is* the last release -
  so this only shows on a backfill, which is exactly where it matters: measured, a first `--write`
  on a repository with twelve releases rendered every commit in all of them under one `v2.1.6`
  heading.
  - **The drop of release markers moved from the fetch to the segment**, and that is load-bearing:
    `version` tags the `chore(release): v1.0.0` commit, which `dropVersionBumps` removes - so
    dropping first left every tag pointing at a sha no longer in the list and every cut missed.
    The tagged commit closes its segment and is dropped from it.
  - **Which tags count is `ChangeHashService.releaseTagPatterns`**, shared with `findLatestTag` so
    the boundary and the cuts cannot disagree. They did, for one commit: the boundary bridged to the
    shared `v*` while the split still looked only for `{name}@*`, which a repository mid-transition
    has none of - so the backfill found nothing to cut at.
- **An entry's heading is its tag** (`{{title}}`, `resolveHeading`). It was `{{package}}
  {{version}}`, assembled from a label and a version read off the latest tag - which states
  something untrue wherever a tag covers more than one package: the repository root was headed
  `## panates-javascript repository 2.1.6`, and the root package there is `panates-style` at
  `0.0.5`. An untagged segment is `Unreleased — <label>`, dated today.
  - **The label has to stay in it.** `Unreleased` alone was tried and 22 specs caught the loss:
    `rman changelog` prints every package to one stream, so consecutive `## Unreleased` blocks say
    nothing about which package each belongs to.
  - **The date follows the heading**: a tagged segment takes the tag's committer date, an untagged
    one takes today. Reading the last tag's date for unreleased commits headed them with the day of
    the release before them.
  - `{{package}}`, `{{version}}` and `{{tag}}` stay bound for a repository's own template - only the
    default changed. **Don't pin a heading's layout in a spec**: `toContain('## pkg-a 1.0.0')` did,
    in twenty-two places, so a presentation change turned all of them red for no defect. Both spec
    files have a `headingFor(name)` regex helper for this.
- **`changelog.titles` maps a commit type to its section heading** (`resolveTitles`/`groupCommits`),
  and with it the section order. It was three hardcoded strings, so `feat` and `fix` were the only
  two types rman could name and everything else - `dev`, `docs`, `perf` - shared one heap.
  - **rman now ships a heading for every *standard* Conventional Commits type**, in this order:
    `feat` ✨ Features, `fix` 🐛 Bug Fixes, `perf` ⚡ Performance and Optimizations, `revert`
    ⏪ Reverts, `refactor` 🔧 Refactoring, `docs` 📚 Documentation, `test` 🧪 Tests, `build`
    📦 Build System, `ci` 🤖 Continuous Integration, `chore` 🧹 Chores, `style` 🎨 Code Style, and
    `*` 💬 General Changes. Measured across four of this organization's repositories, the old
    catch-all held 194 `chore`, 86 `docs`, 68 `refactor`, 29 `test`, 27 `ci` and 24 `perf` - more
    commits than `feat` and `fix` together, under a heading saying only "not one of those two".
    - **The set stops at the standard types.** `dev` (32 across the same four) and `bench` (9) are
      this organization's inventions; a repository names those in its own `titles`, or a shared
      preset does it once. Shipping a heading for a type no convention defines is guessing on every
      other user's behalf.
    - **They add sections and hide nothing** - the one place this parts from conventional-changelog,
      whose default preset silently drops `chore`, `ci`, `build`, `style` and `test`. A changelog
      quietly missing a third of the history is the worse failure; `ignoreTypes` stays the only key
      that drops a type.
    - **Every emoji is checked for U+FE0F and none carries it**, pinned by a spec that walks the
      rendered headings. A variation selector survives github-slugger, so `### ♻️ Refactoring` gets
      an anchor nobody types and every link to it lands at the page top - the `⬆️` trap again. It is
      why refactor is `🔧` (free since the catch-all became `💬`) and ci is `🤖`.
    - **Adding defaults breaks specs that assert a heading list**, and two of them silently: a case
      reading `sortTitles: ['docs', ...]` to mean "a type with no heading" tested the opposite once
      `docs` had one, and a case asserting the catch-all "renders last" had nothing to assert once
      `chore` took its only occupant. `commitsFixture` carries a `wip:` commit for that second one.
  - **Merged over the defaults per key, not replacing them** - the `vars` rule rather than a new
    exception, and what the shape asks for: naming `dev` must not silently cost a repository its
    `feat` and `fix`. Renaming a default keeps its position. The cost: a default section cannot be
    *removed* by omission; `ignoreTypes` is the key that drops a type, and it still wins.
  - **`changelog.sortTitles` orders the sections; `titles` only words them.** Two keys because two
    decisions: order used to fall out of the order `titles` was written in, which quietly meant
    renaming `feat` was also re-deciding where it sits. A sort, not a filter - an unlisted type
    keeps its place after the listed ones.
    - **Only a type with a heading of its own takes a position.** A type nobody named resolves to
      the catch-all, so ordering by it drags the catch-all to that position: measured,
      `sortTitles: ['docs', 'fix', 'feat']` with no `docs` heading put "General Changes" first and
      swallowed everything after it. (`docs` is a default heading now, so the spec for this uses
      `dev` - a type rman does not ship one for.)
  - **`'*'` is the catch-all and is always rendered last**, whatever position it was declared in - a
    catch-all in the middle silently swallows the sections after it.
  - **The type prefix is stripped in every section now.** It was `push(line)` for `feat`/`fix` and
    `push(subject)` for the rest, so General Changes read `- chore: bump deps` while Features read
    `- a new capability`. With every type able to carry a heading that asymmetry has no defence.
    A non-Conventional subject has no prefix to strip and is kept whole.
  - **`Entry.features/fixes/other` and `{{features}}`/`{{fixes}}`/`{{other}}` are derived**
    (`legacyBuckets`), so they keep meaning what they meant - whatever `feat` and `fix` are listed
    under, everything else together. `Entry.sections` is the shape that does not lose a repository's
    own headings; prefer it.
- **A message repeated inside one section is written once** (`groupCommits`). Measured on
  `panates/postgrejs`, whose `v2.22.1` entry read `Updated config` five times - five commits really
  worded the same, so it is not rman inventing them, and the repetition states nothing the first
  line did not.
  - **Per section, not per entry**: `feat: x` and `fix: x` are different claims under different
    headings, and collapsing those loses a fact rather than a repetition.
  - **Keyed on the message, before the sha is appended**, which is the whole subtlety - with the sha
    on the line every duplicate is textually unique and the check would never fire. The survivor
    keeps the *first* commit's sha, and `listCommits` returns oldest-first, so that is the earliest
    of the run. The spec asserts the dedup and the sha together, which is the only combination that
    can catch the wrong order.
- **Each bullet ends with its commit's short sha** - `changelog.commitHash` / `--no-commit-hash`,
  default `true`.
  - **Plain, never a Markdown link.** GitHub autolinks an abbreviated sha wherever it renders
    Markdown inside the repository, so `(a1b2c3d)` is a link on the page and still readable in a
    terminal; a hand-built URL would need to know the forge, which nothing here does.
  - **No `default: true` on the yargs option**, the same trap `unreleased` avoids: declared there, an
    omitted flag arrives as `true` rather than `undefined`, so the flag would beat
    `.rmanrc changelog.commitHash` on every run and the key could never turn it off. The default
    lives in `withCommitHash`.
  - **A spec comparing a section's lines exactly cannot name a fixture's shas**, which are new every
    run - `changelog.service.spec.ts` has a `withoutSha()` helper for that, rather than loosening
    those assertions to `toContain`, which would stop them noticing an extra line.
- **`changelog.unreleased` defaults to `true`, so the flag that acts is `--no-unreleased`** -
  the one place this deliberately parts from `auto-changelog`, which defaults its equivalent off.
  That tool documents a finished history; `rman changelog` exists to answer what is *not* released
  yet, down to the message it prints when there is none. Off by default would make the common case
  need a flag.
  - **`options.version` always wins over it** (`resolveUnreleased`). Naming the version means the
    caller is describing the release it is about to cut - `version --changelog` writes that entry
    *before* it commits and tags. Without the guard, a repository setting `unreleased: false` would
    find every release silently documenting nothing; the control for it turns that spec red.
- **`changelog.startingAt` puts a floor under how far back a backfill goes** (`resolveStartingPoint`)
  - one key taking a version/tag, a `YYYY-MM-DD` date, or a commit, where `auto-changelog` has two
  options and no commit form. Decided in that order, because the shapes overlap: date shape first,
  then anything the scheme reads as a version (so `2.0.0`, `v2.0.0` and `@scope/pkg@2.0.0` all
  work), then anything git resolves. A tag whose name is also hex wins over the sha reading.
  - **Inclusive**, all three, matching `auto-changelog`.
  - **The unreleased segment is never filtered.** It is happening now, so no past floor is above it,
    and dropping it hides what most runs are asking about. A tag carrying no readable version is
    kept for the same reason - a floor leaves out history, it does not lose what it cannot classify.
  - **A value matching none of the three is refused**, and silence is the bad outcome either way:
    read as "never below" the changelog looks complete, read as "always below" it empties.
  - **Not `--from`**, though a commit-shaped value makes them look alike: `--from` is this run's
    boundary and applies identically to every package, while this is a lasting per-package fact that
    cascades and still holds next run. That distinction is the reason both exist.
  - The commit form is compared by **position in the range already fetched** (`Segment.endIndex`),
    so it costs no extra git call; `-1` means the floor is older than the range and nothing is below.
  - The `---` between releases is the **writer's**, not the template's: an entry printed to stdout
    or handed to `github-release` as a body has nothing below it to be separated from. None is
    written into a fresh file.
- **`changelog.groupBy` decides what one file is about, and the unit is a *release group***
  (`partitionTargets`, `changelogGroupBy`). `'package'` is the default and nothing about an existing
  repository changes until it asks; `'group'` gives one file to each set of packages that versions
  and releases together - the same `.rmanrc group` key `version` batches its plan by.
  - **One rule, not two.** `group: false` already makes a package a group of itself, so a solo
    group's file is its package's own and anything wider goes to the repository root: `CHANGELOG.md`
    for the default group, `CHANGELOG-<name>.md` for a named one. A repository on independent
    versioning therefore sees no difference between the two modes, which is what makes this a
    generalization rather than a second mechanism.
  - **What it fixes is not cosmetic.** Under `group: true` every package bumps together, so most of
    them own no commit and `!ownCommits.length` skips their entry entirely - measured on
    `panates/sqb`'s 6.0.11, fifteen of seventeen files were not written and the release was readable
    nowhere. The root-changelog fix above routes a *broad* commit somewhere; this routes the whole
    release somewhere.
  - **`BROAD_COMMIT_THRESHOLD` stops mattering in group mode, and that is the tell the unit is
    right.** A commit touching every package is the group's by construction, so there is nothing to
    divert to the root - the threshold exists only because a package-shaped file cannot hold a
    repo-shaped commit.
  - **Read off the root and nowhere else.** It is a *layout*, so there is one answer per repository -
    the rule `run`'s `concurrency` already follows. Cascaded per package, two members of one group
    could disagree about which file they share, which has no answer.
  - **`home` and `filePkg` are different packages and must stay so.** Every per-package question -
    boundary, tag pattern, titles, template - is asked of a member (`home`, the root when it is in
    the group, since `targets` starts there); the file sits wherever the group's file sits
    (`filePkg`, the root for any group of more than one). Collapsing them breaks a named group both
    ways: ask the root and `{name}@*` finds no tag, write beside the member and the group's file
    lands inside one of its packages.
  - **A group's heading may not be one member's tag.** Under a repo-wide pattern the tag (`v1.2.0`)
    is already package-neutral and is used as-is; under `{name}@*` it would be `pkg-a@1.2.0` over a
    file describing all of them, and a *different* member's name as soon as the first one changes -
    so the group's label carries it (`## core 1.2.0`).
  - **`version --changelog` batches one call per file** (`changelogCalls`), by `groupKeyOf` and
    never by the *planner's* key - those disagree about the root, which `VersionPlanService` puts in
    a group of its own (`__root__`). Per package instead, each call's group holds one member, so
    every bullet is still written exactly once and the file ends up with **two** `## v1.0.1`
    headings for one release. A spec asserting the bullets passes either way; the one that measures
    it counts headings, and its control was run.
  - **The group's file rides the group's commit, not the root's version sync.** The root is a member
    of the default group, so `changelogFileByPackage.get(root.name)` is the group's file - added to
    the sync commit it would land one commit *before* the tag, leaving `git show <tag>` without the
    notes for the release it names. `claimedByGroup` is that guard, and the group commit's file list
    is a `Set` because the members share one path.
- **A group name is a file name, so it is checked where it is read** (`assertGroupName`, in
  `groupKeyOf`): a letter or digit, then letters, digits, `.`, `-`, `_`, at most 15. The alternative
  was escaping it at the one place it is written, and that is the worse half - an escape turns
  `core/api` into a `core-api.md` the repository never asked for and cannot search for, and every
  future reader of the name would have to repeat it. 15 is about the reader rather than any
  filesystem: the name is repeated in every heading of the file it names and in the file name
  itself. Refused for `version` too, since `groupKeyOf` is what batches its plan.
- **`--rebuild` regenerates a file instead of appending to it**, and both halves are load-bearing.
  `resolveBoundary` returns `undefined` before it looks at anything: the marker and `catchUpFile`
  are both records of what a *previous* run wrote, so consulting either would rebuild the file from
  where the file already is. And `generateToFile` empties each file it is about to write, once,
  before any prepend - measured with a control, without it two rebuilds give **8 headings and the
  same line twice** where one gives 4 and once.
  - **Only files this run produced an entry for.** A file the run has nothing to say about is left
    alone: emptying it would lose what is there and put nothing back.
  - An explicit `--from` still wins, since that names a boundary the caller chose for this run.
  - It implies `--write`, because "rebuild the changelog" with no file to rebuild would either
    print - which `--from <first-tag>` already does - or silently do nothing.
- **Detection is parallel across targets and the commit read is not, and the slow half is the
  second one.** Measured on `panates/sqb` with a timestamping `git` shim: 18 targets resolve their
  boundary in **18 concurrent** `git describe` calls, 1.2s wall against 1.8s summed; reading the
  range is **peak concurrency 1**, 156 invocations, 6.6s - two `git show` per commit (header, then
  files), one target at a time. A full rebuild of that repository's 1825 commits takes minutes.
  - `Promise.all` over the groups is what makes the first half concurrent, and `GitHelper` spawns
    through `execFile`, so nothing underneath serializes it. Within one target the steps are a
    chain (tag -> registry -> file -> merge-base) and cannot be.
  - **`changelog.startingAt` floors which releases are written, not how far back the history is
    read**, so it does not make a rebuild cheaper. Bounding the *fetch* by it is the obvious
    optimization and is not done: the floor is inclusive and may be a version rather than a ref, so
    turning it into a fetch boundary means resolving it to the release *before* it, which is a
    correctness question rather than a rename.
- **The progress panel is reported, never printed by the service** (`ChangelogService.Options.
  progress`, `Progress`). `ChangelogService` is documented as pure with respect to the console and
  that is not tidiness: `version --changelog` drives it in the middle of its own output, so a panel
  drawn from inside would land on top of that. The CLI implements `Progress` against
  `ProgressPanel`; every other caller leaves it out.
  - **Drawn on stderr**, which is why `ProgressPanel` grew a `stream` parameter - `changelog` is
    `printsDocument`, so `rman changelog > NOTES.md` would otherwise capture the panel's
    cursor-movement codes into the notes. `LiveRegion` already took the parameter and its own doc
    anticipated this caller.
  - **Three phases, and the middle one is where the time goes**: `detect` (boundary, concurrent
    across targets, milliseconds), `commits` (reading the range, two `git show` each, one commit at
    a time), `render` (splitting, grouping, templating - no git). **The commit read happens inside
    the same `Promise.all` as the boundary**, not in the entry loop below it, and mislabelling it
    the other way was the first thing shipped here: the panel named the fast loop "reading
    commits" while the real read sat unnamed in the phase called "detect".
  - **The unit shown has to be commits, not files.** `Progress.commits(label, done, total)` is fed
    from `GitHelper`'s `onProgress`, which is on `_commitInfoFor` and nowhere else because that is
    the only serial loop. Without it the row sat unchanged for the whole slow phase - measured on
    `panates/sqb`, a rebuild read 1825 commits at **~1.2/sec** (older commits are far slower than
    recent ones: the same loop does ~12/sec over a four-release range), so ~25 minutes with one
    line on screen. There is exactly one file under `groupBy: 'group'`, so the header's bar is
    honestly `0/1` the whole time and the item line is what carries the answer.
  - A label sits at `pending` during `detect` deliberately: every label enters it at once and
    leaves in milliseconds, so marking them running fills the panel with rows about to go quiet,
    and the header counts anything not pending as done. `stepIndex` is **0-based** (the panel
    renders `stepIndex + 1`), which is the mistake that shipped `(3/2)` to a terminal.
  - **The header bar is filled from step progress, not from finished items** (`filled` in
    `ProgressPanel.render`): a finished item counts as a whole one, a *running* item as the
    fraction of its own steps it has got through. Counting whole items made the bar useless exactly
    where it was needed - one file under `groupBy: 'group'`, so it sat empty at `0/1` for the whole
    run while the row beside it counted to 1825. `run` gains the same in the small: a nine-step
    build advances within the package instead of jumping at the end of it. The `done/total` counter
    stays items, which is a different true fact and the one the bar cannot carry.
    - `renderProgressBar` clamps both ends now, because a fractional input can round past `width`
      and `'x'.repeat(-1)` throws - inside a redraw, where nothing catches it.
    - **A spec reading the bar back must match filled *and* empty cells together.** Matching up to
      the first `░` reads a full bar as no bar at all, which is exactly the clamp case; measured,
      that spec reported 0 cells and looked like a code bug.
  - `listCommitsCached` shares one fetch between targets with the same boundary, so the commits are
    counted under whichever target asked first. Reporting per sharer would mean either several
    fetches or several rows counting the same work.
  - The static line it replaces is kept for when the panel cannot draw - a pipe, or
    `--no-progress` - which are exactly the two cases that line was for.
- **`--write` prints one line per *file*, not per entry.** An entry is a release, so a backfill
  produces several for one file; printed per entry the run repeated `updated ... CHANGELOG.md` once
  per release it found. The path is repository-relative and the label is gone with the repetition:
  `packages/core/CHANGELOG.md` already says which package it is, and under `groupBy: 'group'` the
  label names a group while the path names the file that was actually written.
- **Trap:** run *after* a tag has been created, auto-detection finds that new tag and reports
  nothing changed. Hence: in CI, release notes are generated **before** `version`; and any code path
  running after the tag exists (`version --changelog`, `github-release`) passes the boundary
  **explicitly**. Do the same for any new note-generating path.
- Skips a `.rmanrc "publish.skip"` package by default; `--include-skipped` brings it back.

### `publish` - the core's command; a *target* is what a plugin contributes

[`src/commands/publish.command.ts`](packages/rman/src/commands/publish.command.ts),
[`src/core/publish-target.ts`](packages/rman/src/core/interfaces/publish-target.ts).

- **Question B.** Each target asks its **own** registry whether this version is already out there:

  | Criterion | Source | Claims by default? | Implementation |
  | --- | --- | --- | --- |
  | **b-1** npm-targeted packages | the local version is among the registry's published `versions` | a package `rman-node` read the manifest of | `NpmPublishTarget` → `PublishService` (`rman-node`) |
  | **b-2** docker-targeted packages | `docker manifest inspect <image>:<version>` | nothing - opt-in | `dockerPublishTarget` → `DockerPublishService` (`builtins/publish-targets/docker/`) |
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
- **`publish` drops from each target's plan every package that does not ship to it** (`shipsTo`,
  applied to whatever `getPlan` returned). It was left to each target and the npm one never asked,
  so a package declaring `publish.target: ['docker']` was planned for npm while `rman list` called
  it docker-only (panates/rman#40). The npm target still filters early (`shipsHere`) so such a
  package costs no `npm view`; the command's filter is the guarantee. `--target npm` with nothing
  shipping there is now the same error `--target docker` already was.
- **`PublishTarget.skipReason` is what `rman list` leaves a target out by**, `-` when none is left
  (`skipReasonFor`, which asks `publish.skip` first). It was grey first and the user changed it: a
  grey name still reads as a destination. An inventory must not ask the registry, so the rule is
  answered from the config and the manifest alone - and npm's `getPlan` calls the same
  `PublishService.skipReason`, or the list and the plan would disagree about which packages ship. A
  monorepo's root lists no targets and reads blank, not `-`: `publish` never makes it a candidate.
- **`rman list`'s table keeps each release group together** (`byGroup`), in `version`'s plan order -
  root, groups by first appearance, `group: false` last - with a `Group` column read the same way
  (`(default)` grey, named by name). Not under `--toposort`, and not in `--json`, whose order is the
  inventory's. `Item.groupKey` is `version --json`'s spelling, so a consumer joins the two on it.
- **`PublishTarget.labelFor` is what the list shows instead of a target's name**, and only shows:
  npm answers the host of `publishConfig.registry` (`npm.pkg.github.com`), `registry.npmjs.org`
  staying `npm`. A scoped `.npmrc` registry is not read, so such a package still shows `npm`.
  `publishTargets` in `--json` and `--target` keep the name.
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
- **Staged publishing: `npm stage publish`, through `--staged` / `.rmanrc "publish.npm.staged"`.**
  The version goes into npm's queue instead of onto the registry and waits for a maintainer's
  `npm stage approve`, which is where the 2FA challenge lives - so a stolen automation token can
  stage and cannot approve.
  - **rman drives the first step and must never grow the rest.** `stage list`/`view`/`download`/
    `approve`/`reject` belong at a terminal with a 2FA prompt; wrapping `approve` would put the
    approval back inside the automation that staging exists to protect against.
  - **`stage publish`, not a `--staged` flag on `publish`** - that is npm's own spelling, and
    `buildPublishCommand` swaps the subcommand rather than appending a flag. The publish flags pass
    through unchanged; `--otp` reads oddly beside it (staging is what *defers* 2FA) and is passed
    anyway rather than refused, because whether npm accepts it there is npm's to answer.
  - **Decided in the plan, read back by `applyPlan`** (`Entry.staged`), exactly as `distTag` is, and
    the stake is higher: a plan saying "staged" while the command published directly is the one
    disagreement with no undo, since npm will not unpublish after 72 hours.
  - **Reported through `detail`**, which is how the dist-tag already travels - so `--dry-run --json`
    shows it without the core knowing anything about npm. The core's JSON shape is fixed
    (`name`, `target`, `status`, `version`, `detail`, `reason`) and that is deliberate.
  - **A staged entry still reads `publish`, and that is a limitation rather than a decision.**
    Question B is "is this version on the registry", and a pending one is not - `npm view` does not
    report the queue - so a second run before an approval proposes the same package again. Whether
    npm accepts a duplicate stage is npm's answer to give.
  - **No version check.** Staging needs npm ≥ 11.15.0 and Node ≥ 22.14.0, and the version that
    matters is the *runner's*, not the one resolving the config. npm's own `Unknown command:
    "stage"` beats a guess made somewhere else.
  - **It is the other half of npm Trusted Publishing's checkbox.** `npm stage publish` is always
    permitted for a trusted publisher; direct `npm publish` needs **Allow `npm publish`** ticked on
    the package's connection. A repository that leaves it unticked has to pass `--staged`.
- **A failed publish blocks only what a consumer's install needs it for** (`consumerNeeds`): a
  `dependencies` entry or a non-optional peer. Every edge used to count, and measured on opra's
  1.31.0 release `@opra/api-ui` failing its first publish blocked `@opra/http` - which lists it as
  an optional peer and a devDependency only - and elastic, mongodb and sqb behind it.
- **`docker` runs last and waits for the registries first** (`PublishTarget.publishesLast`,
  `PublishTarget.waitUntilAvailable`). An image whose `Dockerfile` runs `npm install` asks for the
  versions this same run publishes. Measured on `panates/syncbridge`: run in registration order,
  `docker` came first and failed `ETARGET` on `@syncbridge/common@0.13.9`; and ordering alone is not
  enough, because npm accepts a version minutes before it serves it. So before the first
  `publishesLast` target with work, `publish` asks each earlier target to wait for what it published
  - npm polls `npm view --prefer-online` (5s, up to 5 min, staged entries skipped). A version still
  missing is named and the build goes ahead. The core knows no registry; each target answers for
  its own. The fuller fix - building the image from local `npm pack` tarballs so the registry is out
  of the path - was weighed and deferred: it needs every repository's `Dockerfile` to change.
- **Never looks at whether `version` ran** - deliberately. It only inspects what's on disk and on the
  registry, so it behaves the same right after a bump or days later. Re-running is safe.
- In CI, gate the release pipeline on **this** plan, not on `version --json`.
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

- **Which registry a package goes to, and the check that has to agree with it** (`resolveRegistry`).
  Three ways to say it, all npm's own: `.npmrc`'s `@owner:registry=` (a scope, and the usual GitHub
  Packages setup), `package.json`'s `publishConfig.registry` (one package), and `--registry` (the
  run). Precedence is npm's, measured against it: `--registry` wins over `publishConfig.registry`,
  and with neither given **nothing is passed**, so npm resolves `.npmrc` itself.
  - **`npm publish` reads `publishConfig.registry` and `npm view` does not**, which is the whole
    bug this fixed. Measured: a package whose `publishConfig.registry` pointed at a dead local
    address was still answered from registry.npmjs.org, while `npm view @foo/bar` under
    `@foo:registry=http://127.0.0.1:1/` did try that address. So the scoped case always worked and
    the per-package one silently did not.
  - **What that cost**: `npmViewPackage` swallows a failed lookup as `undefined`, which reads as
    "never published", so the plan proposed a publish on **every** run - the first succeeded and the
    second was rejected by the registry for republishing a version. Worse where some *other* package
    holds that name on npmjs.org: rman then reads a stranger's version list and can report
    `up-to-date` for a publish that never happened.
  - **Returning `undefined` rather than a default is what keeps the working case working.** Passing
    an explicit `--registry` would override whatever `.npmrc` says.
  - **Only the check needed fixing.** `applyPlan` passes `--registry` only when given, and the
    generated manifest keeps `publishConfig` (`derivePublishManifest` deletes only `directory`), so
    npm already publishes to the right place - measured with `--dry-run`, which reports
    `Publishing to https://from-publishconfig.example/`.
  - **Authentication does not travel with any of this and is not rman's.** GitHub Packages needs
    `//npm.pkg.github.com/:_authToken=` in an `.npmrc` (or `--userconfig`); Trusted Publishing
    covers npmjs.org only.
- **Publishing from a build directory** (`publishConfig.directory` > `.rmanrc "publish.npm.directory"` >
  `--contents`): the manifest in that directory is **generated by `publish`**, at publish time, and
  is deliberately unconfigurable. Removed from the copy: `devDependencies`; every `scripts` entry
  except `preinstall`/`install`/`postinstall` (the only ones a consumer's install runs - dropping
  those would silently break every native-module package); `private` **only when the package
  declares a `publishConfig`**; `publishConfig.directory` (it pointed *here*). `"workspace:"` ranges
  are resolved in it, and what the build left there is restored afterwards.
  - **`getPlan` decides `private` from the manifest that will be published** - the derived one
    (`privateBySource`: the source's `private`, kept only without a `publishConfig`), in place the
    source's own - not from the bare source, since the two disagreed and only one is shipped. Reported from
    `postgrejs-kysely`: a single-package repository whose source carried `private: true` as a guard
    against a stray `npm publish` answered `skip - private package` while version, tag and GitHub
    release all went through, and the registry got nothing.
  - **The `publishConfig` rule is the user's**, and it is what keeps a genuinely private package
    private: `private` with a `publishConfig` is a source guard on something set up to publish;
    `private` alone means it. Measured against both: `postgrejs-kysely` (`private` +
    `{"access":"public"}`) publishes, opra's five `example-*` packages (`private`, no
    `publishConfig`) stay skipped. Reading the build manifest *without* the rule would have
    published them - every writer of it was deleting `private` unconditionally.
  - **`build/package.json` is not read, and 2.11.1 read it.** That file is whatever the build left
    there and `applyPlan` writes over it, so it is never what is published. The preset writes one,
    but from the build `after` step a package can replace - opra's `common` and `client` replace it
    with their own esbuild step, had 625 and 52 built files and no `package.json`, and the plan
    answered `error` for both: opra's release stopped after its version had been pushed. The
    preset's writer applies the same `publishConfig` rule so the two agree, but decides nothing.
  - **`privateBySource` is asked first**: private with no `publishConfig` is skipped before the
    build directory is looked at, or an unbuilt private package errors as unbuilt - opra's examples
    inherit the preset's `publish.npm.directory` and skip their build.
  - **A build directory that is missing or holds only a `package.json` is an `'error'`**
    (`hasBuildOutput`): before this, `applyPlan` would create the directory, write the derived
    manifest and publish a tarball holding nothing else.
  - **`publish`'s own failure line goes to stderr** (`logged`), so a `--json` stdout stays one
    document; it was on stdout below the plan, which `jq` and `JSON.parse` both refuse.
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
- Never touches `node_modules`; that is `ci`'s job.
- `clean` and `ci` are the two commands still wholly `rman-node`'s. `publish` is no longer one of
  them - see above. Both are **declared**, not built, like every built-in.

### `list` / `run`

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
    that it is *named*, and its output is replayed in full at the end. What does not fit is counted
    in the one trailing `… and N more` line, which now covers both kinds.
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

[`src/core/run-step.ts`](packages/rman/src/core/interfaces/run-step.ts). `run.<script>.before`/`.exec`/`.after`,
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
  [`src/core/resolve-target.ts`](packages/rman/src/core/config/resolve-config-target.ts)). **`extends` is now its
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

- Don't extend `ALWAYS_APPEND` casually: an always-appending key can never be *un*-said by a closer
  layer, which is only acceptable where the value is a set of contributions rather than a decision.

**`platforms` is the key a technology arrives through, and `platform` only *names* one.** They read
alike and are opposite directions:

| | |
| --- | --- |
| `platforms: [...]` | contributes technologies - an instance, or a glob naming modules that export one. Appends, like `plugins` |
| `platform: 'node'` | says which of the ones already in play claims **this directory**, overriding the manifest question |

- **A declared `platform` no technology provides is an error** naming the file, and the fix is
  `platforms` or `extends` - it does not load anything on its own. That is the correction:
  `platform: 'node'` used to *promote* the named built-in to the front of `plugins`
  (`_expandBuiltinPlugins`), because saying which technology a repository is was taken as saying it
  has it. It arrived with commands and publish targets attached, which is a great deal for one word
  to mean, and it only ever worked for a name rman itself shipped. `DEFAULT_PRESETS` makes the
  common case (`node`) need no declaration at all, and anything else is one `extends` line.
- Read from the unmarked key **or** from `"[/]"`, since both are the root speaking - and from any
  directory, not just the root: which technology claims a directory is that directory's fact.
- **`ConfigReader` writes it when nothing declared it**, from the first loaded platform whose
  manifest provider recognizes the directory - so `Workspace._platformFor` finds a name either way
  and the answer is established once rather than re-derived by whoever reads it.
- **A plugin's own `platforms` join the same list, inside `ConfigReader._addPlugin`.** They used to
  be collected by `Workspace._readLevel` *after* the reader had finished, so the reader's own
  platform decision could not see them - two lists with two orders. Invisible while nothing else was
  in the list; the moment presets were, a plugin handed straight to `Workspace.create` lost its
  directories to one (measured: `ws.packages` came back empty for a repository whose own technology
  was sitting right there).

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

## Lint: `packageDir` entries are absolute

[`eslint.config.mjs`](eslint.config.mjs). `import-x/no-extraneous-dependencies` is pointed at two
roots for `packages/*/test/**` - the repository root, where a workspace installs its dev tooling
once, and each package, for its own dependencies and peers. `packageDir` **replaces** the default
nearest-package lookup rather than adding to it, which is why both have to be listed and why a new
package gets a line.

- **A relative entry is resolved against `process.cwd()`, not against the config file**, so
  `'packages/rman'` was right from the repository root and pointed at `packages/rman/packages/rman`
  - nothing - from inside the package. With that root unseen, the package's own dependencies read as
  undeclared: measured, `eslint .` clean from the root and
  `'fast-glob' should be listed in the project's dependencies` from `packages/rman`, on imports
  declared exactly where they belong.
- **A lint result that depends on where you are standing is the thing to rule out**, because `npm
  run lint` is always run from the root and an editor's integration usually is not. Every entry is
  built with `path.join(import.meta.dirname, ...)`; check from a package directory as well as from
  the root after touching this rule.
- **Do not widen the rule to silence it.** Scoped to tests deliberately: setting `packageDir`
  repository-wide made every runtime import in `packages/rman/src` read as undeclared instead
  (measured - 90 errors on `ansi-colors` and friends). Source keeps the default lookup, which is the
  check worth having.

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
- **A fixture writes ONE config file per directory**, which is the rule `ConfigReader` enforces and
  which several fixtures predated. Two shapes of the same mistake, and both were silent until the
  rule existed:
  - a `.rmanrc` written as the **root marker** plus a `.rmanrc.cjs` for a case that needs a
    function. The marker only has to exist - `Workspace.findRoot` accepts any `.rmanrc*` - so the
    `.cjs` *is* the marker. `run.service.spec.ts`'s `writeFixture` and `version.service.spec.ts`'s
    `fixtureWithOrigin` take the JS form as an argument and write one file or the other.
  - a `.rmanrc` plus `package.json`'s own `"rman"` key. In `plugins/node/**` this is easy to write
    by accident because `runCli` calls `declarePlugin`, which writes an `.rmanrc` to declare the
    preset - so a fixture putting its settings in the manifest ends up with two. Put them in the
    `.rmanrc`; `declarePlugin` merges into whatever is already there.
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
  (Both of those modules are gone - see the presets section - but the shape is not.)
  `detect.ts` imported `builtins.js` statically; the config reader already imports it dynamically and
  documents the same cycle from the other side. **Any new static import into `plugins/` from `core/`
  is this bug again** - and `presets/` counts, since a preset module pulls in a platform and its
  services. That is why `presets/index.ts` holds names rather than imports and `ConfigReader`
  reaches a preset through the same dynamic `import()` an `extends` uses.
- **A `declare module` augmentation that reaches rman and nobody else.** The node plugin's lives in
  `builtins/platforms/node/augmentation/rmanrc.augmentation.ts`, imported by the plugin's entry point, which
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

`npm run build` is `npm run build -w packages/rman` - plain npm, never `rman build`.

**It was `rman build`, and that is a bootstrap loop that only bites on the release that matters.**
The `rman` on PATH is whatever is *published*, so a version introducing a config feature cannot
build itself: the repository's own `.rmanrc.yml` already uses `plugins` and `"[*]"`, neither of
which 1.0.x understands. The failure lands exactly when a release is being cut.

- **It named two workspaces until `packages/node` was folded in, and the second half stayed here
  long after the directory went.** What that ordering clause said - `rman` first, because
  `rman-node`'s build resolved `rman` from `packages/rman/build/index.d.ts`, and because `tsc -b`
  would order the compilation but not the pre/post hooks around it - is still the right reasoning
  for a second package, and there is no second package. Restore it with the order written out, not
  derived, if one ever comes back.
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

## The release workflow, and the npm auth trap that cost five runs

[`.github/workflows/release.yml`](.github/workflows/release.yml) releases rman **with the rman in
that commit** - `npm ci`, `npm run build`, then `node packages/rman/build/cli.js version/publish/
github-release`. It called `panates/github-actions/.../node-release.yaml@v1` until 40f41e3, which is
safe only because *that* version calls rman nowhere: `@v2` drives the whole release with
`npx rman@1` (measured: 0 references against 20), so following the other repositories onto it would
have had rman 2.x released by an rman that cannot read this repository's own `.rmanrc.yml`. Same
bootstrap loop `npm run build` was taken off, and it bites exactly when a release is being cut.

- **Two builds, and both are load-bearing.** The first is the bootstrap - there is no rman to run
  `version` with until it finishes. The second is the artifact: `postbuild.cjs` bakes
  `package.json`'s version into `build/constants.js`, so a build made *before* the bump ships a CLI
  reporting the old version. Measured: set `package.json` to 9.9.9 without rebuilding and
  `--version` still answers the previous one. It holds although `.rmanrc.yml` declares no
  `version.stamp` - what bakes the version in is postbuild, not the config.
- **The built-in `GITHUB_TOKEN`, not a PAT**, and that removes a redundant run rather than a secret:
  a push made with `GITHUB_TOKEN` deliberately does not trigger workflows, and `version --push`
  pushes to `main`, which is what this workflow triggers on. With a PAT every release started a
  second run of itself, which the `no-release` guard does not catch (a `chore(release): ...` message
  contains neither guard word) and `concurrency: cancel-in-progress: false` does not cancel.
- **`private: true` had to come off `packages/rman/package.json`**, or `rman publish` released
  nothing: measured, the plan answered `skip - private package`. (Since 2.11.1 it would publish - the
  decision reads the build directory's manifest, see the build-directory section - but the
  `prepublishOnly` guard below is still the better statement.)
  The flag was never about the artifact - publish runs `npm publish` with cwd =
  `packages/rman/build` and `derivePublishManifest` generates that manifest itself, deleting
  `private` on the way. It was guarding the *source* directory against a stray `npm publish`, which
  a `prepublishOnly` says on its own: measured on four routes, it blocks `npm publish` in the
  package and `npm publish -w packages/rman` from the root, and does not fire for cwd=build (rman's
  own route) or `npm publish build`. It cannot reach a consumer - `postbuild.cjs` deletes `scripts`
  wholesale and `derivePublishManifest` keeps only the three install hooks. **No backticks in that
  message**: npm runs a script through `sh -c "..."`, where a backticked `` `rman publish` `` is
  command substitution and would run.

**npm Trusted Publishing (OIDC), and the four dead ends it went through.** All of these report as
one of two messages, neither of which names the cause:

| symptom | what it means |
| --- | --- |
| `ENEEDAUTH` | npm found no credential **and did not attempt the OIDC exchange** |
| `404 Not Found - PUT .../rman` | npm sent a credential the registry rejected - it returns 404 rather than 403 so nobody can probe which packages exist |

- **`registry-url` on `setup-node` is required**, and dropping it was the first dead end. The
  reasoning was right for v4 and explicitly wrong for v7: v4 wrote an `.npmrc` whose `_authToken`
  was a dummy `NODE_AUTH_TOKEN` fallback, v7 removed it and says so ("npm Trusted Publishing (OIDC)
  is not affected, since it does not use NODE_AUTH_TOKEN"), and the documented recipe sets it.
- **The empty auth line it writes must be stripped**, and that was the second. `registry-url` makes
  setup-node write `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the file
  `NPM_CONFIG_USERCONFIG` points at - **not** `./.npmrc`, which is where a diagnostic will look
  first and find nothing. With no token that resolves to nothing, and npm reads *having* an
  `_authToken` entry as being authenticated already, so it never reaches for OIDC. This is
  actions/setup-node#1551. The `Configure npm auth` step removes it with `grep -v` into a temp file;
  **not `sed -i`**, which BSD sed reads as a backup suffix, making the line a silent no-op on macOS
  - measured while checking that very step.
- **`npm install -g npm@latest` was a third**, and it was insurance that moved the runner: Node 24
  ships npm 11.19.0, well past the 11.5.1 OIDC needs, and the upgrade took the job to npm 12.1.0 -
  a major the recipe never contemplates, since it has no upgrade step at all.
- **The cause was the trusted-publisher registration on npmjs.com**, and deleting and recreating it
  fixed it with every field re-entered identically. That is the documented remedy for "everything
  looks right and OIDC never engages", and it is worth reaching for **early** rather than last.
- **rman was ruled out by measurement, not by argument.** `npm publish` is a *grandchild* here -
  `rman publish` execs it through `BinPath.env`, which rebuilds the environment from
  `{ ...process.env }` - and a probe run inside that spawn reported
  `child OIDC url: present, child OIDC token: present, child npm: 11.19.0`.
- **A publish is not visible immediately.** npm answers `Your package is being processed and may
  take a few minutes to become available`, and a registry query inside that window says the version
  is absent - measured, and mistaken for a failed publish. Read `npm notice ... Signed provenance
  statement` plus `+ rman@<version>` in the log as the success, not a registry read taken seconds
  later.

**The diagnostic step that found all this is deleted**, because the question is answered and it
printed eight lines on every release. What it did, if it is ever needed again: `npm --version`, the
presence (never the value) of `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`, the contents of
`${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}` with `_authToken` values redacted, and the claims npm
matches a publisher on, read from the token GitHub issues for npm's own audience:

```bash
curl -sS -H "authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=npm:registry.npmjs.org" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const c=JSON.parse(Buffer.from(JSON.parse(s).value.split('.')[1],'base64url'));
    for (const k of ['repository','repository_owner','workflow_ref','job_workflow_ref','environment'])
      console.log(k, c[k] ?? '(absent)');
  })"
```

**Never print the token itself.** `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is a live credential that GitHub
does **not** mask, because it is not a registered secret - and `${VAR:+present}${VAR:-ABSENT}`, which
reads as a tidy way to report presence, prints `present<the value>` when the variable is set. Caught
locally with a fake token before it ever ran.

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
