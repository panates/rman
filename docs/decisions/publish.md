# `publish` and `github-release`

Design decisions moved out of `CLAUDE.md`. Covers Publish targets (npm, docker, cloudflare, spm), hooks, `files`, registries, build directories, GitHub releases.

## `publish` - the core's command; a *target* is what a plugin contributes

[`src/commands/publish.command.ts`](../../packages/rman/src/commands/publish.command.ts),
[`src/core/publish-target.ts`](../../packages/rman/src/core/interfaces/publish-target.ts).

- **Question B.** Each target asks its **own** registry whether this version is already out there:

  | Criterion | Source | Claims by default? | Implementation |
  | --- | --- | --- | --- |
  | **b-1** npm-targeted packages | the local version is among the registry's published `versions` | a package `rman-node` read the manifest of | `NpmPublishTarget` → `PublishService` (`rman-node`) |
  | **b-2** docker-targeted packages | `docker manifest inspect <image>:<version>` | nothing - opt-in | `dockerPublishTarget` → `DockerPublishService` (`builtins/publish-targets/docker/`) |
  | **b-4** cloudflare-targeted packages | a Pages deployment labelled `<name>@<version>` (Cloudflare's API), or a Worker version tagged `v<version>` (`wrangler versions list`) | nothing - opt-in | `cloudflarePublishTarget` → `CloudflarePublishService` (`builtins/publish-targets/cloudflare/`) |
  | **b-5** spm-targeted packages | `spm view <name> --json` lists the version | nothing - opt-in | `spmPublishTarget` → `SpmPublishService` (`builtins/publish-targets/spm/`) |
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
    (`name`, `target`, `status`, `version`, `detail`, `reason`) and that is deliberate - with one
    optional addition, `artifact`, below.
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
- **`pnpm publish` gets `--no-git-checks`** (`buildPublishCommand`): pnpm refuses a branch other than
  `main`/`master` and a changed tree, both rman's to decide (`allowBranch`, `dirtyReason`) - a prerelease
  from `alpha`/`beta` would be refused, and an in-place publish writes the derived manifest over
  `package.json` first. npm makes neither check. pnpm 12 does Trusted Publishing and signs provenance
  itself - measured on `panates/sqb` 6.3.2.
- **The `spm` target blocks what a consumer needs, like `npm`** (`SpmPublishService.applyPlan`): one
  `consumerNeeds` (`platforms/node/utils/consumer-needs.ts`) for both, so the two cannot disagree about
  which edge blocks. Before it, a module behind a failed dependency was tried and refused by the registry.
- **A transient npm failure is tried again** (`PublishService.applyPlan`, `transientPublishError`):
  `TLOG_CREATE_ENTRY_ERROR`, a 5xx or 429, a dropped connection - two more attempts, 10 s and 30 s
  apart. Reported from opra's 1.34.0: a Sigstore 409 on `@opra/socketio` left 18 of 20 published,
  blocked `nestjs-socketio`, and failed the step before the GitHub Release ran.
  - **The registry is asked before each retry**, since a 5xx can come after the upload and a blind
    second attempt is refused for republishing. Not for a staged entry, which npm does not show.
  - **The child is piped to read npm's output**, each line written on to stderr - with
    `stdio: 'stderr'` the error said only `Command failed (1)`.
  - Recognized by npm's own error codes, never "any failure": an auth or version-conflict error
    answers the same twice. Each spec in "a publish that fails for a reason that is not the
    package's" turns red with the patterns emptied (measured, three of four - the fourth is the
    negative case).
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
- **`cloudflare` deploys once per version, and the label is the registry.** A Pages deployment's
  commit message is `<name>@<version>`, a Worker version's tag `v<version>`, and the plan reads them
  back. Asked for by `panates/syncbridge`, whose two web UIs deployed from a workflow running
  `wrangler` on every merge - outside `publish.skip`, `--dry-run` and `version`, so a merge tried to
  deploy a UI the repository had taken out of publishing.
  - **Pages through the API, Workers through wrangler**, and that asymmetry is wrangler's:
    `pages deployment list --json` drops the commit message (measured in 4.81's source), while
    `versions list --json` returns the annotations. The API takes the same token.
  - **No credentials is an `'error'` in the plan**, not a guess - the check needs the token anyway.
  - The class's steps are `protected` members (`resolveDeploy`, `isDeployed`, `wrangler`), per the
    rule above; `docker`'s module functions predate it.
- **`spm` is built in, the user's call over a target shipped by `@syncbridge/syncbuild`**: rman
  already carries the npm registry's half (`npm view`, `npm publish`), and the SyncBridge registry
  is the same kind of thing and ours. The rule that came with it: **what rman needs from spm is
  asked of spm, never reimplemented here** - `spm view --json` and `spm publish --no-wait` were added
  to syncbuild for this target rather than rman calling the registry's HTTP API itself.
  - **A failed lookup is an `'error'`**, the opposite of the npm and cloudflare checks: their
    catch-everything shape is the measured cost recorded above (a failed `npm view` read as "never
    published"), and `spm view` exits non-zero exactly so this one need not guess.
  - **`--skip-existing` makes the publish exact where the read cannot be** - a private package is
    `[]` to a reader without the right identity - and a skipped version comes back `up-to-date`,
    so `--json` does not count it published.
  - **`--no-wait` only when nobody can approve** (`unattended`: not GitHub Actions, no TTY); exit
    code 3 is the approval it would have waited for. Asked of spm rather than refused here, so a
    registry asking no approval still publishes unattended.
  - **The `--spm-` prefix is not style**: npm declares `--access` and `--registry`, and two targets
    declaring one option name is refused at startup.
- **`publish.before` / `.after` and `publish.<target>.before` / `.after` are hooks around a
  package's publish** (`RunService.runHook`, `hookSteps` in `publish.command.ts`), the user's shape
  over a single pair: global ones around the package, each target's around its own publish. Asked
  for by `syncbridge-io/public-modules`, to run `spm verify` for exactly the packages a run
  publishes. `run.publish.*` never attached - it is `rman run publish`'s config.
  - **`runHook`, not `runLifecycleSlot`**: a lifecycle slot also reads the package's own steps, and
    npm's step source maps `prepublish` / `postpublish` - which `npm publish` runs itself. Through
    the slot they would run twice.
  - **A failed hook turns the entry into an `'error'` in the plan the target is handed**, so the
    target leaves it alone and `--json` reports it. A failed `after` is a failure on a package that
    is published; the reason says "published, but".
  - In `STEP_PATHS` (`publish.before`, `publish.*.before`, ...), so a function there is a step.
  - Output on stderr, like every child on the publish path.
- **`publish.<target>.files` copies files in for one target and puts the package back before the
  next** (`utils/publish-files.ts`, wrapped around each target's `applyPlan` in `publish.command.ts`).
  Asked for one build shipped to Docker and Cloudflare with different settings.
  - **Copied, never written from config** - the user's call, after a first design that wrote a
    `config.json` from a value in `.rmanrc`: a platform's file may be an image, and kept as a real
    file it has a diff and a history.
  - **What a destination held is moved aside, not copied**, into `.git/rman/publish-files`: inside
    the repository so the next run finds it, never committed, and surviving a reboot, which a temp
    directory may not. A rename is instant for an image or a directory.
  - **The journal is written before anything is touched**, and the restore is synchronous so
    `signal-exit` can run it on Ctrl-C. A run that died outright is finished by the next publish,
    first thing (`PublishFiles.recover`), so one target's file can never ship with another.
- **A prerelease image is not `latest`** (`imageTags` in `docker-publish.service.ts`): every image
  was pushed as `<version>` and `latest`, a beta included - npm's `distTagFor` rule, missing on the
  other registry. The floating tag is now `latest` or the prerelease's identifier, and the plan's
  `detail` lists every tag so `--dry-run` shows it.
- **`publish.cloudflare.variables`, not `vars`**: `vars` is reserved at every config level (the
  `${{ vars.x }}` scope), so a key by that name never reaches a target - and the type refused it
  first, since `CloudflarePublishOptions` cannot extend both that and `ScopedVars`. Any future
  target key mirroring a tool's `vars` needs another name.
- **`--json` without `--dry-run` is printed after the run and says what happened**
  (`jsonResult`): `published` rather than the plan's `publish`, `error` for a failure, and an
  `artifact: { ref, digest }` where the target pushed something addressed by content
  (`PublishTarget.Entry.artifact`). Asked for by `syncbridge-io/syncbridge`, whose production
  deploy pins `<image>@sha256:...` and needs the digest from the push in the same run - a tag
  re-read from Docker Hub by a later job could have moved. It used to print the plan *before*
  publishing, which nothing read: the release workflow only ever ran `--dry-run --json`.
  - **docker's digest is buildx's own `--metadata-file`** (`containerimage.digest`, the pushed
    index). Unreadable metadata leaves `artifact` out and the publish succeeded - the image is up.
  - **stdout has to stay one document, so every child on that path writes to stderr**
    (`exec`'s `stdio: 'stderr'`, `['inherit', 2, 2]`): `npm publish` prints `+ pkg@1.0.0` and
    `docker login` prints `Login Succeeded` on stdout, and the `published` lines go to stderr under
    `--json`. Measured with the built `exec`: `stdio: 'stderr'` leaves stdout empty.
  - **A run that stops before publishing prints the plan**, once - the `printed` guard is what keeps
    a later exit from adding a second document.
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

## `github-release`

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
- **A dirty-tree refusal names the files** (`dirtyReason` in `utils/git.ts`), here and in every
  publish target and `version`: `uncommitted local changes: packages/web-ui/Dockerfile`. The bare
  sentence cost a release on `panates/syncbridge` - a build script rewrote a Dockerfile label and the
  CI log said nothing else. Callers compare against `UNCOMMITTED` with `startsWith`, never `===`.
- A missing release tag is an **error**, never a silent skip - the notes' boundary is the previous
  release tag, so releasing without one would quietly produce notes covering the entire history.
