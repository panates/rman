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

[`src/core/config.ts`](src/core/config.ts). One rule decides it, and it is not the usual cascade:

- **Unmarked keys configure the package of the directory that declares them.** The repository
  root's own `.rmanrc` therefore configures the *root package* - which is where every repo-wide
  setting is read from anyway (`packageManager`, `allowBranch`, `version.*`, `githubRelease.*`).
- **A `"[selector]"` block configures the packages it names** - `"[*]"`, `"[*-dialect]"`,
  `"[pkg-a]"`. This is the only way a directory speaks about anything but its own package.
- A directory holding no package (an intermediate `packages/`) has none to speak for, so its
  unmarked config still cascades to everything below.

**Never restore the old "root config is every package's baseline" cascade.** The same key means
different things to the two audiences, and conflating them is a measured bug, not a hypothetical:
`run.build.after` on a package is that package's hook, run in its own directory; on the root it is a
repo-wide bookend run once at the repository root. One declaration feeding both ran
`node ../../support/postbuild.cjs` at the root, where it cannot resolve.

- Selector patterns are **globs over package names**, anchored both ends (`"[*-dialect]"` does not
  match `my-dialect-helper`) - glob, not regex, like every other pattern in rman. `"[*]"` is
  whatever `getPackages()` returns: not the root in a monorepo, the root itself in a single-package
  repo.
- Precedence, lowest first: `"[*]"` → other selectors in declaration order → the package's own
  unmarked config. Directory levels closer to the package still win.
- **Trap: in YAML the quotes are mandatory.** A bare `[*]` is a flow sequence and `*` an alias
  indicator - the file fails to load. Write `"[*]":`.
- Any string value may embed `${{ ... }}` - **real JavaScript**, evaluated per package
  (`interpolateConfig`), in **every** string, so there is neither a list of "interpolated keys" nor
  a growing list of substitutions to memorize. Scope: `pkg`, `repository`, `env`, `semver`.
  - `pkg` and `repository` share one shape, because the repository root **is** a package: `name`,
    `scope`, `unscopedName`, `version`, `basename`, `dirname`, `relativeDir`, `json`. `basename` is
    the *directory*, `name` the package - sqb's root is `sqb.v4` in a directory called `sqb`.
  - `repository` adds `monorepo`, `packages`, `package(name)`, and `git.{branch,sha,shortSha,dirty}`
    - the last **lazily**, since every command resolves config and most never mention git.
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
    itself from `pkg.rawConfig` with it bound. Naming it elsewhere fails at load, on purpose.
    - **Trap: the unbound binding is a non-enumerable throwing getter, and both words matter.**
      Enumerable, it fired on the `{...}` spread inside `_repositoryScope` - so *every* command
      died building its scope (measured). Not a getter at all, it would hand back `undefined` and
      put an `app:undefined` somewhere plausible.
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

## Config inheritance: `extends` and `+key`

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
  - An inherited unmarked key still configures the inheriting directory's package, not the packages
    below. The rule doesn't bend for a base; a shared config aimed at packages writes `"[*]"`.
- **`+key`** appends instead of replacing, through the single `mergeConfig` every layer uses.
  Scalars promote to lists; on an object the prefix is ignored (objects already merge); `key` and
  `+key` together apply replacement first.
  - **Trap: an append must stay outstanding until something to append to exists.** Resolving it
    eagerly passes unit tests and is wrong: a directory's own file forms merge into an *empty*
    object long before the selector blocks and parent directories they append to, so collapsing
    `+key` there silently discarded them (measured - a package appending to both `"[*]"` and
    `"[*-dialect]"` kept only its own step). `finalizeConfig` collapses whatever is still
    outstanding once the chain ends, and only then.
- **The schema cannot spell "declared keys plus an append"**, so `+key` is allowed by a
  `^\+.+$` pattern and `+befor` validates. The TS side covers it: `WithAppend<T>` generates the
  append form for every key by remapping, so nothing drifts and typos are caught there. Both are
  pinned by [`test/schemas/rmanrc.schema.spec.ts`](test/schemas/rmanrc.schema.spec.ts), which also
  asserts every closed object carries the append pattern.

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

### `detectChangeHash` - the single boundary source for A

[`src/utils/change-hash.ts`](src/utils/change-hash.ts). Every command asking A calls this; no
command reimplements its own tag lookup. In order, first match wins:

