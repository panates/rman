<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli-rman.md for the baseline convention -->

# `rman diff [package]`

```
rman diff [package]
```

Shows the git diff since a package's (or the whole repository's) last release tag. No package
filtering or branch guard options apply - this is a single, targeted lookup.

## Arguments

| Argument | Description |
| --- | --- |
| `package` | Package name - diffs just that package, since its own last tag (scoped to its directory via a git pathspec). Omit to diff the whole repository since its own last tag, or the current directory's package if you're standing inside one. |

## Examples

```bash
rman diff                # since the repository's own last tag, whole repo
rman diff pkg-a          # since pkg-a's own last tag, scoped to packages/pkg-a
```

If `package` doesn't name a real package, prints `No such package "<name>"` (red) and exits with an
error. If the target has no release tag at all, prints `No release tag found for "<name>" -
nothing to diff against.` and exits successfully (nothing to compare). If there's a tag but nothing
has changed since it, prints `No changes since <tag>.`.

## See also

- [`rman changed`](changed.md) - a version-bump-level summary instead of a raw diff.
- [`rman changelog`](changelog.md) - a formatted, grouped changelog instead of a raw diff.
