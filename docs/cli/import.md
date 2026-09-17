<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli-rman.md for the baseline convention -->

# `rman import <path>`

```
rman import <path> [options]
```

Imports an external git repository as a new package, preserving its **entire commit history** -
every original commit, author, date, and message stays intact, just as if the package had always
lived at its new path (`git blame`/`git log --follow` keep working on the imported files
afterward). No package filtering or branch guard options apply.

## Arguments

| Argument | Description |
| --- | --- |
| `path` | Path to a **local clone** of the repository to import - not a URL, clone it first. |

## Options

| Option | Type | Description |
| --- | --- | --- |
| `--dest <dir>` | string | Subdirectory the new package is placed under, relative to the repository root. Default `"packages"`. |

## Examples

```bash
rman import ../my-old-standalone-repo
rman import ../my-old-standalone-repo --dest libs   # under libs/ instead of packages/
```

```
imported my-old-standalone-repo -> packages/my-old-standalone-repo (247 commit(s))
Add it to your workspaces glob if it is not already covered, then reinstall ("ci").
```

After importing, add the new directory to your root `package.json`'s `workspaces` glob if it isn't
already covered by an existing pattern, then run [`rman ci`](ci.md) to install it.

## Mechanism and caveats

Every commit reachable from the source repo's `HEAD` becomes a patch (`git format-patch --root`,
oldest first); each patch's file paths are rewritten with the new subdirectory prefix; then
replayed onto this repository via `git am --3way` (preserving authorship). Merge commits or
binary-file renames in the source repo can occasionally trip up a patch here or there - the same
caveat tools like `lerna import` have, since both replay patches rather than performing a real
merge (which a real `git subtree` would give, at the cost of far less predictable behavior across
git versions).

Fails outright if: `path` isn't a git repository (no `.git` found), the target directory already
exists, or the source repository has no commits at all.

## See also

- [`ImportService`](../rman.md#importservice) - the underlying service.