1. **An explicit `from`** (anything but `"npm"`) is returned as-is and applies identically to every
   package. No detection runs at all.
2. **The package's own latest release tag** (`findLatestTag`), pattern from `.rmanrc
   "changelog.tagPattern"`:
   - Pattern contains `{name}` (e.g. `{name}@*`, independent versioning) → `git tag --list`, highest
     by version. Reachability is irrelevant; the tag already belongs to that package.
   - Pattern has no `{name}` (the default `v*`, one repo-wide tag) → `git describe`, i.e. the nearest
     tag **reachable from HEAD**. No single package owns a repo-wide tag, so ancestry is the right
     criterion.
3. **No tag → npm fallback.** The version from `npm view <name> version` is turned into a tag name
   via `expandTag` and used only if **that tag actually exists in git**. The one real scenario it
   covers: a tag exists but isn't in HEAD's ancestry (release cut on another branch, rewritten
   history, shallow clone). With no tag in git at all this step resolves nothing either. **This is
   not a "has it been published" check** - it only borrows a version string to guess a tag name, and
   never compares against the local `package.json` version (that is B's job).
4. **`catchUpFile` (a changelog file), if given and present** → the result is merge-based with that
   file's own last-modifying commit, **widening** the boundary backwards. Purpose: if the changelog
   stalled at 1.1.0 while 1.5.0 shipped, the versions in between aren't silently skipped. With no
   tag, the file's commit is used alone.
5. **Nothing matched → `undefined`** → nothing has ever been released, so callers treat the whole
   history as unreleased (`listAllCommits`). `version` and `changelog` agree here deliberately -
   "not yet pushed" would read as empty the moment a first release is pushed, and for a repo with
   no remote at all.

Tag naming also has a single source: `expandTag` (forward: version → tag name) and `findLatestTag`
(backward), both in that same file. Don't build a tag name anywhere else.

A commit counts toward whichever package's directory its files fall under. `VersionService` does
this directly (`belongsToPkg`); `ChangelogService` additionally attributes "repo-wide" commits -
those touching more than half of all packages - to the root instead of repeating them in every
package (`ownersOf`/`BROAD_COMMIT_THRESHOLD`). Version bumping makes no such distinction: every
touched package counts as changed.

### `changed`

- **Question A.** `VersionService.getPlan` filtered to `status === 'bump'`; writes nothing.
- Takes its boundary from `detectChangeHash`. **Never queries any registry.**
- **Empty output does not mean "nothing to publish"** - it means "no package needs a new version".
  Don't gate a CI release pipeline on it; that decision belongs to B (`publish`).

### `version`

- **Question A**, from the same plan `changed` shows (`VersionService.getPlan`).
- Severity comes only from commit messages: `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING
  CHANGE:` → major, non-conventional → patch. The single-commit escape hatch is a `Release-As:`
  footer. Never add a fixed `bump` input to CI - it would apply identically to every future run.
- **Never consults `.rmanrc "publish.skip"`.** A package that is never published can still be
  meaningfully versioned.
- When folding the changelog into the bump commit (`--changelog`, or `.rmanrc "version.changelog"`)
  it passes `ChangelogService` an **explicit** boundary: the pre-bump tag (`expandTag(pkg,
  entry.from)`). It cannot be left to auto-detection - see the trap below.
- Writes more than `package.json`: a bumped package's Dockerfile
  `org.opencontainers.image.version` label is rewritten to the new version and folded into the
  **same commit** (`stampVersionLabel`). Keep it here, not in a build script - the label is by
  specification the version of the packaged software, so `version` is the only thing that knows
  it, and a build-time rewrite leaves the edit uncommitted (`publish` then reads a dirty tree) and
  records a stale label in the commit that was actually tagged. Reads the same path
  `DockerPublishService` builds from (`publish.docker.dockerfile`), never a second guess at it.
  Never *inserts* a label - which labels an image carries is the author's call. The same pass
  rewrites the `version` constant in every file `.rmanrc "version.stamp"` lists
  (`stampVersionConstant`). **Stamp the source, never the build output**: rewriting
  `build/constants.js` from a build script leaves the checked-in file on a placeholder, so anything
  running from source reports it, the tagged commit never records the released version, and the
  rewrite has to be redone every build.
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

### `publish`

- **Question B.** Each target asks its **own** registry whether this version is already out there:

  | Criterion | Source | Opt-in? | Service |
  | --- | --- | --- | --- |
  | **b-1** npm-targeted packages | `npm view <name> version` == local `package.json` version | No (opt out via `private`/`target`) | `PublishService` |
  | **b-2** docker-targeted packages | `docker manifest inspect <image>:<version>` | Yes | `DockerPublishService` |
  | **b-3** the repository itself (see `github-release`) | a GitHub Release exists for the repository's release tag | n/a - never optional | `GithubReleaseService` |

- **Never looks at whether `version` ran** - deliberately. It only inspects what's on disk and on the
  registry, so it behaves the same right after a bump or days later. Re-running is safe.
- In CI, gate the release pipeline on **this** plan, not on `changed`.
- A new target follows the same shape: opt-in, its own `.rmanrc` config block, its own
  "already there?" check, `getPlan`/`applyPlan`, and an injectable `Deps` check so tests stay offline.
- `.rmanrc "publish.skip"` excludes a package from **every** target.
- `publish.target` is about **package distribution only** - which registry a package's artifact
  goes to. `"github"` as a value would read as *GitHub Packages* (`npm.pkg.github.com`), which is
  what it will mean if it is ever added; it must never again mean the repository's GitHub Release.

- **Publishing from a build directory** (`publishConfig.directory` > `.rmanrc "publish.directory"` >
  `--contents`): the manifest in that directory is **generated by `publish`**, at publish time, and
  is deliberately unconfigurable. Removed from the copy: `devDependencies`; every `scripts` entry
  except `preinstall`/`install`/`postinstall` (the only ones a consumer's install runs - dropping
  those would silently break every native-module package); `private` (publish refuses a private
  package anyway); `publishConfig.directory` (it pointed *here*). `"workspace:"` ranges are resolved
  in it, and it is deleted again afterwards.
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

### `list` / `run`

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

## A repository's own commands (`.rman/*.mjs`)

[`src/core/custom-command.ts`](src/core/custom-command.ts). A module there becomes `rman <its file
name>`, built with `defineCommand` (the `defineConfig` pattern again). `handler(context, args)` -
`context` is an **object** (`repository`, `package`) precisely so later additions don't break
commands already written against it; `context.package` is `Repository.currentPackage`, so
`undefined` at the root.

- **Scope boundary, and state it when documenting either side:** `.rman/*.mjs` is for *one*
  repository-level operation with logic of its own; a shell step across every package is
  `run.<script>`, which already owns the scheduling, topological order, `bail` and progress panel.
  A loop over packages written inside a command module reimplements all of that and loses it.
- **A broken module warns and is skipped; a name clash throws.** Not an inconsistency: a module
  that fails to load affects only itself, while `rman publish` resolving to two different things
  has no safe guess. Both name the file and the reason.
- `BUILT_IN_COMMANDS` in [`src/cli.ts`](src/cli.ts) is hand-maintained (yargs exposes no such list)
  and pinned by a test against the `command:` strings in `src/commands/*.command.ts` - so adding a
  command can't quietly leave a repository's own able to shadow it.
- No `.rman` directory means no scan and no imports. Every `rman` invocation runs this, `info`
  included, so that has to stay true.

**Trap: a setup failure used to exit 0.** `runCli`'s top-level catch printed the message and
swallowed it, so `rman info` in a directory with no `package.json` reported failure on stdout and
success to the shell (measured, and true of the published 1.0.10 too). It rethrows now, and the
entry point exits 1. Any new throw path before `parseAsync` inherits that - keep it that way.

## API docs baseline (docs/api.md, docs/api/*.md)

`docs/api.md` starts with an HTML comment block (`docs-baseline`) recording the git commit,
package version, and date the API docs were last verified against source - see that block for
the exact format and the `git diff <commit>..HEAD -- src/` command it documents.

Rules:
- Whenever you write or update these API docs, record (or update) that baseline block with the
  commit you verified against - so a later session can diff from a known point instead of
  re-reading everything from scratch.
- Before trusting/updating the docs, diff `src/` (and `test/**/*.spec.ts` for examples) between
  the recorded commit and `HEAD` to see what actually changed, then update only the affected
  doc section(s) - don't regenerate everything unless the diff is broad enough to warrant it.
- After updating, bump `git-commit`/`package-version`/`date` in the baseline block to the new
  `HEAD` (only once the docs are verified accurate as of that commit).
