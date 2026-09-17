<!-- verified against commit 0e33a0a - see ../cli-rman.md for the baseline convention -->

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
| `bump` | A release-type keyword (`"patch"`/`"minor"`/`"major"`) or an explicit semver version (e.g. `2.0.0-rc.1`). Omit to auto-detect from commits and only preview the plan. |

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--interactive` | `-i` | boolean | Show the plan and ask for confirmation before applying - with or without an explicit `bump`. |
| `--yes` | `-y` | boolean | Skip the confirmation prompt and apply the computed plan immediately - auto-detected severity included, no explicit `bump` keyword required. Conflicts with `--interactive`. |
| `--ignore-dirty` | - | boolean | Exclude a package with uncommitted local changes instead of aborting the whole run. |
| `--push` | - | boolean | Push the resulting commit(s) and tag(s) to the remote once applied. |
| `--message <text>` | `-m` | string | Override the commit message for every group this run commits. Default: `.rmanrc version.commitMessage`, or `"chore(release): v{version}"`. `{version}` is substituted when a commit's own group shares one version. |
| `--changelog` | - | boolean | Also write each bumped package's `CHANGELOG.md` (same as running `changelog --write` separately) and fold it into the same commit as the version bump. Default: `.rmanrc "version.changelog"`, or `false` - `--no-changelog` still overrides it off for one run, even when that's `true`. |
| `--preid <name>` | - | string | Make the bump a prerelease with this identifier (e.g. `"beta"` -> `1.2.3-beta.0`). Running again with the same `--preid` increments it (`-> 1.2.3-beta.1`); a different identifier starts a fresh prerelease line. Ignored when `bump` is an explicit semver version. |
| `--show` | - | boolean | Show the resulting plan for the given `bump` without applying it - unlike omitting `bump` entirely, this still uses the given release-type keyword/version to compute the plan, just never writes it. Conflicts with `--interactive`. |

## Examples

```bash
# Preview only - auto-detects severity from commits, writes nothing
rman version
```

```
Status     Package  Group      From   To     Reason
---------  -------  ---------  -----  -----  -------------------------------
bump       pkg-a    (default)  1.2.0  1.3.0  changed since v1.2.0
bump       pkg-b    (default)  1.0.4  1.1.0  in-group dependent of a minor change
no-change  pkg-c    (default)  2.0.1
Run again with an explicit bump, --interactive, or --yes, to apply.
```

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

Any package with uncommitted local changes aborts the whole run (`N package(s) have uncommitted
local changes (pass --ignore-dirty to exclude them instead of aborting)`) unless `--ignore-dirty`
is given. With nothing to bump at all, prints `Nothing to version.`.

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
  someone looks.

## Grouping (`.rmanrc group`)

Packages are partitioned into **groups**, and severity/version decisions happen per group:

- `group: true` (default) - one implicit repo-wide group, classic "fixed"/Lerna-style versioning.
- `group: "<name>"` - joins exactly the other packages sharing that string.
- `group: false` - a solo group of one (fully independent versioning).

```json
// packages/core/.rmanrc
{ "group": false }
```

Within a group, the highest severity among its **changed** members sets the group's severity, and
the new version is the group's current version (highest among its members) bumped by that
severity. Who actually receives it:

| Severity | Who gets bumped |
| --- | --- |
| `patch` | Only the changed member(s). |
| `minor` | Also every transitive **in-group** dependent of a changed member. |
| `major` | The **entire group**, changed or not. |

A package depending on another group's bumped package always gets exactly a **patch** bump of its
own (a cross-group ripple, never inheriting the source's severity) - this can itself ripple into a
third group, and so on.

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
- Both `version = '...'` and `version: '...'` are matched, quoting style preserved. Only the whole
  identifier - `myversion` and `version2` are somebody else's constants.
- Explicitly listed rather than discovered: unlike the OCI label there is no standard saying "this
  file holds the version", which is also what keeps a match this broad safe.

**Stamp the source, not the build output.** Rewriting `build/constants.js` from a build script
leaves the checked-in file claiming a placeholder: anything running from source (tests, ts-node, the
dev loop) reports that placeholder, the tagged commit never records the released version, and the
rewrite has to be redone on every build.

## Hooks, and the version being written

`.rmanrc "version"`'s `before`/`exec`/`after` run around the bump as this package's
`preversion`/`version`/`postversion` (a real npm script of that name in `package.json` still wins).
They are the one place [`${{ pkg.targetVersion }}`](../rman.md#expressions---) means anything:

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
measures from too, so the two never disagree about which commits are unreleased. `fix:` → `patch`;
`feat:` → `minor`; `feat!:`/a `BREAKING CHANGE:` footer → `major`; anything non-conventional →
`patch`. A `Release-As: patch|minor|major` commit-body footer overrides that one
commit's own contribution:

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

See [`VersionService`](../rman.md#versionservice) for the complete algorithm (including the
`incVersion` prerelease logic and cross-group ripple mechanics) and its full test-verified examples.

## See also

- [`rman changed`](changed.md) - the same plan, filtered to just what would bump, no apply step.
- [`rman publish`](publish.md) - typically run right after `version` (or independently).
- [`rman changelog`](changelog.md) - what `--changelog` folds in, runnable on its own too.
