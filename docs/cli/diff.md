<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman diff [package]`

```
rman diff [package] [options...]
```

Shows the git diff since a package's (or the whole repository's) last release tag. No package
filtering or branch guard options apply - this is a single, targeted lookup.

"Last release tag" is the same lookup [`version`](version.md#which-tag-a-packages-release-gets) and
[`changelog`](changelog.md) use: under `.rmanrc "changelog.tagPattern"`, or the pattern derived
from the repository's version lines (`v*` with one, `{name}@*` with several). Unless that key is
set, the whole-repository diff starts from the root's `v*` tag.

## Arguments

| Argument | Description |
| --- | --- |
| `package` | Package name - diffs just that package, since its own last tag (scoped to its directory via a git pathspec). Omit to diff the whole repository since its own last tag, or the current directory's package if you're standing inside one. |

## Options

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--from-root` | `-r` | boolean | Diff the whole repository even when standing inside one package's own directory (which otherwise scopes it to just that package). No effect when `package` is given. |

## Examples

```bash
rman diff                # since the repository's own last tag, whole repo
rman diff pkg-a          # since pkg-a's own last tag, scoped to packages/pkg-a
rman diff --from-root    # the whole repository, from inside a package's directory
```

The diff is git's own output, printed as it is - `diff` prints no status line around it, so
`rman diff > changes.patch` holds the patch and nothing else.

If `package` doesn't name a real package, prints `No such package "<name>"` (red) and exits with an
error. If the target has no release tag at all, prints `No release tag found for "<name>" -
nothing to diff against.` and exits successfully (nothing to compare). If there's a tag but nothing
has changed since it, prints `No changes since <tag>.`.

## See also

- [`rman version --show`](version.md) - a version-bump-level summary instead of a raw diff.
- [`rman changelog`](changelog.md) - a formatted, grouped changelog instead of a raw diff.
