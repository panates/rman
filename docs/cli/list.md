<!-- verified against commit a36b6e5acf4c433f9c819753ea0ba707d39a4b9c - see ../cli.md for the baseline convention -->

# `rman list`

**Alias:** `rman ls`

```
rman list [options...]
```

Lists every package in the repository - version, location, private flag, and change status - as a
table by default, or one of several other formats. Purely a *view* over
[`ListService.getPackages`](../api.md#listservice); this command never writes anything.

## Options

Accepts [package filtering](../cli.md#package-filtering) (`--scope`, `--ignore`, `--deps`,
`--dependents`) in addition to:

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
Package    Version  Private  Changed  Path
---------  -------  -------  -------  -----------------
pkg-a      1.2.0             dirty    packages/pkg-a
pkg-b      1.0.4    yes               packages/pkg-b

2 Package(s) found
```

```bash
rman ls --short
# pkg-a
# pkg-b

rman list --json
# [{ "name": "pkg-a", "version": "1.2.0", "location": "packages/pkg-a", "private": false,
#    "status": "dirty", "dependencies": [] }, ...]

rman list --parseable
# packages/pkg-a::pkg-a::1.2.0::::DIRTY
# packages/pkg-b::pkg-b::1.0.4::PRIVATE::

rman list --toposort              # dependencies printed before their dependents
rman list --graph                 # { "pkg-a": [], "pkg-b": ["pkg-a"] }
rman list --changed               # only packages with unpublished changes
rman list --changed-since v1.2.0  # only packages that differ from that tag
rman list --scope '@myorg/*' --ignore '*-internal'
```

## See also

- [`rman changed`](changed.md) - similar idea, but scoped to what `version` would specifically bump.
- [`ListService`](../api.md#listservice) - the underlying pure data function.
