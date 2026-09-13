<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

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

Accepts [package filtering](../cli.md#package-filtering) and [branch guard](../cli.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--interactive` | `-i` | boolean | Show the plan and ask for confirmation before applying - with or without an explicit `bump`. |
| `--yes` | `-y` | boolean | Skip the confirmation prompt and apply the computed plan immediately - auto-detected severity included, no explicit `bump` keyword required. Conflicts with `--interactive`. |
| `--ignore-dirty` | - | boolean | Exclude a package with uncommitted local changes instead of aborting the whole run. |
| `--push` | - | boolean | Push the resulting commit(s) and tag(s) to the remote once applied. |
| `--message <text>` | `-m` | string | Override the commit message for every group this run commits. Default: `.rmanrc version.commitMessage`, or `"chore(release): v{version}"`. `{version}` is substituted when a commit's own group shares one version. |
| `--changelog` | - | boolean | Also write each bumped package's `CHANGELOG.md` (same as running `changelog --write` separately) and fold it into the same commit as the version bump. |
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
rman version patch --push         # commit, tag, and push in one go
rman version patch --message "chore(release): {version}"
rman version --ignore-dirty       # exclude dirty packages instead of aborting the whole run
rman version --scope pkg-a --dependents  # only pkg-a and whatever depends on it
rman version patch --show         # preview what an explicit patch bump would do, without applying it
```

Any package with uncommitted local changes aborts the whole run (`N package(s) have uncommitted
local changes (pass --ignore-dirty to exclude them instead of aborting)`) unless `--ignore-dirty`
is given. With nothing to bump at all, prints `Nothing to version.`.

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

## Severity auto-detection

With no explicit `bump`, each package's severity comes from its own commits since its last release
tag: `fix:` → `patch`; `feat:` → `minor`; `feat!:`/a `BREAKING CHANGE:` footer → `major`; anything
non-conventional → `patch`. A `Release-As: patch|minor|major` commit-body footer overrides that one
commit's own contribution:

```
feat: needs to ship right now, not wait for the rest of the minor

Release-As: patch
```

## Dependency ranges and `"workspace:"`

`applyPlan` refreshes any bumped-dependency range to match (`^`-prefixed by default). A bare
`workspace:*`/`workspace:^`/`workspace:~` range is left untouched (it's already dynamic); an
explicit `workspace:<range>` (e.g. `workspace:^1.0.0`) is bumped the same way a plain range would
be.

See [`VersionService`](../api.md#versionservice) for the complete algorithm (including the
`incVersion` prerelease logic and cross-group ripple mechanics) and its full test-verified examples.

## See also

- [`rman changed`](changed.md) - the same plan, filtered to just what would bump, no apply step.
- [`rman publish`](publish.md) - typically run right after `version` (or independently).
- [`rman changelog`](changelog.md) - what `--changelog` folds in, runnable on its own too.
