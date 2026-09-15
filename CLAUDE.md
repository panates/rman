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

## Change and release detection

Three separate questions in rman look like "what changed". They are answered from different
sources and are **not** interchangeable. Before touching a command, establish which one it answers.

| | Question | Criterion | Commands |
| --- | --- | --- | --- |
| **A** | Which packages have **changed** since their last release? | the package's last release tag + commits after it whose files fall under that package | `changed`, `version`, `changelog` (+ `publish --target github`, for release notes only) |
| **B** | Which packages' current version is **not on the target yet**? | the target's own registry (branches per package) | `publish` |
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

### `changelog`

- **Question A.** The boundary is auto-detected per package via `detectChangeHash` by default;
  `--from <hash>` bypasses that entirely and applies identically to every package.
- **Trap:** run *after* a tag has been created, auto-detection finds that new tag and reports
  nothing changed. Hence: in CI, release notes are generated **before** `version`; and any code path
  running after the tag exists (`version --changelog`, `publish --target github`) passes the boundary
  **explicitly**. Do the same for any new note-generating path.
- Skips a `.rmanrc "publish.skip"` package by default; `--include-skipped` brings it back.

### `publish`

- **Question B.** Each target asks its **own** registry whether this version is already out there:

  | Criterion | Source | Opt-in? | Service |
  | --- | --- | --- | --- |
  | **b-1** npm-targeted packages | `npm view <name> version` == local `package.json` version | No (opt out via `private`/`target`) | `PublishService` |
  | **b-2** docker-targeted packages | `docker manifest inspect <image>:<version>` | Yes | `DockerPublishService` |
  | **b-3** github-targeted packages | a GitHub Release exists for that version's tag | Yes | `GithubReleaseService` |

- **Never looks at whether `version` ran** - deliberately. It only inspects what's on disk and on the
  registry, so it behaves the same right after a bump or days later. Re-running is safe.
- In CI, gate the release pipeline on **this** plan, not on `changed`.
- A new target follows the same shape: opt-in, its own `.rmanrc` config block, its own
  "already there?" check, `getPlan`/`applyPlan`, and an injectable `Deps` check so tests stay offline.
- `.rmanrc "publish.skip"` excludes a package from **every** target.
- The one A-flavored part: `--target github`'s `applyPlan` builds the release body via
  `ChangelogService`. The split is clean - B decides *which package ships*, A decides *what the notes
  say*.

### `list` / `run`

- **Question C** (`Repository.listStatus`): `dirty` (uncommitted) / `committed` (`git cherry` -
  committed but not pushed) / `clean`.
- Meant for the development loop ("only build/test what I touched").
- **Never use it for release decisions.** After a push `git cherry` is empty and everything reads
  `clean`, which does not mean there is nothing to publish.

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
