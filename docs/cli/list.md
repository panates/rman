<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman list`

**Alias:** `rman ls`

```
rman list [options...]
```

Lists every package in the repository - version, location, private flag, where it publishes to,
and change status - as a
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
| `--changed` | `-c` | boolean | Only list packages you have **touched but not pushed** - uncommitted, or committed and not yet on the upstream branch. Not a release question: after a push this empties out. |
| `--changed-since <hash>` | - | string | Only list packages that have changed since the given git commit/hash. |

`--graph` conflicts with `--parseable`/`--json` (yargs refuses the combination outright);
`--changed` conflicts with `--changed-since` (pick one). The other output flags do not refuse each
other - the first of `--json`, `--parseable`, `--short` wins.

## Examples

```bash
# Default table: Package / Version / [Group] / Platform / Private / Publish / Changed / Path, plus a count
rman list
```

```
Package     Version  Platform  Private  Publish  Changed  Path
----------  -------  --------  -------  -------  -------  -----------------
my-repo     1.2.0    node      yes               dirty    .
  pkg-a     1.2.0    node               npm      dirty    packages/pkg-a
  pkg-b     1.0.4    node      yes      -                 packages/pkg-b

2 Package(s) found
```

**The table is a tree**: the root package first, then each package indented by how far below it it
sits - a package nested inside another indents twice. Discovery descends now, so a repository *is* a
tree, and the root is the row the rest hangs from. Indentation rather than box-drawing, so a name
stays copy-pasteable into `--scope`. The nesting is `Item.depth`, a fact about the package, so
`--toposort` reorders the rows and each one's indentation still tells the truth. Packages that do
not constrain each other keep their lexical order, so the output is diffable between runs.

**`--toposort` fails on a dependency cycle**, naming it; plain `rman list` does not, which is what
makes it the command to reach for when one is reported.

**The count is the workspace members**, root excluded - which is what `repository.packages` means,
and what every other form of this command reports.

**`Platform` is which technology claimed the package**, blank when none did. It matters most in a
polyglot repository, which is exactly what the walk finding nested packages of another platform made
possible - and until this column existed `rman list` was the one place that showed every package and
could not say which each belonged to.

**`Publish` is where each package ships**, one target name each - the same answer `publish` uses
to pick its candidates. A target `publish` would skip the package for is **left out**, and a package
left with none reads **`-`**: `.rmanrc "publish.skip"`, or the target's own rule (npm's: `private`
with no `publishConfig`, or `private` published in place). Above, `pkg-b` reads `-`. Decided
without the registry, so a name means a candidate, not a pending publish - whether the version is already out there is
[`publish --dry-run`](publish.md)'s answer. A monorepo's root is never a candidate and shows nothing.

**An npm package publishing elsewhere shows the registry's host** - `npm.pkg.github.com` for one
whose `publishConfig.registry` is GitHub Packages - and npm's own `registry.npmjs.org` stays `npm`.
Only `publishConfig.registry` is read: a scoped `@owner:registry=` in `.npmrc` is npm's to resolve,
so such a package still shows `npm`. A label only - it is still published with `--target npm`.

**`Group` is the release group** (`.rmanrc group`) - a named group by its name, the default one as
`(default)`, blank for a package in none (`group: false`) and for the root, as `version`'s plan
table shows it. **The rows keep each group together**: the root, then the groups in the order their
first member appears, then the ungrouped. Shown only where it says something - a named group, or
the default one beside ungrouped packages - and the order is left alone under `--toposort`, where
dependency order is the answer. A package nested inside another can then sit away from it; its
indentation still says how deep it is.

```bash
rman ls --short
# pkg-a
# pkg-b

rman list --json
# [{ "name": "pkg-a", "selector": "pkg-a", "version": "1.2.0", "platform": "node", "depth": 1,
#    "isRoot": false, "location": "packages/pkg-a", "private": false, "status": "dirty",
#    "groupKey": "default", "group": "default", "dependencies": [], "publishTargets": ["npm"],
#    "skippedTargets": {}, "targetLabels": {} }, ...]
# groupKey is the spelling version --json uses: default / named:<name> / solo:<package>
# skippedTargets maps a skipped target to why: { "npm": "private package" }
# targetLabels maps a target to what the table shows instead: { "npm": "npm.pkg.github.com" }

rman list --parseable
# packages/pkg-a::pkg-a::1.2.0::::DIRTY
# packages/pkg-b::pkg-b::1.0.4::PRIVATE::

rman list --toposort              # dependencies printed before their dependents
rman list --graph                 # { "pkg-a": [], "pkg-b": ["pkg-a"] }
rman list --changed               # only packages touched but not yet pushed
rman list --changed-since v1.2.0  # only packages that differ from that tag
rman list --scope '@myorg/*' --ignore '*-internal'
rman list --platform=node,cargo   # a polyglot repository, two of its technologies
```

**The root row belongs to the table alone.** `--json`, `--parseable`, `--short` and `--graph` report
the workspace members exactly as before, so anything parsing them is unaffected; the tree still
reaches them as data, through `depth` and `isRoot`.

## See also

- [`rman version --show`](version.md) - a **different question**, and the two are not
  interchangeable: `--changed` here is what you have touched (working tree + `git cherry`), so it
  empties out the moment you push; `version` asks what has changed since each package's last
  *release*. Measured on one repository with everything pushed and clean: `list --changed` found 0
  packages while `version --show` reported one waiting to be released. Never gate a release on this
  flag.
- [`ListService`](../rman.md#listservice) - the underlying pure data function.
