# Config types: whoever reads a key declares it

Design decisions moved out of `CLAUDE.md`. Covers `rman-config.interface.ts`, `RmanConfig` / `Resolved`, contributed keys, `packageManager`, `dependencies`, `PublishTarget`.

## Config types: whoever reads a key declares it

[`packages/rman/src/interfaces/rman-config.interface.ts`](../../packages/rman/src/interfaces/rman-config.interface.ts)
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
  in `src/commands/*.command.ts`, so `index.ts` imports [`src/commands.ts`](../../packages/rman/src/commands.ts)
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
  [`packages/rman/src/builtins`](../../packages/rman/src/builtins/platforms/node/augmentation/rmanrc.augmentation.ts),
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
  - **Unset, the lockfile decides** (`CiService.detectPackageManager`): the nearest directory from
    the package up to the repository root holding one, `npm-shrinkwrap.json` counting as npm. Order
    is flag > `packageManager.node` > lockfile > npm, for `ci`, `publish` and `info` alike.
    **`deps` is the exception, lockfile first** (`NodeDependencyUpdater.installer`): its two
    questions - does it install, what does the installer let in - are the installing tool's, and
    `packageManager.node` also names who *publishes*. `panates/opra` installs with pnpm and sets
    `node: npm` for npm's provenance, so `verify` ran `npm install --dry-run` on a pnpm workspace,
    failed `EUNSUPPORTEDPROTOCOL` on `workspace:^` and put the whole upgrade back.
    - **`package.json#packageManager` is not read, and this repository is why**: its root says
      `yarn@3.4.1` beside a `package-lock.json` and no `yarn.lock`. A declaration nothing checks
      goes stale; the lockfile is what the last install wrote.
    - **Two managers' lockfiles in one directory are refused, not ranked** - naming both and the
      setting. A ranking is a silent pick, and `ci` then wipes the evidence: it deletes every
      lockfile before installing, so the next run sees only what the guess wrote. `info` reads the
      pair as no answer instead of failing, since it is what you run to find out what is wrong.
    - **`ci` must resolve before it wipes**, and does (`reinstall`'s first line). The end-to-end
      spec asserts the `pnpm-lock.yaml` is gone *and* pnpm ran, which is the only pair that proves
      the order - controlled by making the resolver ignore the lockfile, which turns it and three
      service cases red.
    - **The walk stops at the repository root**, so a checkout nested inside another project never
      installs with the outer one's tool.
    - **`rman install` / `rman i` is the same resolution with nothing wiped** (`CiService.install`,
      `installArgv`): one install at the root, so a repository's tool need not be known to install
      it. Its flags are the ones npm and pnpm share, spelled once and translated per tool from one
      table (`INSTALL_FLAGS`), each spelling read off that tool's own `install --help` - a flag with
      no checked spelling is refused before anything runs, never guessed. `--frozen-lockfile` is
      `npm ci` under npm, the one way it deletes anything: npm has no frozen install that keeps
      `node_modules`, and refusing the flag would leave CI unable to say it without knowing the
      tool. yarn gets `--frozen-lockfile` alone - berry's `install` has no production, offline,
      dry-run or registry flag. No positional package: `npm install <pkg>` is `pnpm add <pkg>`.
    - **It is what made `deps -u` print `Not verified: "pnpm"` in pnpm repositories**, which had been
      silently verified with npm's resolver until then. So `verify` asks pnpm now
      (`NodeDependencyUpdater.verifyWithPnpm`): `pnpm install --dry-run --strict-peer-dependencies`,
      measured on pnpm 12.10.1 - plain `--dry-run` exits 0 on a peer conflict, strict exits 1 with
      `ERR_PNPM_PEER_DEP_ISSUES`, neither writes anything, and a workspace member's conflict comes
      back from the root under its own heading.
      - **Only an issue one of the run's moves is part of counts** (`written`, recorded by
        `applyPlan`). Strict is stricter than the repository, and without the filter a repository
        living with one peer warning could never upgrade anything. Controlled: removing the filter
        turns the "repository's own" spec red.
      - **The peer is held before its requirers** - the move that answers "the peer outgrew them".
        Holding both would cost a move that was fine.
      - **pnpm below 11.8 is not asked** (`pnpmDryRunSince`, from the 11.8 release notes): no older
        pnpm was measured, and the bad guess about an unknown flag is a real install. pnpm 12 is a
        Rust binary answering `error: unexpected argument`, so matching an error text was never an
        option either.
      - `pnpm()` is the one spawn and the spec's seam, like `fetchReleases` - a stub on PATH would
        lose to a real pnpm beside `node`, the trap `appWithStubBin` records.
      - **A `Wanted:` range is quoted only when it holds a space.** opra's came back as a bare
        `^5.112.0:`, the parser wanted quotes, and the issue ended before its requirers - nothing
        could be blamed for it.
    - **pnpm's `minimumReleaseAge` is `deps.minAge`'s default in a pnpm repository**
      (`applyReleaseAge`), with `minimumReleaseAgeExclude` honoured. Reported from `panates/opra`:
      `deps -u` wrote `@nestjs/*@12.3.2` (21 h old) and `postgrejs@3.14.1` (1 h), and the next plain
      `pnpm install` **did not refuse them** - it appended all seven to `minimumReleaseAgeExclude`
      in `pnpm-workspace.yaml` with one line of output, so the supply-chain check was switched off
      for exactly those releases and surfaced only in a commit diff.
      - **Read, never restated**: `pnpm config get <key> --json` (workspace file, user config,
        environment). It answers `null` for pnpm's built-in default, which is therefore a constant -
        **1440 minutes, measured on 12.10.1** (a 22 h release was exempted, a 25.7 h one was not),
        assumed for every pnpm ≥ 11 and none below. No older pnpm was measured.
      - An explicit `deps.minAge` or `--min-age` replaces it, exclusions included - someone decided.
      - The check is now fractional (`minutes < rule`), which is the same answer as the old
        `floor(days) < minAge` for every whole-day `minAge`.
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
