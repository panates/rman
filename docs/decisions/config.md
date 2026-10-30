# Config: files, cascade, selectors, `extends` and presets

Design decisions moved out of `CLAUDE.md`. Covers How `.rmanrc` is read and cascaded: `ConfigReader`, `Workspace`, `ConfigInterpolator`, `merge-config.ts`, the presets, and why there is no JSON Schema.

## `config.ts` is gone - five files, each with one subject

It was 1528 lines holding the reader, the interpolator, the filesystem scope, the types and the path
constants at once, and its spec was `core/config.spec.ts`. Where each half went:

| | |
| --- | --- |
| [`core/config/config-reader.ts`](../../packages/rman/src/core/config/config-reader.ts) | what the **files say** - one config per directory, `extends`, presets, `plugins`/`platforms`, selector parsing |
| [`core/workspace.ts`](../../packages/rman/src/core/classes/workspace.ts) | which directories hold packages, what each answers to, and the **cascade** into `Package.rawConfig` |
| [`core/config/config-interpolator.ts`](../../packages/rman/src/core/config/config-interpolator.ts) | what those words **evaluate to** - every `${{ }}`, every value function, `defer(...)`'s second pass |
| [`core/config/config-file-scope.ts`](../../packages/rman/src/core/config/config-file-scope.ts) | the `file` and `read(...)` members of the expression scope, and the parse cache |
| [`interfaces/config-scope.interface.ts`](../../packages/rman/src/interfaces/config-scope.interface.ts) | what an expression can **name**: `ConfigScope` and its members |
| [`interfaces/rman-config.interface.ts`](../../packages/rman/src/interfaces/rman-config.interface.ts) | `RmanConfig`, and the author/reader pair `ConfigValue` / `Resolved` / `ResolvedConfig`, plus `defineConfig` |
| [`core/config/config-paths.ts`](../../packages/rman/src/core/config/config-paths.ts) | `CODE_SUBTREES`, `STEP_PATHS`, `DEFERRED_PATHS` |

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

[`ConfigReader`](../../packages/rman/src/core/config/config-reader.ts) reads it and
[`Workspace`](../../packages/rman/src/core/classes/workspace.ts) cascades it. One sentence decides it: **what is written above reaches
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

[`ConfigReader._resolveExtends`](../../packages/rman/src/core/config/config-reader.ts),
[`src/core/config/merge-config.ts`](../../packages/rman/src/core/config/merge-config.ts). It was `extends-config.ts`,
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

## Presets: `extends: "rman:node"`, and the ones laid down by default

[`src/builtins/presets/`](../../packages/rman/src/builtins/presets), `ConfigReader._applyPresets`. **A preset is an rman
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
- **A list of names, never an import** ([`src/builtins/presets/index.ts`](../../packages/rman/src/builtins/presets/index.ts)
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
