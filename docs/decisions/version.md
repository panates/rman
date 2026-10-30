# `version`

Design decisions moved out of `CLAUDE.md`. Covers `VersionPlanService`, `VersionService`, cascade, `dependentRanges`, carried packages, stamping.

## `version`

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
- **`.rmanrc "version.dependentRanges": keep` is the one key that narrows a release, and it does it
  through the range rather than through `cascade`** (`VersionPlanService.rangeVerdict`,
  `checkKeptRanges`, `VersionService.raiseKeptFloors`; npm's half is
  `NodeManifestProvider.referencesTo`). Asked for by `panates/syncbridge`: nine extensions declare
  `"@syncbridge/common": ">=1.1.0 <2"` so a release of `common` need not release all nine, and
  `rewrite` turned the range back into `^1.2.0` and released them anyway.
  - **A range that accepts the new version takes the dependent out of both the in-group cascade and
    the cross-group ripple; one that refuses it is moved to its shape's next window**
    (`NodeManifestProvider.moveRange`: `^1.1.4` -> `^2.0.0`, `>=1.1.0 <2` -> `>=2.0.0 <3`) and the
    dependent is released as under `rewrite`. Only a shape with no single window (`||`, a hyphen
    range) is an `'error'` row, naming field, range and version. That is why it does not contradict
    "a floor, never a ceiling": the floor protects a dependent's published range, and here the range
    is checked rather than assumed.
    - **It refused every out-of-range version at first, and that was measured wrong on
      `panates/syncbridge`**: `@syncbridge/common` went 1.1.4 -> 2.0.0 and four packages of its own
      group - each already planned for 2.0.0 - were refused for `^1.1.4`. A range that no longer
      accepts its sibling has to change whatever the setting says; `keep` is about the ones that
      still do. A `publish.skip` package's moved range rides the root's sync commit.
  - **The lower bound is raised only when the dependent is released for changes of its own** - the
    user's point, and the only moment the dependent can have started relying on something new.
    Raising it on every dependency release was weighed and is meaningless: a range changes nothing
    for consumers until the dependent is republished, and republishing is `rewrite`.
  - **A prerelease neither fails nor raises a range** - otherwise every beta of `common` would fail
    nine extensions, and a stable range floored on a beta installs for nobody on stable releases.
  - **Every kept package is checked, a `publish.skip` one included**: npm workspaces link a sibling
    only while the range accepts its version, and otherwise install it from the registry.
  - The cost, stated: a dependent that bundles its dependency keeps shipping the older code until
    it is released itself. Not the default for that reason.
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
- **A package kept out of publishing takes no version** (`VersionPlanService.notVersionedReason`):
  `publish.skip`, or every target that ships it leaving it out (npm's `private`, asked through the
  same `skipReasonFor` `publish` and `list` use). It is a `'skip'` entry - no `to`, no tag, no
  changelog - and it neither ripples nor is rippled into across groups. `version.skip` decides first,
  both ways: `true` holds back a package that publishes, `false` versions one that does not.
  - **This said the opposite until the user reversed it**: "a package that is never published can
    still be meaningfully versioned". Measured on `panates/syncbridge`: fourteen `publish.skip`
    packages bumped, tagged and written into changelogs every release - tags with nothing on the
    registry behind them, and a version line that had jumped by the time publishing came back on.
  - **A package no target ships to is still versioned.** Read as "not published" it stopped every
    package of a repository with no publish target at all - one that versions with rman and
    publishes by other means - which was most of the core's own spec fixtures (measured, 40 red).
  - **`'skip'` is never rippled into**, which also closed a quieter hole: a package excluded by
    `--ignore-dirty` could be bumped back in by a dependency in another group.
  - **But its commits count for the published packages that carry it** (`bundledPackages`,
    `utils/bundled-packages.ts`): a published package's run-time in-repo dependencies that take no
    version, transitively, stopping at a versioned one. Measured on `panates/syncbridge-cloud`: the
    Docker-only server bundles four `publish.skip` packages, a fix to `services` (a348f94f) left it
    `no-change`, and the image would never have shipped the fix. The 2.22 rule above was made
    without that case in view.
    - **Run-time edges only** (`ManifestProvider.runtimeDependencies`; npm: `dependencies`,
      `optionalDependencies`, non-optional peers). `Package.dependencies` includes `devDependencies`,
      and a dev edge would release every library on each change to an unpublished test helper.
    - **One rule, four readers**: the planner's commit attribution and dirty check, the changelog's
      attribution, and the dirty check of each publish target (`filesOwnedBy`). Any one left on the
      package's own directory reopens the gap one step later - a release for a fix its notes never
      mention, or an image built from a carried package's uncommitted changes.
    - `unversionedReason` moved out of the planner for the reason `groupKeyOf` did: the changelog
      asks the same question and must work with no planner registered. `notVersionedReason` stays
      `protected` and delegates.
    - **`.rmanrc "carries"` names what no manifest says** (`declaredCarries`, top level beside
      `dependencies`, the same name-or-directory reading through `Repository.resolveDeclaredPackage`).
      Reported on `syncbridge-io/syncbridge`: the engine image takes `web-ui/dist` through
      `publish.docker.buildContexts`, two `web-ui` commits changed the image, and `version` answered
      "Nothing to version". Deriving it from `buildContexts` was weighed - no second statement, no
      drift - and set aside on the user's call for one list a reader can see; the cost is that the two
      can disagree.
      - **A versioned package listed there is carried too**, unlike the manifest walk: a build
        context is no dependency edge, so no cascade reaches the carrier and stopping there would
        reopen the gap. The spec for it uses a manifest field that is no dependency (`config`) - with
        the fixture's `devDependencies` edge the cross-group ripple bumped the carrier anyway, and
        the case passed with `carries` removed (measured).
      - **An unknown entry throws**, where `dependencies` ignores one: a missing edge changes no
        graph answer, a missing carry is the silent non-release this key exists to end.
    - **The alternative was versioning them** (`version.skip: false`, which works today): tags and
      changelog entries for packages nothing publishes, exactly what the 2.22 rule removed.
- When folding the changelog into the bump commit (`--changelog`, or `.rmanrc "version.changelog"`)
  it passes `ChangelogService` an **explicit** boundary: the pre-bump tag (`expandTag(pkg,
  entry.from)`). It cannot be left to auto-detection - see the trap below.
- **A release commit names its packages once the repository has more than one version line**
  (`VersionService.buildCommitMessage`): `chore(release): <name>@<version>, ...` instead of
  `chore(release): v{version}`, and `version.commitMessage` takes `{name}` beside `{version}`.
  Reported from `syncbridge-io/syncbridge-extensions`: nine solo lines, nine commits per release all
  reading `chore(release): v2.1.0`. Keyed on `versionLineCount`, the question that makes the tag
  `{name}@*`, so one-line repositories keep their message. The listing is the shape
  `isReleaseCommit` already matched for a cross-group ripple, so history needed no new matcher.
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
