# Platforms, plugins, discovery and selectors

Design decisions moved out of `CLAUDE.md`. Covers `builtins/`, `Platform` / `Plugin`, `Package.provider`, `Workspace.walk`, `Package.selector`, `BinPath`, the `plugins` and `platforms` keys.

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

[`src/core/workspace.ts`](../../packages/rman/src/core/classes/workspace.ts). `Workspace.Provider` is
`(dir) => string[] | undefined`: **the directories directly below `dir` that hold a package**, or
"not mine". The recursion is the core's (`walk`), so a platform only ever speaks about its own
packages - which is all a platform knows.

One step: take the directory's declared platform if its config names one, else `app.platformFor`;
ask **that** platform where its children are; repeat. `Repository.packages` is that tree flattened.

- **The node platform reads pnpm's member list before npm's** (`NodePlatform.getWorkspace`,
  `pnpmWorkspacePackages`): `pnpm-workspace.yaml`'s `packages` when the file lists them, else
  `package.json#workspaces`. pnpm ignores the latter, so a pnpm repository had to keep two lists in
  step or rman saw no packages at all - reported from `syncbridge-io/public-modules`.
  - **Measured on pnpm 12.10.1 with `pnpm ls -r`**, and the specs use those layouts and answers:
    `packages/**` takes members at any depth and none under `node_modules`, `!packages/test-*`
    excludes. npm's `workspaces` keep `deep: 0`.
  - **A settings-only `pnpm-workspace.yaml` falls back to `workspaces`, which pnpm does not do** -
    pnpm sees the root and no members there. pnpm 9 moved its settings into that file, so one
    without `packages` is ordinary and is read as saying nothing about packages.
  - **Invalid YAML throws, naming the file**, where a malformed `package.json` is left for
    `Package` to report: nothing else reads this file, so a swallowed error would read as an empty
    repository.
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

[`packages/rman/src/utils/bin-path.ts`](../../packages/rman/src/utils/bin-path.ts). `exec` and `runBin`
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

**The running `node`'s directory goes ahead of the inherited PATH only when that PATH would find a
different `node`** (`NodePlatform.inheritsNode`, compared by real path). It is the directory
`npm install -g` writes to, so unconditionally it put every global npm binary ahead of the user's own:
measured here, the shell's `pnpm` was 12.10.1 from `~/Library/pnpm/bin` and rman's children got a
global 9.9.0, so `deps -u` printed `Not verified: pnpm 9.9.0` and read no `minimumReleaseAge` - while
the shell's `node` was the very interpreter rman ran on. A nested `rman` in a `run` script reached the
global one the same way. When the two `node`s *do* differ the directory still goes ahead, neighbours
included; shim a binary in `<root>/node_modules/.bin`, which the walk reaches first, if that bites.

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
