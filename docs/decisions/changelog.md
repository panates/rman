# `changelog`

Design decisions moved out of `CLAUDE.md`. Covers `ChangelogService`: boundaries, markers, sections, `groupBy`, `--rebuild`, progress.

## `changelog`

- **Question A.** The boundary is auto-detected per package via `detectChangeHash` by default;
  `--from <hash>` bypasses that entirely and applies identically to every package.
- **`--write` does not use that boundary - it uses the file's own** (`resolveBoundary` in
  `changelog.service.ts`). An append has to start where the last one stopped, and a release *tag*
  does not move between two writes: measured, a second `--write` re-listed every commit since the
  tag on top of the entry already holding them, so one commit appeared twice under two headings
  carrying the same version number. Three cases, in order: **a marker** in the file -> that commit;
  **no file at all** -> the whole history (measured, the tag boundary documented only what came
  *after* the last tag and the commits before it were never written anywhere); **a file with no
  marker** -> ordinary detection, where `catchUpFile` still earns its place by widening backwards.
  - The marker is `<!-- rman:documented-up-to <sha> -->`, one per file, **rewritten** on each write.
    HEAD, resolved once per run rather than per package, so a commit made mid-run cannot straddle
    two entries.
  - **Not parsed back out of the entry headings**: `changelog.template` is the repository's, so the
    heading is a shape rman did not choose. **Not the file's last-modifying commit** either - that
    is `catchUpFile`, and as a *boundary* it silently drops every commit between an unrelated edit
    (a typo, a hand-written note) and the last real write. Widening-only is safe; narrowing is not.
  - **A print run ignores all of it**, deliberately: nothing is being appended, so the question is
    "the notes for this release", not "what is still undocumented". `ChangelogService.Options.write`
    exists for exactly that distinction and is set by `generateToFile`, never by a caller.
- **`{{date}}` is the tag's date, not `new Date()`** (`resolveHeading`). The version half of a
  heading is read back from the package's latest tag, so taking the date from the clock made the two
  halves describe different releases - measured, `## @panates/eslint-config v2.1.6 (2026-09-25)` for
  a v2.1.6 tagged days earlier - and made a regenerated file differ from itself every day. The
  **committer** date, since a rebased release commit was authored before it shipped. Today's date
  stays for `--release-version`, which is the case it was written for: that caller is describing a
  release with no tag to read.
- **The range is cut at every release tag inside it** (`splitByRelease`), one entry per release,
  newest first. An ordinary run has no tag inside the range - the boundary *is* the last release -
  so this only shows on a backfill, which is exactly where it matters: measured, a first `--write`
  on a repository with twelve releases rendered every commit in all of them under one `v2.1.6`
  heading.
  - **The drop of release markers moved from the fetch to the segment**, and that is load-bearing:
    `version` tags the `chore(release): v1.0.0` commit, which `dropVersionBumps` removes - so
    dropping first left every tag pointing at a sha no longer in the list and every cut missed.
    The tagged commit closes its segment and is dropped from it.
  - **Which tags count is `ChangeHashService.releaseTagPatterns`**, shared with `findLatestTag` so
    the boundary and the cuts cannot disagree. They did, for one commit: the boundary bridged to the
    shared `v*` while the split still looked only for `{name}@*`, which a repository mid-transition
    has none of - so the backfill found nothing to cut at.
- **An entry's heading is its tag** (`{{title}}`, `resolveHeading`). It was `{{package}}
  {{version}}`, assembled from a label and a version read off the latest tag - which states
  something untrue wherever a tag covers more than one package: the repository root was headed
  `## panates-javascript repository 2.1.6`, and the root package there is `panates-style` at
  `0.0.5`. An untagged segment is `Unreleased — <label>`, dated today.
  - **The label has to stay in it.** `Unreleased` alone was tried and 22 specs caught the loss:
    `rman changelog` prints every package to one stream, so consecutive `## Unreleased` blocks say
    nothing about which package each belongs to.
  - **The date follows the heading**: a tagged segment takes the tag's committer date, an untagged
    one takes today. Reading the last tag's date for unreleased commits headed them with the day of
    the release before them.
  - `{{package}}`, `{{version}}` and `{{tag}}` stay bound for a repository's own template - only the
    default changed. **Don't pin a heading's layout in a spec**: `toContain('## pkg-a 1.0.0')` did,
    in twenty-two places, so a presentation change turned all of them red for no defect. Both spec
    files have a `headingFor(name)` regex helper for this.
