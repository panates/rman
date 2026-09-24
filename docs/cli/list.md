<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli-rman.md for the baseline convention -->

# `rman list`

**Alias:** `rman ls`

```
rman list [options...]
```

Lists every package in the repository - version, location, private flag, and change status - as a
table by default, or one of several other formats. Purely a *view* over
[`ListService.getPackages`](../rman.md#listservice); this command never writes anything.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) (`--scope`, `--ignore`, `--platform`,
`--deps`, `--dependents`) in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--short` | `-s` | boolean | Do not show extended information - just the bare package names, one per line. |
| `--parseable` | `-p` | boolean | Show parseable output: `location::name::version::PRIVATE::STATUS` lines, one per package. |
| `--toposort` | `-t` | boolean | Sort packages in topological order (dependencies before dependents) instead of lexical directory order. |
| `--graph` | `-g` | boolean | Show the dependency graph as a JSON-formatted adjacency list (`{ "name": ["dep-a", "dep-b"] }`). |
| `--json` | `-j` | boolean | Show output as JSON (the full `ListService.Item[]` array). |
| `--changed` | `-c` | boolean | Only list packages that have changed since the last publish (dirty, or committed but not yet published). |
| `--changed-since <hash>` | - | string | Only list packages that have changed since the given git commit/hash. |

`--graph`/`--short` each conflict with `--parseable`/`--json` (yargs refuses the combination
outright); `--changed` conflicts with `--changed-since` (pick one).

## Examples

```bash
# Default table: Package / Version / Private / Changed / Path, plus a trailing count
rman list
```

```
Package     Version  Platform  Private  Changed  Path
----------  -------  --------  -------  -------  -----------------
my-repo     1.2.0    node      yes      dirty    .
  pkg-a     1.2.0    node               dirty    packages/pkg-a
  pkg-b     1.0.4    node      yes               packages/pkg-b

2 Package(s) found
```

**The table is a tree**: the root package first, then each package indented by how far below it it
sits - a package nested inside another indents twice. Discovery descends now, so a repository *is* a
tree, and the root is the row the rest hangs from. Indentation rather than box-drawing, so a name
stays copy-pasteable into `--scope`. The nesting is `Item.depth`, a fact about the package, so
`--toposort` reorders the rows and each one's indentation still tells the truth.

**The count is the workspace members**, root excluded - which is what `repository.packages` means,
and what every other form of this command reports.

**`Platform` is which technology claimed the package**, blank when none did. It matters most in a
polyglot repository, which is exactly what the walk finding nested packages of another platform made
possible - and until this column existed `rman list` was the one place that showed every package and
could not say which each belonged to.

```bash
rman ls --short
# pkg-a
# pkg-b

rman list --json
# [{ "name": "pkg-a", "selector": "pkg-a", "version": "1.2.0", "platform": "node", "depth": 1,
#    "isRoot": false, "location": "packages/pkg-a", "private": false, "status": "dirty",
#    "dependencies": [] }, ...]

rman list --parseable
# packages/pkg-a::pkg-a::1.2.0::::DIRTY
# packages/pkg-b::pkg-b::1.0.4::PRIVATE::

rman list --toposort              # dependencies printed before their dependents
rman list --graph                 # { "pkg-a": [], "pkg-b": ["pkg-a"] }
rman list --changed               # only packages with unpublished changes
rman list --changed-since v1.2.0  # only packages that differ from that tag
rman list --scope '@myorg/*' --ignore '*-internal'
rman list --platform=node,cargo   # a polyglot repository, two of its technologies
```

**The root row belongs to the table alone.** `--json`, `--parseable`, `--short` and `--graph` report
the workspace members exactly as before, so anything parsing them is unaffected; the tree still
reaches them as data, through `depth` and `isRoot`.

## See also

- [`rman changed`](changed.md) - similar idea, but scoped to what `version` would specifically bump.
- [`ListService`](../rman.md#listservice) - the underlying pure data function.
