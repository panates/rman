<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman deps`

> **The command is rman's own.** *Which version a dependency may move to* is a technology's
> answer, and the [`node` built-in](../rman.md#the-node-built-in) gives npm's. A package whose
> technology has no answer is left alone.

```
rman deps [names..] [options...]
```

Lists the dependencies that have a newer version on their registry, and with `-u` writes the new
ranges to the manifests. It covers every package in the repository, the monorepo root's own
tooling included. `names` narrows the run to the dependencies matching those globs.

**A dependency stays inside its major by default.** A major is a break, and taking one is a decision
a person makes: `--target major` for one run, or `deps.target` / `deps.targets` for a standing answer.

A version is offered only when **every rule rman can see allows it**. Each package gets one table,
one row per dependency that has something newer:

```
app
  Dependency  Current  Upgrade  Latest   Change   Note
  esbuild     ^0.24.0  ^0.24.2  0.28.2   patch    major - deps.target is "minor"
  typescript  ^5.3.0   ^5.9.3   7.0.2    minor    major - deps.target is "minor"
  eslint      ^9.0.0   -        10.12.0  skipped  major - deps.target is "minor"
```

- **Upgrade** is the range `-u` would write; `-` when the dependency stays where it is.
- **Latest** is the newest version there is, whatever the settings say.
- **Change** is the size of the move (`patch`, `minor`, `major`), or why there is none: `held` -
  another dependency's rule refuses the newer version, named in full in the note - `skipped` - the
  package's own settings leave it out (a major under `target: minor`, a version younger than
  `minAge`) - or `error`. Rows that move come first, smallest first.
- **Note** says why a row stops short of **Latest**, for instance
  `7.0.2 refused: @typescript-eslint/parser@8.40.0 needs typescript >=4.8.4 <6.0.0`.

When nothing moves, the first line says so - `All dependencies are up to date.` - and says that a
table of what was left out follows when there is one, so a run with nothing to do does not read as a
list of things to do.

**Sizes are read the way a caret range reads them.** `^0.1.0` stops below `0.2.0`, because a `0.x`
minor may break; so `0.1.x -> 0.2.0` is a major here, and a package that has lived on `0.x` for
years only moves inside its minor until `deps.targets` says otherwise.

## What moves

Only a caret or tilde range on a plain version (`^1.2.3`, `~1.2.3`) is rewritten, and it keeps its
prefix. An exact version (`1.2.3`), a compound range (`>=1 <2`, `a || b`), a dist-tag, a URL, an
`npm:` alias, a `workspace:` range and a package of this repository are left as they are - and every
one of them still counts as a rule the others must keep.

**`peerDependencies` move like the rest.** A peer range is a promise to the package's consumers, so
moving it to a new major narrows what they may install. To keep a peer range where it is, write it
as a range rman does not rewrite - `">=5.3.0 <6"` rather than `"^5.3.0"`. It then also holds the
same name's `devDependencies` entry inside it (see rule 2 below).

That is the policy an `.ncurc.yml`'s `rejectVersion: "/(\\|\\|)|(&&)|>|<|^[0-9]/"` wrote by hand, so
an `.ncurc.yml` carrying it needs no translation.

A version is never offered when it is deprecated, above the registry's `latest` dist-tag, or a
prerelease while the declared range is not on one.

## What holds a version back

In this order:

1. **The package's own settings** - `deps.target` / `deps.targets`, `deps.reject`, `deps.minAge`
   (below).
2. **The package's other declarations of the same name.** A `devDependencies` caret is not moved
   outside the package's own `peerDependencies` range for that name. When every declaration of a
   name is a movable range, they move together.
3. **Node.** A version whose `engines.node` drops a Node release that the package supports (its own
   `engines.node`, or else the root's) and that the currently declared version still runs on.
4. **Another dependency's peer range**, at the version *that* dependency moves to - the
   `npm-check-updates --peer` check. When a newer version of the dependency stating the range would
   allow more, both move.
5. **A sibling package's peer range**, for a package that depends on that sibling.

Rules 4 and 5 are solved together: everything starts at its newest allowed version, and while a
rule is broken the side the rule is *about* steps down to the newest version it allows. Only when
none is left does the side stating the range step down instead. Nothing moves below what is declared
today, and a rule that the declared versions already break is left alone - it is the repository's
current state, not something this run introduced.

**A dependency's own dependency is out of sight.** Seeing it would mean reimplementing npm's
resolver, so `-u` asks the real one instead: after writing, rman runs
`npm install --dry-run --ignore-scripts` at the repository root. That writes nothing, and npm
refuses a peer conflict anywhere in the tree with `ERESOLVE`. If it does, **every manifest is put
back as it was** and the command fails with npm's own lines. `--no-verify` skips the check. Another
package manager (`.rmanrc "packageManager.node"`) is not asked, and a note says so.

`-u` does not install anything and does not touch the lockfile. Run your usual install afterwards.

## Speed

The registry is asked **once per dependency name**, however many packages declare it, and the
lookups run in parallel - 16 at a time by default (`--concurrency`). Measured on this organization's
repositories: 2.6s on `rman` against 6.8s for `ncu` over its two `package.json` files, and 5.8s on
`opra` (20 packages) against 27.2s for `ncu --workspaces --root`.

## Options

Accepts `--scope`, `--ignore` and `--platform` from [package filtering](../cli-rman.md#package-filtering),
in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--upgrade` | `-u` | boolean | Write the new ranges to the manifests, then check that they still install. |
| `--target` | - | `patch` \| `minor` \| `major` | The largest move a dependency may make (default `minor`). Overrides `deps.target` **and** `deps.targets` for this run. |
| `--reject` | - | string (repeatable) | Leave the dependencies matching these globs alone. Added to `deps.reject`. |
| `--min-age` | - | number | Only move to a version published at least this many days ago. Overrides `deps.minAge`. |
| `--concurrency` | - | number | How many registry lookups run at once (default `16`). |
| `--no-verify` | - | boolean | Do not ask the package manager whether the upgraded manifests install. |
| `--json` | `-j` | boolean | Print the plan as JSON: one row per package and dependency, with `package`, `name`, `types`, `status` (`update`/`held`/`skipped`/`up-to-date`/`error`), `current`, `target`, `latest` (newest the settings allow), `available` (newest there is), `bump`, `reason`. |

## Configuration

`.rmanrc "deps"`, read per package, so it cascades and a `"[selector]"` block can narrow it:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `target` | `patch` \| `minor` \| `major` | `minor` | The largest move a dependency may make. The sizes are the version scheme's own; the default is every size but the largest. |
| `targets` | `{ [glob]: size }` | - | The same, for the dependencies a glob matches - ahead of `target`. The last glob matching a name wins. |
| `reject` | string \| string[] | - | Globs over dependency names to leave alone. |
| `minAge` | number | `0` | Days a version must have been published before it is offered. |
| `types` | string[] | every kind | The dependency kinds to look at. npm's: `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, or `prod`/`dev`/`optional`/`peer`. |

```yaml
# .rmanrc.yml
deps:
  minAge: 3
  targets:
    "@types/node": major   # releases a major every few months
    esbuild: major         # has stayed on 0.x, where every minor counts as a major
"[legacy-*]":
  deps:
    target: patch
    reject: [typescript]
```

A kind left out of `types` is not moved, but its ranges still count as rules: a `peerDependencies`
range that is not looked at still holds back the `devDependencies` entry of the same name.

## Exit status

Non-zero when a registry lookup failed (the package is not on the registry, or there was no access),
or when `-u`'s check refused the upgrade. Everything that could be planned is still printed, and
under `-u` still written.