- **`changelog.titles` maps a commit type to its section heading** (`resolveTitles`/`groupCommits`),
  and with it the section order. It was three hardcoded strings, so `feat` and `fix` were the only
  two types rman could name and everything else - `dev`, `docs`, `perf` - shared one heap.
  - **rman now ships a heading for every *standard* Conventional Commits type**, in this order:
    `feat` ✨ Features, `fix` 🐛 Bug Fixes, `perf` ⚡ Performance and Optimizations, `revert`
    ⏪ Reverts, `refactor` 🔧 Refactoring, `docs` 📚 Documentation, `test` 🧪 Tests, `build`
    📦 Build System, `ci` 🤖 Continuous Integration, `chore` 🧹 Chores, `style` 🎨 Code Style, and
    `*` 💬 General Changes. Measured across four of this organization's repositories, the old
    catch-all held 194 `chore`, 86 `docs`, 68 `refactor`, 29 `test`, 27 `ci` and 24 `perf` - more
    commits than `feat` and `fix` together, under a heading saying only "not one of those two".
    - **The set stops at the standard types.** `dev` (32 across the same four) and `bench` (9) are
      this organization's inventions; a repository names those in its own `titles`, or a shared
      preset does it once. Shipping a heading for a type no convention defines is guessing on every
      other user's behalf.
    - **They add sections and hide nothing** - the one place this parts from conventional-changelog,
      whose default preset silently drops `chore`, `ci`, `build`, `style` and `test`. A changelog
      quietly missing a third of the history is the worse failure; `ignoreTypes` stays the only key
      that drops a type.
    - **Every emoji is checked for U+FE0F and none carries it**, pinned by a spec that walks the
      rendered headings. A variation selector survives github-slugger, so `### ♻️ Refactoring` gets
      an anchor nobody types and every link to it lands at the page top - the `⬆️` trap again. It is
      why refactor is `🔧` (free since the catch-all became `💬`) and ci is `🤖`.
    - **Adding defaults breaks specs that assert a heading list**, and two of them silently: a case
      reading `sortTitles: ['docs', ...]` to mean "a type with no heading" tested the opposite once
      `docs` had one, and a case asserting the catch-all "renders last" had nothing to assert once
      `chore` took its only occupant. `commitsFixture` carries a `wip:` commit for that second one.
  - **Merged over the defaults per key, not replacing them** - the `vars` rule rather than a new
    exception, and what the shape asks for: naming `dev` must not silently cost a repository its
    `feat` and `fix`. Renaming a default keeps its position. The cost: a default section cannot be
    *removed* by omission; `ignoreTypes` is the key that drops a type, and it still wins.
  - **`changelog.sortTitles` orders the sections; `titles` only words them.** Two keys because two
    decisions: order used to fall out of the order `titles` was written in, which quietly meant
    renaming `feat` was also re-deciding where it sits. A sort, not a filter - an unlisted type
    keeps its place after the listed ones.
    - **Only a type with a heading of its own takes a position.** A type nobody named resolves to
      the catch-all, so ordering by it drags the catch-all to that position: measured,
      `sortTitles: ['docs', 'fix', 'feat']` with no `docs` heading put "General Changes" first and
      swallowed everything after it. (`docs` is a default heading now, so the spec for this uses
      `dev` - a type rman does not ship one for.)
  - **`'*'` is the catch-all and is always rendered last**, whatever position it was declared in - a
    catch-all in the middle silently swallows the sections after it.
  - **The type prefix is stripped in every section now.** It was `push(line)` for `feat`/`fix` and
    `push(subject)` for the rest, so General Changes read `- chore: bump deps` while Features read
    `- a new capability`. With every type able to carry a heading that asymmetry has no defence.
    A non-Conventional subject has no prefix to strip and is kept whole.
  - **`Entry.features/fixes/other` and `{{features}}`/`{{fixes}}`/`{{other}}` are derived**
    (`legacyBuckets`), so they keep meaning what they meant - whatever `feat` and `fix` are listed
    under, everything else together. `Entry.sections` is the shape that does not lose a repository's
    own headings; prefer it.
