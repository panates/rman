# Change and release detection, release identity

Design decisions moved out of `CLAUDE.md`. Covers Questions A / B / C, `ChangeHashService`, tag patterns, why `changed` is gone, the repository's calendar release version.

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

## `ChangeHashService.detect` - the single boundary source for A

[`packages/rman/src/services/change-hash.service.ts`](../../packages/rman/src/services/change-hash.service.ts).
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

## `changelog.tagPattern` has no fixed default - it is derived from the group count

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
- **`groupKeyOf` is in [`utils/version-group.ts`](../../packages/rman/src/utils/version-group.ts) and
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

## `changed` was removed - `version --json` is the machine-readable plan

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

## Release identity (repo-level)

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
