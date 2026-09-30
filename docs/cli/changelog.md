<!-- verified against commit c810d62 - see ../cli-rman.md for the baseline convention -->

# `rman changelog`

```
rman changelog [options...]
```

Generates a changelog per package from unreleased commits, grouped by
[Conventional Commits](https://www.conventionalcommits.org/) type - ✨ Features, 🐛 Bug Fixes,
⚡ Performance and Optimizations, and a section for every other standard type - on a best-effort
parse. Prints to stdout by default; `--write` prepends into each package's own `CHANGELOG.md`
instead.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--from <hash>` | - | string | Generate the changelog since this commit/hash, applied the same way to every package. Overrides everything below. Default (also `"auto"` explicitly): with `--write`, [where the file left off](#--write-picks-up-where-the-file-left-off); otherwise auto-detect per package from its own most recent release tag - the same one `version` uses, so they never disagree; failing that (no tag yet), from the version its own ecosystem's registry reports; failing that too (never released at all), the package's whole history. |
| `--write` | - | boolean | Prepend the generated entry into each package's own changelog file instead of printing it. |
| `--file-path <path>` | - | string | With `--write`, the file to prepend into, relative to each package's own directory. Default `"CHANGELOG.md"`, or `.rmanrc "changelog.filePath"`. |
| `--from-root` | `-r` | boolean | Generate for the whole repository even when standing inside one package's own directory (which otherwise scopes it to just that package). No effect elsewhere. |
| `--include-skipped` | - | boolean | Also generate for a package with `.rmanrc "publish.skip"` - excluded by default. |
| `--no-commit-hash` | - | boolean | Leave each commit's short sha off its line. On by default; GitHub autolinks a bare abbreviated sha wherever it renders Markdown inside the repository, so `(a1b2c3d)` is a link on the page and stays readable in a terminal. Turn it off for notes read somewhere else. Also `.rmanrc "changelog.commitHash"`. |
| `--no-unreleased` | - | boolean | Leave out the entry for commits that are not released yet - a changelog of released history only. On by default; also `.rmanrc "changelog.unreleased"`. |
| `--rebuild` | - | boolean | Regenerate each changelog file from the whole history instead of appending to it. Implies `--write`, ignores the file's own marker, and replaces what is in the file rather than prepending - for a repository changing its changelog layout, or one whose files drifted. |
| `--no-progress` | - | boolean | Leave off the live progress panel. On by default, and auto-disabled when stderr is not a TTY. The panel is drawn on **stderr**, so `rman changelog > NOTES.md` still gets clean notes. Also `.rmanrc "changelog.progress"`. |
| `--group-by <what>` | - | `package` \| `group` | What one changelog file covers. `package` (default) is one file per package; `group` is one file per set of packages that releases together, written at the repository root. Also `.rmanrc "changelog.groupBy"`. See [One file per package, or one per release](#one-file-per-package-or-one-per-release). |
| `--starting-at <ref>` | - | string | Where this package's changelog begins - a version or release tag (inclusive), a `YYYY-MM-DD` date, or a commit. Releases older than it are left out. Also `.rmanrc "changelog.startingAt"`. See [Where a changelog begins](#where-a-changelog-begins). |
| `--release-version <v>` | - | string | The version these notes are **for** - what the entry heading shows. Default: read back from each package's own latest release tag, which is only right once that release is tagged. Pass it when generating notes ahead of the bump (e.g. from `changed --json`), otherwise the heading shows the *previous* release. |

## Examples

```bash
rman changelog                              # auto-detects each package's own last release
```

```
Detecting each package's last release...
## pkg-a 1.3.0 (2026-09-12)

### ✨ Features

- add a new option

### 🐛 Bug Fixes

- correct a typo
```

```bash
rman changelog --from a1b2c3d               # since a specific commit, for every package
rman changelog --write                      # prepend into each package's own CHANGELOG.md
rman changelog --write --file-path docs/CHANGELOG.md
rman changelog --from-root                  # whole repo, even from inside one package's directory
rman changelog --scope pkg-a
rman changelog --scope /                    # the root package's own entry, and nothing else
```

`changelog` is one of the two commands whose candidate list holds the repository's own root package
(the other is [`clean`](clean.md)), so **`--scope /` means something here** - it selects the root's
entry, which is where commits under no package, and repo-wide ones, are attributed. See
[package filtering](../cli-rman.md#package-filtering); an ordinary glob never matches a monorepo's
root (in a single-package repository the root *is* the one package, so it does).

With `--write`, prints `updated <label> <filePath>` per package that had something to write,
instead of the entry's raw content. With nothing unreleased at all, prints `No unreleased
changes.`.

## `--write` picks up where the file left off

An append has to start where the last one stopped, or it is not a complete record of anything. So
`--write` takes its boundary from the **changelog file**, not from the package's last release tag:

| The file | Where the notes start |
| --- | --- |
| carries rman's marker | that commit |
| does not exist | the **whole history** - nothing has been documented yet |
| exists without a marker | ordinary tag detection, widened backwards to the file's own last commit |

rman records where it stopped in the file itself, as an HTML comment that renders as nothing:

```markdown
# Changelog

<!-- rman:documented-up-to 9f3c1ab... -->

## pkg-a 1.1.0 (2026-09-25)
...
---

## pkg-a 1.0.0 (2026-09-24)
...
```

There is **one** marker per file, rewritten on each write rather than accumulated.

## Rebuilding a file from scratch

`--write` appends: it starts from the marker the last write left in the file, which is what keeps a
second run from re-listing what is already there. `--rebuild` does the opposite - it ignores that
marker (and the file's own last-modifying commit), reads the whole history, and **replaces** the
file rather than prepending to it:

```bash
rman changelog --rebuild
```

It implies `--write`, because there is nothing else it could mean. Use it when the shape of the
file changed rather than its contents - switching `changelog.groupBy`, renaming a section through
`changelog.titles`, or setting `changelog.startingAt` for the first time - and when a file has
drifted from what the history says.

A file this run produces no entry for is **left alone** rather than emptied: a rebuild replaces
what it can regenerate, and a package with nothing to say still keeps whatever is in its file.
An explicit `--from` still wins, since that names a boundary for this run rather than one read back
off disk.

**It reads the entire history, which is not free.** Measured on `panates/sqb` (1825 commits): the
boundary detection is the fast half at ~1.2s for 18 targets, since those run concurrently; reading
and parsing the commits runs one target at a time, and a full rebuild there takes minutes.
`changelog.startingAt` floors which releases are *written*, not how far back the history is read.

## One file per package, or one per release

By default every package gets its own `CHANGELOG.md`. For a repository whose packages release
**together** that is usually the wrong unit: they all bump on one version, so most of them have no
commit of their own and their file only ever says "Updated dependencies" - and nowhere in the
repository says what the release as a whole contained.

`changelog.groupBy: 'group'` makes the unit a **release group** instead - the same `.rmanrc group`
key `rman version` batches its plan by:

```yaml
group: true # every package releases together, on one version line

changelog:
  groupBy: group # so they share one changelog, at the repository root
```

| `group` | Where its changelog goes |
| --- | --- |
| `true` (the default group) | `CHANGELOG.md` at the repository root |
| `'core'` (a named group) | `CHANGELOG-core.md` at the repository root |
| `false` | `CHANGELOG.md` in that package's own directory |

That last row is the same rule as the other two, not an exception to them: `group: false` already
makes a package a group of itself, so a solo group's home is its own directory. A repository with
independent versioning therefore sees no change at all.

A group's entry holds every commit belonging to **any** of its members, listed once each - a commit
touching two of them is one line, not two. Its heading names the release rather than a member: a
repo-wide tag (`v1.2.0`) is already the right heading and is used as-is, while under `{name}@*` -
where the tag would be one member's `pkg-a@1.2.0` over a file describing all of them - the group's
own name carries it (`## core 1.2.0`).

**A named group is written into a file name**, so it is limited to 15 characters of letters, digits,
`.`, `-` and `_`, starting with a letter or digit. Anything else is refused when the config is read,
naming the package that declared it - rather than escaped into a file name the repository never
asked for.

`rman version --changelog` follows this too, making one call per file rather than one per package,
and folds the group's changelog into that group's own release commit - so `git show <tag>` carries
the notes for the release that tag names.

### Migrating a repository that already has per-package files

Turning this on does not move or merge what is already there: the per-package files are simply no
longer written to, and the new root file starts from each group's last release. Delete the old ones
in the same commit as the config change, or leave them as the historical record - but do not leave
them *and* expect them to keep updating.

## One entry per release, not one per run

Whatever range the boundary opens up is **cut at every release tag inside it**, newest at the top,
each entry headed with that release's own version and date and ruled off from the next with `---`.
A range holding no tag is one entry, which is every ordinary run: the boundary *is* the last
release, so nothing falls inside it.

Where this shows is the backfill. A first `--write` in a repository with years of releases reaches
back through all of them, and without the cut every commit in every release lands under one
heading - measured on a real repository, twelve releases rendered as a single `v2.1.6` entry. With
it:

```markdown
## @panates/tsconfig v2.1.6 (2026-04-30)
...
---

## @panates/tsconfig v2.1.1 (2026-04-05)
...
---

## @panates/tsconfig v2.0.11 (2026-03-25)
```

A release tag sits on the **release commit**, which comes after the work it describes - so that
commit closes its segment and is then dropped from the list like any other release marker. It heads
the entry without appearing in it.

**The heading is the tag**, because the tag is what the entry describes. It used to be assembled out
of the package label and a version read back from the latest tag, which went wrong exactly where a
tag covers more than one package: the repository root was headed
`## panates-javascript repository 2.1.6 (2026-04-30)`, stating a version the repository does not
have - its root package is `panates-style` at `0.0.5`, and `2.1.6` came off the `v2.1.6` tag.

The commits after the newest tag are the **unreleased** segment, and it says so:

```markdown
## Unreleased — panates-javascript repository (2026-09-25)
```

Dated today, since that is when it is being written - it used to borrow the previous release's
number *and its date*, so the not-yet-released commits were headed by the release before them. The
package label stays in it because `rman changelog` prints every package's entry to one stream, where
three consecutive `## Unreleased` blocks would say nothing about which package each belongs to.
`--release-version` replaces it with the tag that release is about to get.

`{{title}}` is what the default template renders; `{{package}}`, `{{version}}` and `{{tag}}` are all
still bound, so a repository wanting the old shape writes its own `changelog.template`.

**Both halves of this were measured as bugs.** Taking the boundary from the release *tag* meant it
did not move between two writes, so a second run re-listed every commit since that tag on top of
the entry that already held them: one commit appeared twice, under two headings carrying the same
version number. And with no changelog file at all, the tag boundary documented only the commits
*after* the last tag - everything before it was never written anywhere, and never would be.

Running `--write` twice with no commit in between now says `No unreleased changes.` and leaves the
file byte-identical.

## Section headings (`changelog.titles`)

rman ships a heading for every **standard** Conventional Commits type, in this order:

| type | heading | | type | heading |
| --- | --- | --- | --- | --- |
| `feat` | ✨ Features | | `test` | 🧪 Tests |
| `fix` | 🐛 Bug Fixes | | `build` | 📦 Build System |
| `perf` | ⚡ Performance and Optimizations | | `ci` | 🤖 Continuous Integration |
| `revert` | ⏪ Reverts | | `chore` | 🧹 Chores |
| `refactor` | 🔧 Refactoring | | `style` | 🎨 Code Style |
| `docs` | 📚 Documentation | | `*` | 💬 General Changes |

There used to be three - `feat`, `fix` and the catch-all - and everything else landed in one heap.
Counted across four repositories of this project's own organization, that heap held 194 `chore`, 86
`docs`, 68 `refactor`, 29 `test`, 27 `ci` and 24 `perf`: more commits than the two named types put
together, under a heading saying only "not one of those two".

**These add sections; they hide nothing.** That is the one place this parts from
conventional-changelog, whose default preset silently drops `chore`, `ci`, `build`, `style` and
`test` - a changelog quietly missing a third of the history.
[`ignoreTypes`](#configuration-rmanrc-changelog) is the key that drops a type, and it stays the only
one that does.

A type rman does not name - `dev`, `bench`, whatever convention a repository invented - still goes in
the catch-all until you give it a heading. `changelog.titles` maps a type to the heading it is listed
under, and with it the order the sections come out in:

```yaml
changelog:
  titles:
    feat: New Features
    dev: Development Changes
```

```markdown
### New Features
- a new capability

### 🐛 Bug Fixes
- **parser:** handle empty input

### Development Changes
- rework the harness

### 🧹 Chores
- bump deps
```

Each bullet ends with its commit's short sha, which GitHub turns into a link wherever it renders
Markdown inside the repository. `--no-commit-hash` (or `.rmanrc "changelog.commitHash": false`)
leaves it off.

**A message repeated inside one section is written once.** Real histories hold runs of identical
subjects - one of this organization's repositories had a release entry reading `Updated config` five
times - and the repetition states nothing the first line did not. The survivor keeps the earliest
commit's sha. Deduplicated *per section*, not per entry: `feat: x` and `fix: x` are different claims
under different headings, and collapsing those would lose a fact rather than a repetition.

| | |
| --- | --- |
| **Merged over the defaults, per key** | naming `dev` adds a section without costing you `feat` and `fix`; renaming `feat` leaves it where it was in the order. The same rule `vars` follows. |
| **Two types, one heading** | they share one section - `{ dev: Internal, chore: Internal }`. |
| **`'*'`** | the heading for every type nobody named, and **always rendered last** whatever position it was declared in: a catch-all in the middle would swallow the sections after it. A subject that is not Conventional Commits at all has no type to key off and lands there too. |
| **Order** | `sortTitles`, below. |

## Section order (`changelog.sortTitles`)

A list of commit **types**, in the order you want their sections:

```yaml
changelog:
  titles:
    feat: New Features
    dev: Development Changes
  sortTitles: [dev, fix, feat]
```

```
### Development Changes
### 🐛 Bug Fixes
### New Features
### 🧹 Chores
### 💬 General Changes
```

`chore`, which `sortTitles` did not list, keeps its default position after the three that were.

Separate from `titles` because they are two decisions: `titles` patches a heading's *wording*, so
letting it also decide position would mean renaming `feat` silently moved it.

- **A sort, not a filter.** A type you leave out keeps its place after the ones you listed;
  `ignoreTypes` is what drops a type.
- **Listing a type with no heading of its own does nothing** - there is no section to sort. It does
  not create one, and it does not drag the catch-all up to that position.
- **`'*'` is last however you list it**, for the same reason as above: a catch-all in the middle
  swallows the sections after it.

The cost, stated rather than hidden: a default section cannot be *removed* by leaving it out of
`titles`. [`changelog.ignoreTypes`](#configuration-rmanrc-changelog) is the key that drops a type
entirely, and it still wins - a type named here and ignored there gets no heading.

**The type prefix is stripped in every section now**, not only in Features and Bug Fixes. It used
to be, so "General Changes" read `- chore: bump deps` - the heading naming the type and the bullet
repeating it - while Features read `- a new capability`. With every type able to have a heading of
its own, that asymmetry has no defence left.

## Leaving the unreleased entry out

The commits after the newest tag get their own entry by default. `--no-unreleased` (or `.rmanrc
"changelog.unreleased": false`) drops it, for a changelog of released history alone - which only
became a thing to want once `--write` started backfilling.

**The default is the opposite of `auto-changelog`'s, on purpose.** That tool documents a finished
history, so its unreleased section is the unusual thing to ask for. Here it is the ordinary one:
`rman changelog` exists to answer what is not released yet, down to the message it prints when
there is nothing (`No unreleased changes.`). Off by default would make the common case need a flag.

**A release you have named is never dropped by it.** `--release-version` (which is how
[`version --changelog`](version.md) writes its entry, before it commits and tags) means the caller
is describing the release it is about to cut - the segment is "unreleased" only until the tag
exists. Without that guard, setting `unreleased: false` would leave every release documenting
nothing.

## Where a changelog begins

A first `--write` reaches back through every release there has ever been. For a package that has
shipped for years, most of that is not what a changelog is for - so `changelog.startingAt` (or
`--starting-at`) puts a floor under it:

```yaml
# packages/core/.rmanrc.yml - this package's changelog starts at 2.0
changelog:
  startingAt: '2.0.0'
```

One key, taking whichever form the answer naturally has. They are told apart in this order, because
the shapes overlap and a rule nobody can see is a trap:

| Form | Example | Meaning |
| --- | --- | --- |
| a `YYYY-MM-DD` date | `2024-01-01` | releases made on or after that day |
| a version or release tag | `2.0.0`, `v2.0.0`, `@scope/pkg@2.0.0` | that release and everything newer |
| a commit | `64e111b`, or any ref git resolves | the release that commit belongs to, and newer |

All three are **inclusive**: naming `2.0.0` keeps `2.0.0`. The one genuine collision is a tag whose
name is also hex (`deadbee`) - the tag wins, because a repository that named a tag has said what it
means. A value matching none of the three is refused, naming all three: read as "never below" it
would leave the changelog looking complete, and as "always below" it would empty it.

**The unreleased entry is never dropped**, whatever the floor says. The floor is about history;
hiding the commits that are not released yet would hide the very thing most runs are asking about.

**This is not `--from`**, though a commit-shaped value makes them look alike. `--from` is *this
run's* boundary and applies identically to every package; `startingAt` is a lasting fact about one
package, cascaded like any other config key, and still holds on the run after next.

## `{{date}}` is the release's date, not today's

The version in an entry heading is read back from the package's latest release tag, so the date
beside it is that tag's day. They used to come from different places - the version from the tag, the
date from the clock - so regenerating notes for an already-tagged release headed them with that
release's number and *today's* date: `## @panates/eslint-config v2.1.6 (2026-09-25)` for a v2.1.6
tagged days earlier. Two halves of one heading describing two different releases, and a file that
changed every time it was regenerated.

Today's date is still what `--release-version` gets, and that is the case it was written for: a
caller naming the version is describing a release that **does not exist yet** (`version --changelog`
writes the entry before it commits and tags), so there is no tag to read a date off.

A **print** run (no `--write`) ignores all of this deliberately: nothing is being appended, so
"the notes for this release" is the question, not "what is still undocumented". `--from` overrides
it either way.

**Not read from the entry headings.** `changelog.template` is the repository's, so the heading is a
shape rman did not choose and cannot reliably parse back. The file's own last-modifying commit was
the other candidate and cannot be the boundary: any unrelated edit - a typo, a hand-written note -
would move it forward and drop every commit in between, silently. It still serves as the *widening*
fallback for a file with no marker, which is the one run that has to guess.

## Configuration (`.rmanrc changelog.*`)

```yaml
changelog:
  ignoreTypes: [chore, ci] # commit types dropped entirely, not just folded into "General Changes"
  tagPattern: 'v*' # rarely needed - the default is derived from how many version lines the
  #                  repository has: 'v*' with one, '{name}@*' with several
  filePath: CHANGELOG.md
  template: changelog.template.md # a PATH to a template file, relative to the repo root
  groupBy: package # or 'group': one file per set of packages that releases together, at the
  #                  repository root. Read off the root only - it is one layout per repository.
```

A commit is attributed to every package its files fall under; one broad enough to touch at least 3
packages *and* more than half of all packages (a repo-wide doc pass, a relicense, ...) is
attributed to the root alone instead of being repeated in every package's own entry. See
[`ChangelogService`](../rman.md#changelogservice) for the full template placeholder reference
(`{{package}}`/`{{version}}`/`{{date}}`/`{{commits}}`/`{{features}}`/`{{fixes}}`/`{{other}}`) and
grouping algorithm. A package with `.rmanrc "publish": { "skip": true }` gets no entry at all by
default, regardless of its own commits - see [`rman publish`'s own
note](publish.md#excluding-a-package-entirely-rmanrc-publishskip). Pass `--include-skipped` to
generate it anyway.

## See also

- [`rman version --changelog`](version.md) - folds the same changelog generation into a version
  bump's own commit, bounded by each package's *pre-bump* tag rather than this command's own
  auto-detection, and headed with the version being released rather than the previous one.
- [`rman diff`](diff.md) - the raw, ungrouped git diff instead.