- **A message repeated inside one section is written once** (`groupCommits`). Measured on
  `panates/postgrejs`, whose `v2.22.1` entry read `Updated config` five times - five commits really
  worded the same, so it is not rman inventing them, and the repetition states nothing the first
  line did not.
  - **Per section, not per entry**: `feat: x` and `fix: x` are different claims under different
    headings, and collapsing those loses a fact rather than a repetition.
  - **Keyed on the message, before the sha is appended**, which is the whole subtlety - with the sha
    on the line every duplicate is textually unique and the check would never fire. The survivor
    keeps the *first* commit's sha, and `listCommits` returns oldest-first, so that is the earliest
    of the run. The spec asserts the dedup and the sha together, which is the only combination that
    can catch the wrong order.
- **Each bullet ends with its commit's short sha** - `changelog.commitHash` / `--no-commit-hash`,
  default `true`.
  - **Plain, never a Markdown link.** GitHub autolinks an abbreviated sha wherever it renders
    Markdown inside the repository, so `(a1b2c3d)` is a link on the page and still readable in a
    terminal; a hand-built URL would need to know the forge, which nothing here does.
  - **No `default: true` on the yargs option**, the same trap `unreleased` avoids: declared there, an
    omitted flag arrives as `true` rather than `undefined`, so the flag would beat
    `.rmanrc changelog.commitHash` on every run and the key could never turn it off. The default
    lives in `withCommitHash`.
  - **A spec comparing a section's lines exactly cannot name a fixture's shas**, which are new every
    run - `changelog.service.spec.ts` has a `withoutSha()` helper for that, rather than loosening
    those assertions to `toContain`, which would stop them noticing an extra line.
- **`changelog.unreleased` defaults to `true`, so the flag that acts is `--no-unreleased`** -
  the one place this deliberately parts from `auto-changelog`, which defaults its equivalent off.
  That tool documents a finished history; `rman changelog` exists to answer what is *not* released
  yet, down to the message it prints when there is none. Off by default would make the common case
  need a flag.
  - **`options.version` always wins over it** (`resolveUnreleased`). Naming the version means the
    caller is describing the release it is about to cut - `version --changelog` writes that entry
    *before* it commits and tags. Without the guard, a repository setting `unreleased: false` would
    find every release silently documenting nothing; the control for it turns that spec red.
- **`changelog.startingAt` puts a floor under how far back a backfill goes** (`resolveStartingPoint`)
  - one key taking a version/tag, a `YYYY-MM-DD` date, or a commit, where `auto-changelog` has two
  options and no commit form. Decided in that order, because the shapes overlap: date shape first,
  then anything the scheme reads as a version (so `2.0.0`, `v2.0.0` and `@scope/pkg@2.0.0` all
  work), then anything git resolves. A tag whose name is also hex wins over the sha reading.
  - **Inclusive**, all three, matching `auto-changelog`.
  - **The unreleased segment is never filtered.** It is happening now, so no past floor is above it,
    and dropping it hides what most runs are asking about. A tag carrying no readable version is
    kept for the same reason - a floor leaves out history, it does not lose what it cannot classify.
  - **A value matching none of the three is refused**, and silence is the bad outcome either way:
    read as "never below" the changelog looks complete, read as "always below" it empties.
  - **Not `--from`**, though a commit-shaped value makes them look alike: `--from` is this run's
    boundary and applies identically to every package, while this is a lasting per-package fact that
    cascades and still holds next run. That distinction is the reason both exist.
  - The commit form is compared by **position in the range already fetched** (`Segment.endIndex`),
    so it costs no extra git call; `-1` means the floor is older than the range and nothing is below.
  - The `---` between releases is the **writer's**, not the template's: an entry printed to stdout
    or handed to `github-release` as a body has nothing below it to be separated from. None is
    written into a fresh file.
