# Tests, smoke and lint

Design decisions moved out of `CLAUDE.md`. Covers Spec fixtures and their traps, `pnpm run smoke`, `pnpm run typecheck`, eslint `packageDir`.

## Lint: `packageDir` entries are absolute

[`eslint.config.mjs`](../../eslint.config.mjs). `import-x/no-extraneous-dependencies` is pointed at two
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
- **[`packages/rman/test/_fixture.ts`](../../packages/rman/test/_fixture.ts)** is the core's synthetic
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

[`support/smoke.cjs`](../../support/smoke.cjs), [`support/smoke-types/`](../../support/smoke-types).
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
