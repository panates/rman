<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman version [bump]`

```
rman version [bump] [options...]
```

Bumps versions of changed packages (and their in-group dependents), grouped via `.rmanrc "group"`.
With no `bump` argument, previews the plan (auto-detecting severity from commits) and writes
nothing unless `--interactive` confirms it. With an explicit `bump`, applies immediately.

## Arguments

| Argument | Description |
| --- | --- |
| `bump` | A bump keyword of the root's version scheme (`"patch"`/`"minor"`/`"major"` under semver) or an explicit version in that scheme (e.g. `2.0.0-rc.1`). Omit to auto-detect from commits and only preview the plan. `--help` and the "invalid bump" error list the scheme's own keywords. |

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--interactive` | `-i` | boolean | Show the plan and ask for confirmation before applying - with or without an explicit `bump`. |
| `--yes` | `-y` | boolean | Skip the confirmation prompt and apply the computed plan immediately - auto-detected severity included, no explicit `bump` keyword required. Conflicts with `--interactive`. |
| `--ignore-dirty` | - | boolean | Exclude a package with uncommitted local changes instead of aborting the whole run. |
| `--push` | - | boolean | Push the current branch and **this release's tags** to the remote once applied, in one atomic push - see [What `--push` sends](#what---push-sends). |
| `--message <text>` | `-m` | string | Override the commit message for every group this run commits. Default: `.rmanrc version.commitMessage`, or `"chore(release): v{version}"`. `{version}` is substituted when a commit's own group shares one version. |
| `--changelog` | - | boolean | Also write each bumped package's changelog (same as running `changelog --write` separately) and fold it into the same commit as the version bump. Follows [`changelog.groupBy`](changelog.md#one-file-per-package-or-one-per-release): under `group`, one file per release group, committed with that group's release. Default: `.rmanrc "version.changelog"`, or `false` - `--no-changelog` still overrides it off for one run, even when that's `true`. |
| `--preid <name>` | - | string | Make the bump a prerelease with this identifier (e.g. `"beta"` -> `1.2.3-beta.0`). Running again with the same `--preid` increments it (`-> 1.2.3-beta.1`); a different identifier starts a fresh prerelease line. Ignored when `bump` is an explicit semver version. Default: `.rmanrc "version.preid"` - see [A permanent prerelease line](#a-permanent-prerelease-line). |
| `--show` | - | boolean | Show the resulting plan for the given `bump` without applying it - unlike omitting `bump` entirely, this still uses the given release-type keyword/version to compute the plan, just never writes it. Conflicts with `--interactive`. |
| `--json` | `-j` | boolean | Print the plan as JSON and write nothing - the machine-readable form of `--show`, and what the removed `changed` command was for. See [`--json`: the plan, for a script](#--json-the-plan-for-a-script). Conflicts with `--interactive` and `--yes`. |

## Examples

```bash
# Preview only - auto-detects severity from commits, writes nothing
rman version
```

```
Status     Package  Group      From       To     Reason
---------  -------  ---------  -----  --  -----  -----------------------------------------------------------
bump       root     (root)     1.2.0  ->  2.1.0  informational - monorepo root is never published on its own
---------  -------  ---------  -----  --  -----  -----------------------------------------------------------
bump       pkg-a    (default)  1.2.0  ->  2.1.0  changed since v1.2.0
bump       pkg-b    (default)  1.0.4  ->  2.1.0  in-group dependent of a minor change
no-change  pkg-c    (default)  2.0.1
Run again with an explicit bump, --interactive, or --yes, to apply.
```

**Reading the table.** The **repository root comes first**, above a rule: its number is the
repository's release identity - what a [`github-release`](github-release.md) is named after - and
not a package release at all. Below it, each block is one version line: a group's members are
printed together however the workspace ordered them, and the packages that belong to no group share
a final block. The `Group` column says which kind of line a row is on:

| Group cell | Meaning |
| --- | --- |
| `(root)` | the repository's release identity, not a package release |
| `(default)` | the default group (`group: true`) - a note, so it is grey and in parentheses |
| `core` | a group the repository **named** (`group: "core"`) - a value, printed bare, even with a single member |
| *(blank)* | `group: false` - a line of its own, so the cell would only repeat the package name |

A named group always gets a block of its own, however many members it has: its name decides its tag
and its changelog file, so it is a line of its own even when only one package sits on it.

Note that `pkg-b` lands on `2.1.0` rather than `1.1.0`: it shares the `default` group with `pkg-a`,
and **a group releases as one number** - the highest among its members. Use
[`group`](../rman.md#configuration-rmanrc--rmanrcyml) to give a package its own line.

```bash
rman version --interactive        # same preview, then asks "Apply these changes? (y/N)"
rman version --yes                # auto-detects severity from commits and applies it, no prompt (CI-friendly)
rman version patch                # apply a patch bump immediately, no confirmation needed
rman version minor
rman version major
rman version 2.0.0-rc.1           # an explicit semver version, applied verbatim wherever something changed
rman version minor --preid beta   # 1.2.0 -> 1.3.0-beta.0
rman version minor --preid beta   # (run again later) 1.3.0-beta.0 -> 1.3.0-beta.1
rman version --preid rc           # switching identifiers starts a fresh line: -> 1.3.0-rc.0
rman version --changelog          # also write/fold in each bumped package's CHANGELOG.md
rman version --no-changelog       # skip it for one run, even with .rmanrc "version.changelog": true
rman version patch --push         # commit, tag, and push in one go
rman version patch --message "chore(release): {version}"
rman version --ignore-dirty       # exclude dirty packages instead of aborting the whole run
rman version --scope pkg-a --dependents  # only pkg-a and whatever depends on it
rman version patch --show         # preview what an explicit patch bump would do, without applying it
```

### A permanent prerelease line

`.rmanrc "version.preid"` is `--preid` as a standing setting, for a package whose **every** release
is a prerelease by design - one that repackages an upstream module as `<upstream version>-rev.N`, so
the version always says which upstream release it wraps:

```yaml
# .rmanrc.yml
version:
  preid: rev
publish:
  npm:
    latestPrereleases: [rev]   # these are releases, not previews - see rman publish
```

```
4.13.3-rev.8  --fix:-->   4.13.3-rev.9
4.13.3-rev.8  --feat:-->  4.13.3-rev.9      # the line only counts revisions
```

- **Without it the line ends on the next release**: a fix graduates `4.13.3-rev.8` to a bare
  `4.13.3`, a feature to `4.14.0`. Release workflows run `rman version` with no flags, so the setting
  is what keeps the line.
- **`--preid` still wins for one run**, and a different identifier starts a fresh line as usual.
- **Per package, cascaded, and one answer per group.** A group is one version line, so members
  declaring *different* identifiers are an error naming them; a member declaring nothing follows the
  one that does.
- **A new upstream base is written by hand and goes out bumped once.** Setting the manifest to
  `4.13.4-rev.0` and committing it makes the next release `4.13.4-rev.1` - the plan bumps from what
  the manifest says, like any other version. `rev.0` is never published, which costs nothing: the
  revision only has to increase.
- **A bare version sorts above its own prereleases** in semver, so `4.13.4` followed by
  `4.13.4-rev.1` goes *down*. Once on the line, stay on it.
- A repository with one version line and this setting also wants `githubRelease.prerelease: false`,
  or its GitHub Release is marked pre-release like any other prerelease.

Any package with uncommitted local changes aborts the whole run (`N package(s) have uncommitted
local changes (pass --ignore-dirty to exclude them instead of aborting)`) unless `--ignore-dirty`
is given. With nothing to bump at all, prints `Nothing to version.`.

**The aborted row still names the version**, because the package being worked on is the one you
wanted the preview for. Nothing is written - the run stops before `version` touches a manifest -
so the number is what you would get once it is committed:

```
Status  Package  Group      From       To     Reason
------  -------  ---------  -----  --  -----  -----------------------------------------------------------
bump    root     (root)     1.2.0  ->  2.1.0  informational - monorepo root is never published on its own
------  -------  ---------  -----  --  -----  -----------------------------------------------------------
bump    pkg-a    (default)  1.2.0  ->  2.1.0  changed since v1.2.0
bump    pkg-b    (default)  1.0.4  ->  2.1.0  in-group dependent of a minor change
error   pkg-c    (default)  2.0.1  ->  2.1.0  uncommitted local changes (changed since v1.2.0)
1 package(s) have uncommitted local changes (pass --ignore-dirty to exclude them instead of aborting)
```

`--ignore-dirty` is deliberately different: the run **proceeds and writes**, so a skipped package is
given no version at all rather than one it is not going to receive, and it stays out of its group so
no sibling inherits a number from commits nobody is releasing.

## `--json`: the plan, for a script

`--json` prints the same plan as a JSON array and **writes nothing** - the machine-readable form of
`--show`. This is what `rman changed` was, and it replaces it.

```bash
rman version --json
```

```json
[
  { "name": "pkg-a", "selector": "pkg-a", "isRoot": false, "groupKey": "default", "group": "default",
    "status": "bump", "from": "1.0.0", "to": "1.1.0", "reason": "changed since v1.0.0" },
  { "name": "root", "selector": "root", "isRoot": true, "groupKey": "__root__", "group": "root",
    "status": "bump", "from": "1.0.0", "to": "1.1.0",
    "reason": "informational - monorepo root is never published on its own" }
]
```

**Every entry is here, unfiltered, each carrying its own `status`** - and that is the fix rather
than a detail. `rman changed` returned only `status === "bump"` entries, and two things fall through
that filter in opposite directions: the repository **root** reports a bump (it is informational, and
that fact lived only in `reason`), while a package with uncommitted changes is `"error"`. Measured
on a dirty tree, the array came back holding exactly one name - the root, the one package that must
never be published - with the package that had actually changed missing entirely.

So `isRoot` is stated rather than left to be inferred from the group label, and a dirty package
appears with `status: "error"` and the version it would get. Select what you want:

```bash
rman version --json | jq '[.[] | select(.isRoot | not) | select(.status == "bump") | .name]'
```

`groupKey` is the same value [`rman list --json`](list.md) reports for each package, so the two can
be joined on it; `group` is the label printed in the plan's Group column.

**The run resolves either way, even with a dirty package.** `--show` exits 1 there because a person
needs stopping; here the same fact is in the data, and a non-zero exit would make a pipeline bail
before it could read the rows that explain why.

Still not a release gate - that is [`publish`](publish.md), which asks the registry whether each
version is actually out there. A package can need no version bump and still be unpublished.

## What it reports once applied

The table above is the plan. Once a run applies, what follows is **what it did** - deliberately not
the same list again:

```
updated 2 packages
commit  f167ee2  chore: sync root version to 2026.9.17-1814
commit  81fb42d  chore(release): v1.1.0
commit  c9992f8  chore(release): v2.1.0
tags    pkg-a@1.1.0, pkg-b@2.1.0
tags    release-2026.9.17-1814 (repository release)
push    not pushed - run with --push, or push it yourself
```

Each line is something the plan cannot tell you:

- **`updated`** counts the packages whose manifest was written. In a monorepo that is *fewer* than
  the plan's `bump` rows: the root's entry is informational and never written, which the old output
  listed as `updated <root> 1.0.12 -> 1.1.1` - reading as a write that never happened.
- **`commit`** - one per group, so independently-versioned lines get clean, separate commits, plus
  the root's own version-sync commit ahead of them. Nothing reported these at all before.
- **`tags`** - each group's tag, then the repository release tag on its own line (calendar versions
  only, see [The repository's own version](#the-repositorys-own-version)). A tag that already
  existed reads `(existing, left alone)` rather than being silently counted as created.
- **`push`** - a release that is committed but not pushed looks identical to one that is, until
  someone looks. A pushed run names the tags that went up with the branch.

### What `--push` sends

**The current branch and the tags this release names, by name, in one `git push --atomic`** - and
nothing else:

```
git push --atomic origin HEAD pkg-a@1.1.0 pkg-b@2.1.0 release-2026.9.17-1814
```

- **Not every tag in the clone.** It used to be `git push origin --tags`, so a single stale tag -
  deleted and re-created locally months ago, now different from the remote's - failed every
  `--push` from then on, and failed it *after* the new tag had already gone up. A tag the release
  names but did not create (one that was already there) is still sent: it is this release's tag.
- **All or nothing.** The branch and the tags used to be two pushes, so a failure in the second left
  a pushed version bump with no tag, which a re-run cannot repair - there is nothing left to bump.
  Atomic, a refused ref leaves the remote exactly as it was, and the error says what is waiting
  locally and the command that pushes it once the cause is fixed:

  ```
  Unable to push to "origin": Command failed: git push --atomic origin HEAD v1.1.0
   ! [rejected]  v1.1.0 -> v1.1.0 (already exists)

    Nothing was pushed - the branch and its tags go up together or not at all. Left behind
    locally: 81fb42d, tagged v1.1.0.
    Once the cause is fixed, push them with: git push --atomic origin HEAD v1.1.0
  ```

## Grouping (`.rmanrc group`)

Packages are partitioned into **groups**, and severity/version decisions happen per group:

- `group: true` (default) - one implicit repo-wide group, classic "fixed"/Lerna-style versioning.
- `group: "<name>"` - joins exactly the other packages sharing that string.
- `group: false` - a solo group of one (fully independent versioning).

```json
// packages/core/.rmanrc
{ "group": false }
```

A group name is limited to 15 characters of letters, digits, `.`, `-` and `_`, starting with a
letter or digit - it becomes a file name under
[`changelog.groupBy: group`](changelog.md#one-file-per-package-or-one-per-release), so anything else
is refused, naming the package that declared it, rather than escaped.

Within a group, the highest severity among its **changed** members sets the group's severity, and
the new version is the group's current version (highest among its members) bumped by that
severity. How far into the group it reaches is the package's **technology**'s answer, because it is
a statement about what a published artifact still needs. A Node package's:

| Severity | Who gets bumped |
| --- | --- |
| `patch` | The changed member(s) **and** every transitive **in-group** dependent of one. |
| `minor` | The same: the changed members and their transitive in-group dependents. |
| `major` | The **entire group**, changed or not. |

A patch reaches dependents (it reached only the changed packages before 2.4) because a dependent's
published artifact was built against the old code: anything that bundles or type-checks against its
dependency keeps shipping the pre-fix version until it is released again. Members of different
technologies in one group take the widest answer any of them gives. A dependent pulled in this way
reads `in-group dependent of a patch change`; one pulled in by a major reads
`in-group member of a major change`.

A package depending on another group's bumped package always gets exactly the scheme's
**smallest** bump (`patch` under semver) of its own - a cross-group ripple, never inheriting the
source's severity - and this can itself ripple into a third group, and so on.

### Keeping a group in lockstep (`.rmanrc "version.cascade"`)

The technology's answer is about what a release *needs*. Whether a repository wants **one number
across its whole product** is a separate decision, and `version.cascade` is where it says so:

```yaml
group: true
version:
  cascade: group # every member releases on every release
```

| Value | The narrowest a group is released |
| --- | --- |
| `changed` | no floor of your own - only what the technology asks for |
| `dependents` | the changed members and their in-group dependents |
| `group` | every member, so the group stays on one version |

It is a **floor, never a ceiling**: the technology still widens it where a narrower release would
leave a dependent behind, so `cascade: changed` still reaches the whole group on a major. In a Node
repository `changed` and `dependents` therefore change nothing, and `group` is the one value that
does. Per-package cascaded; a group whose members disagree takes the widest. An explicit
`rman version <v>` never consults it - every eligible package moves already.

It is not a safety valve: a change that can break a dependent is a `feat:` or `feat!:`, and
renumbering the dependent does not make the break safe.

## The repository's own version

A monorepo root is never published, but its version is the **repository's release identity** - what
a [GitHub Release](github-release.md) is named after. It isn't configured;
it follows from how many version lines the repo has:

- **One group** - the root follows it, so the repository and its packages share one number.
- **Several groups** - a calendar version, `YYYY.M.D-HHmm` with nothing padded (`2026.9.5-930`).
  With several lines there is no shared number to report: whichever is highest would stand still
  whenever a *lower* line released, leaving that release with no identity at all. The unpadded shape
  isn't cosmetic - semver forbids leading zeroes in numeric identifiers, and the root's
  `package.json` has to stay valid.

The choice is sticky: once the repository is on a calendar version it stays there, since going back
would *lower* the root version. On a calendar version, `version` also creates a repository release
tag (`.rmanrc "version.releaseTagPattern"`, default `release-*`) alongside the per-group ones. With
a single version line the group's own tag already is the release, so no second name is created.

The release tag pattern must never match a package's own `changelog.tagPattern` - a release tag
matching `v*` would be picked up as some package's last release and throw off its changelog.

### Which tag a package's release gets

Each group's release is tagged per member under `.rmanrc "changelog.tagPattern"`. Left unset, the
pattern is derived from the same structural fact as the root's version - how many version lines the
repository has:

- **One line** - `v*`: one repo-wide tag (`v1.2.0`) for the whole release.
- **Several lines** - `{name}@*`: every member gets its own tag at its group's version
  (`pkg-a@1.2.0`, `pkg-b@1.2.0`), and each package finds its own on the next run. A repo-wide `v*`
  tag is resolved as "the nearest one HEAD descends from", which stops being *this* package's last
  release the moment the lines release separately.

A repository that splits into several lines keeps working across the switch: while a package has no
`{name}@*` tag of its own yet, its boundary falls back to the repo-wide `v*` tag that was correct
before the split, so the first run reads the same commits as the last and writes the per-package
tag every later run finds. That bridge applies only to the derived default, never to a
`tagPattern` the repository set itself. The repository root always keeps `v*`.

## Stamping the version where the package declares it

### The Dockerfile label

A bumped package's Dockerfile has its `org.opencontainers.image.version` label rewritten to the new
version, in the **same commit** as the bump:

```dockerfile
LABEL org.opencontainers.image.version="1.2.0"   # was "1.1.0"
```

It belongs here rather than in a build script: the label is by specification *the version of the
packaged software*, so there is only ever one correct value for it and `version` is what knows it.
Doing it at build time instead is both later than necessary and invisible to git - it leaves the
edit uncommitted (which [`publish`](publish.md) then trips over as a dirty tree) and records a stale
label in the commit that was actually tagged.

- Read from the same path [`publish --target docker`](publish.md#docker-publishing-publishdocker)
  builds from - `.rmanrc "publish.docker.dockerfile"`, default `Dockerfile`, relative to the
  package's own directory - so the two can never disagree about which file this is.
- Only ever **rewrites** a label the Dockerfile already declares; one is never inserted. Which
  labels an image carries is the author's decision. A package with no Dockerfile, or one that
  doesn't declare the label, is a no-op.
- The existing quoting style is kept, so the diff is the version and nothing else. Labels sharing a
  line, and `LABEL` instructions split across `\` continuations, are both handled; the same key
  outside a `LABEL` (in an `ENV`, or a comment) is left alone.
- Turn it off with `.rmanrc "version": { "stampDockerfile": false }` (per-package cascaded).

### Source constants (`.rmanrc "version.stamp"`)

A package that hard-codes its own version in source has it rewritten the same way, in the same
commit:

```yaml
"[*]":
  version:
    stamp: ["src/constants.ts"]
```

```ts
export const version = '6.0.10'; // was '1'
```

- Paths are relative to the package's own directory. A listed file a package doesn't have is a
  silent no-op, so one `"[*]"` declaration covers a repo where only some packages carry one.
- Both `version = '...'` and `version: '...'` are matched, with single, double or backtick quotes,
  quoting style preserved. Only the whole identifier - `myversion` and `version2` are somebody
  else's constants. **How** a version is declared is the package's technology's answer; this is the
  rule the built-in one applies.
- A constant spelled otherwise is named with the object form, `{ file, constant }`:

  ```yaml
  version:
    stamp:
      - { file: src/version.go, constant: Version }
  ```

- **A listed file that exists but holds nothing rewritable is an error**, raised before anything is
  written - a typo'd path or a renamed identifier would otherwise ship a stale constant on every
  release. A missing file stays a silent no-op: that means "not this package".
- **`{ file, optional: true }`** waives that error, for an entry whose author cannot know whether the
  file holds a version - a shared preset naming `src/constants.ts` for every package of a
  technology. A file that does hold one is still stamped.
- Explicitly listed rather than discovered: unlike the OCI label there is no standard saying "this
  file holds the version", which is also what keeps a match this broad safe.

**Stamp the source, not the build output.** Rewriting `build/constants.js` from a build script
leaves the checked-in file claiming a placeholder: anything running from source (tests, ts-node, the
dev loop) reports that placeholder, the tagged commit never records the released version, and the
rewrite has to be redone on every build.

## Hooks, and the version being written

`.rmanrc "version"`'s `before`/`exec`/`after` run around the bump, alongside this package's own
`preversion`/`version`/`postversion` scripts. The two **compose**: the config brackets the
package's own (`version.before` → `preversion` → `version` → `postversion` → `version.after`), and
only `exec` is replaced - a package's own `version` script stands in for `version.exec`. Any of the
three may also be a function, in a JS config. They are the one place [`${{ pkg.targetVersion }}`](../rman.md#expressions---) means anything:

```yaml
"[*]":
  version:
    after: "docker tag app:latest app:${{ pkg.targetVersion }}"
```

The version doesn't exist until `version` has computed its plan - long after the config was
resolved - so these three keys are left unevaluated at load and evaluated here, with it bound.
Naming `pkg.targetVersion` in any other key fails when the repository loads, which is deliberate:
no other command has a target version, and evaluating it to `undefined` would quietly produce an
`app:undefined`.

## Severity auto-detection

With no explicit `bump`, each package's severity comes from its own commits since its last release -
the shared [`ChangeHashService`](../rman.md#changehashservice) boundary [`changelog`](changelog.md)
measures from too, so the two never disagree about which commits are unreleased. Each commit is
read as a kind - `feat!:`/a `BREAKING CHANGE:` footer is breaking, `feat:` a feature, anything else
(`fix:`, an unknown type, a non-conventional subject) a fix - and the version scheme turns the kind
into a bump: under semver `major`, `minor` and `patch`. A `Release-As: <bump>` commit-body footer,
naming one of the scheme's bump keywords, overrides that one commit's own contribution; a word that
is not one of them (another tool's `Release-As: 1.2.3`) is ignored rather than ranked:

```
feat: needs to ship right now, not wait for the rest of the minor

Release-As: patch
```

`.rmanrc "publish.skip"` (see [`rman publish`](publish.md#excluding-a-package-entirely-rmanrc-publishskip))
has no effect here - a package can still be meaningfully versioned even if it's never published.

## Dependency ranges and `"workspace:"`

`applyPlan` refreshes any bumped-dependency range to match (`^`-prefixed by default). A bare
`workspace:*`/`workspace:^`/`workspace:~` range is left untouched (it's already dynamic); an
explicit `workspace:<range>` (e.g. `workspace:^1.0.0`) is bumped the same way a plain range would
be.

See [`VersionService`](../rman.md#versionservice) for the complete algorithm (including
[prereleases](../rman.md#prereleases---preid--optionspreid) and cross-group ripple mechanics) and
its full test-verified examples. How a number actually moves is the **version scheme**'s
(`VersionScheme.next(current, bump, { preid })`), not this command's - see
[the bump names](../rman.md#versionplanservice).

## See also

- [`rman version --json`](#--json-the-plan-for-a-script) - the same plan, machine-readable, no apply step.
- [`rman publish`](publish.md) - typically run right after `version` (or independently).
- [`rman changelog`](changelog.md) - what `--changelog` folds in, runnable on its own too.