- **`changelog.groupBy` decides what one file is about, and the unit is a *release group***
  (`partitionTargets`, `changelogGroupBy`). `'package'` is the default and nothing about an existing
  repository changes until it asks; `'group'` gives one file to each set of packages that versions
  and releases together - the same `.rmanrc group` key `version` batches its plan by.
  - **One rule, not two.** `group: false` already makes a package a group of itself, so a solo
    group's file is its package's own and anything wider goes to the repository root: `CHANGELOG.md`
    for the default group, `CHANGELOG-<name>.md` for a named one. A repository on independent
    versioning therefore sees no difference between the two modes, which is what makes this a
    generalization rather than a second mechanism.
  - **What it fixes is not cosmetic.** Under `group: true` every package bumps together, so most of
    them own no commit and `!ownCommits.length` skips their entry entirely - measured on
    `panates/sqb`'s 6.0.11, fifteen of seventeen files were not written and the release was readable
    nowhere. The root-changelog fix above routes a *broad* commit somewhere; this routes the whole
    release somewhere.
  - **`BROAD_COMMIT_THRESHOLD` stops mattering in group mode, and that is the tell the unit is
    right.** A commit touching every package is the group's by construction, so there is nothing to
    divert to the root - the threshold exists only because a package-shaped file cannot hold a
    repo-shaped commit.
  - **Read off the root and nowhere else.** It is a *layout*, so there is one answer per repository -
    the rule `run`'s `concurrency` already follows. Cascaded per package, two members of one group
    could disagree about which file they share, which has no answer.
  - **`home` and `filePkg` are different packages and must stay so.** Every per-package question -
    boundary, tag pattern, titles, template - is asked of a member (`home`, the root when it is in
    the group, since `targets` starts there); the file sits wherever the group's file sits
    (`filePkg`, the root for any group of more than one). Collapsing them breaks a named group both
    ways: ask the root and `{name}@*` finds no tag, write beside the member and the group's file
    lands inside one of its packages.
  - **A group's heading may not be one member's tag.** Under a repo-wide pattern the tag (`v1.2.0`)
    is already package-neutral and is used as-is; under `{name}@*` it would be `pkg-a@1.2.0` over a
    file describing all of them, and a *different* member's name as soon as the first one changes -
    so the group's label carries it (`## core 1.2.0`).
  - **`version --changelog` batches one call per file** (`changelogCalls`), by `groupKeyOf` and
    never by the *planner's* key - those disagree about the root, which `VersionPlanService` puts in
    a group of its own (`__root__`). Per package instead, each call's group holds one member, so
    every bullet is still written exactly once and the file ends up with **two** `## v1.0.1`
    headings for one release. A spec asserting the bullets passes either way; the one that measures
    it counts headings, and its control was run.
  - **The group's file rides the group's commit, not the root's version sync.** The root is a member
    of the default group, so `changelogFileByPackage.get(root.name)` is the group's file - added to
    the sync commit it would land one commit *before* the tag, leaving `git show <tag>` without the
    notes for the release it names. `claimedByGroup` is that guard, and the group commit's file list
    is a `Set` because the members share one path.
- **A group name is a file name, so it is checked where it is read** (`assertGroupName`, in
  `groupKeyOf`): a letter or digit, then letters, digits, `.`, `-`, `_`, at most 15. The alternative
  was escaping it at the one place it is written, and that is the worse half - an escape turns
  `core/api` into a `core-api.md` the repository never asked for and cannot search for, and every
  future reader of the name would have to repeat it. 15 is about the reader rather than any
  filesystem: the name is repeated in every heading of the file it names and in the file name
  itself. Refused for `version` too, since `groupKeyOf` is what batches its plan.
- **`--rebuild` regenerates a file instead of appending to it**, and both halves are load-bearing.
  `resolveBoundary` returns `undefined` before it looks at anything: the marker and `catchUpFile`
  are both records of what a *previous* run wrote, so consulting either would rebuild the file from
  where the file already is. And `generateToFile` empties each file it is about to write, once,
  before any prepend - measured with a control, without it two rebuilds give **8 headings and the
  same line twice** where one gives 4 and once.
  - **Only files this run produced an entry for.** A file the run has nothing to say about is left
    alone: emptying it would lose what is there and put nothing back.
  - An explicit `--from` still wins, since that names a boundary the caller chose for this run.
  - It implies `--write`, because "rebuild the changelog" with no file to rebuild would either
    print - which `--from <first-tag>` already does - or silently do nothing.
- **Detection is parallel across targets and the commit read is not, and the slow half is the
  second one.** Measured on `panates/sqb` with a timestamping `git` shim: 18 targets resolve their
  boundary in **18 concurrent** `git describe` calls, 1.2s wall against 1.8s summed; reading the
  range is **peak concurrency 1**, 156 invocations, 6.6s - two `git show` per commit (header, then
  files), one target at a time. A full rebuild of that repository's 1825 commits takes minutes.
  - `Promise.all` over the groups is what makes the first half concurrent, and `GitHelper` spawns
    through `execFile`, so nothing underneath serializes it. Within one target the steps are a
    chain (tag -> registry -> file -> merge-base) and cannot be.
  - **`changelog.startingAt` floors which releases are written, not how far back the history is
    read**, so it does not make a rebuild cheaper. Bounding the *fetch* by it is the obvious
    optimization and is not done: the floor is inclusive and may be a version rather than a ref, so
    turning it into a fetch boundary means resolving it to the release *before* it, which is a
    correctness question rather than a rename.
- **The progress panel is reported, never printed by the service** (`ChangelogService.Options.
  progress`, `Progress`). `ChangelogService` is documented as pure with respect to the console and
  that is not tidiness: `version --changelog` drives it in the middle of its own output, so a panel
  drawn from inside would land on top of that. The CLI implements `Progress` against
  `ProgressPanel`; every other caller leaves it out.
  - **Drawn on stderr**, which is why `ProgressPanel` grew a `stream` parameter - `changelog` is
    `printsDocument`, so `rman changelog > NOTES.md` would otherwise capture the panel's
    cursor-movement codes into the notes. `LiveRegion` already took the parameter and its own doc
    anticipated this caller.
  - **Three phases, and the middle one is where the time goes**: `detect` (boundary, concurrent
    across targets, milliseconds), `commits` (reading the range, two `git show` each, one commit at
    a time), `render` (splitting, grouping, templating - no git). **The commit read happens inside
    the same `Promise.all` as the boundary**, not in the entry loop below it, and mislabelling it
    the other way was the first thing shipped here: the panel named the fast loop "reading
    commits" while the real read sat unnamed in the phase called "detect".
  - **The unit shown has to be commits, not files.** `Progress.commits(label, done, total)` is fed
    from `GitHelper`'s `onProgress`, which is on `_commitInfoFor` and nowhere else because that is
    the only serial loop. Without it the row sat unchanged for the whole slow phase - measured on
    `panates/sqb`, a rebuild read 1825 commits at **~1.2/sec** (older commits are far slower than
    recent ones: the same loop does ~12/sec over a four-release range), so ~25 minutes with one
    line on screen. There is exactly one file under `groupBy: 'group'`, so the header's bar is
    honestly `0/1` the whole time and the item line is what carries the answer.
  - A label sits at `pending` during `detect` deliberately: every label enters it at once and
    leaves in milliseconds, so marking them running fills the panel with rows about to go quiet,
    and the header counts anything not pending as done. `stepIndex` is **0-based** (the panel
    renders `stepIndex + 1`), which is the mistake that shipped `(3/2)` to a terminal.
  - **The header bar is filled from step progress, not from finished items** (`filled` in
    `ProgressPanel.render`): a finished item counts as a whole one, a *running* item as the
    fraction of its own steps it has got through. Counting whole items made the bar useless exactly
    where it was needed - one file under `groupBy: 'group'`, so it sat empty at `0/1` for the whole
    run while the row beside it counted to 1825. `run` gains the same in the small: a nine-step
    build advances within the package instead of jumping at the end of it. The `done/total` counter
    stays items, which is a different true fact and the one the bar cannot carry.
    - `renderProgressBar` clamps both ends now, because a fractional input can round past `width`
      and `'x'.repeat(-1)` throws - inside a redraw, where nothing catches it.
    - **A spec reading the bar back must match filled *and* empty cells together.** Matching up to
      the first `░` reads a full bar as no bar at all, which is exactly the clamp case; measured,
      that spec reported 0 cells and looked like a code bug.
  - `listCommitsCached` shares one fetch between targets with the same boundary, so the commits are
    counted under whichever target asked first. Reporting per sharer would mean either several
    fetches or several rows counting the same work.
  - The static line it replaces is kept for when the panel cannot draw - a pipe, or
    `--no-progress` - which are exactly the two cases that line was for.
- **`--write` prints one line per *file*, not per entry.** An entry is a release, so a backfill
  produces several for one file; printed per entry the run repeated `updated ... CHANGELOG.md` once
  per release it found. The path is repository-relative and the label is gone with the repetition:
  `packages/core/CHANGELOG.md` already says which package it is, and under `groupBy: 'group'` the
  label names a group while the path names the file that was actually written.
- **Trap:** run *after* a tag has been created, auto-detection finds that new tag and reports
  nothing changed. Hence: in CI, release notes are generated **before** `version`; and any code path
  running after the tag exists (`version --changelog`, `github-release`) passes the boundary
  **explicitly**. Do the same for any new note-generating path.
- Skips a `.rmanrc "publish.skip"` package by default; `--include-skipped` brings it back.
