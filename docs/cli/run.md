<!-- verified against commit a36b6e5acf4c433f9c819753ea0ba707d39a4b9c - see ../cli.md for the baseline convention -->

# `rman run <script>`

```
rman run <script> [options...]
```

Runs an npm script (e.g. `build`, `lint`, `test`) in every matching package, in dependency order by
default, with concurrency, bail, and per-package/script `.rmanrc` configuration - including npm's
own `pre<script>`/`post<script>` convention. This is the general-purpose form; [`build`](build.md)
and [`test`](test.md) are just aliases for `run build`/`run test`.

## Options

Accepts [package filtering](../cli.md#package-filtering) and [branch guard](../cli.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--parallel <n>` | - | boolean \| number | CPU count | Max packages built at once: omit/`true` for CPU count (or `.rmanrc run.<script>.concurrency`), a number for that many, `false` to run serially (one at a time). Packages always build in dependency order regardless. |
| `--bail` | - | boolean | `true` | Stop the whole batch on the first failure. Overridable per-package via `.rmanrc run.<script>.bail` - see the precedence note below. |
| `--topo` | - | boolean | `true` | Respect the package dependency graph: a package waits for its dependencies and is skipped if one fails. Set `false` for independent scripts (`lint`, `test`, ...) - order becomes alphabetical and one package's failure never skips another. Overridable per-package via `.rmanrc run.<script>.topo`. |
| `--progress` | - | boolean | `true` | Show the live progress panel (auto-disabled when stdout isn't a TTY). Overridable via `.rmanrc run.<script>.progress`. |
| `--changed` | `-c` | boolean | `false` | Only run in packages that have changed since the last publish. |
| `--changed-since <hash>` | - | string | - | Only run in packages that have changed since the given git commit/hash. Falls back to `.rmanrc run.<script>.changedSince` (root-level) when omitted. |
| `--root` | `-r` | boolean | `false` | Run across the whole repository even when standing inside one package's own directory (which otherwise scopes the run to just that package, dropping the root pre/post hooks). No effect elsewhere. |

`--changed` and `--changed-since` conflict (pick one).

## Examples

```bash
rman run build                       # every package, dependency order, CPU-count concurrency
rman run lint --topo=false            # independent order - lint doesn't care about dependency graph
rman run test --changed               # only packages changed since the last publish
rman run build --changed-since v1.2.0
rman run build --parallel 4           # at most 4 packages at once
rman run build --parallel false       # serially, one at a time
rman run build --bail=false           # keep going even if one package's build fails
rman run build --scope pkg-a --deps   # pkg-a plus everything it depends on
rman run build --root                 # whole repo, even run from inside one package's directory
rman run build --log-level verbose    # also print each step's "executing" line before it runs
```

If no package (and no root pre/post hook) defines the given script at all, `rman` prints
`No package defines a "<script>" script.` and exits successfully - it's not an error to ask for a
script nothing implements.

## Per-package/script configuration (`.rmanrc run.<script>.*`)

Every option above has a matching `.rmanrc` key, cascaded per package, so you rarely need to repeat
flags on every invocation:

```yaml
run:
  build:
    concurrency: 2
    script: tsc -b # used only if the package's own package.json has no "build" script at all
    preScript: [node ./generate.js, node ./validate.js] # array -> run in sequence
    postScript: node ./copy-assets.js
    override: true # use these even if the package DOES already define build/prebuild/postbuild
  lint:
    topo: false # independent packages - alphabetical order, no dependency waiting
    bail: false # one package's lint failure doesn't stop the others
  test:
    skip: true # this package opts out of "test" entirely
    if: changed # only actually runs when this package has changed since the last publish
```

**Precedence** for `topo`/`progress`/`concurrency`/`logLevel`: explicit CLI flag > package's own
resolved `.rmanrc` > built-in fallback. **`bail` is the one exception:** a package's own `.rmanrc
bail` outranks even an explicit CLI `--bail`/`--no-bail` - "this package's failure must always stop
the batch" is a more specific, intentional statement than a broad flag meant for the whole run, and
shouldn't be silently overridden by it.

### Conditional execution (`if`)

`run.<script>.if` accepts a small boolean expression grammar (GitHub-Actions-`if`-flavored):
atoms `changed`, `dirty`, `committed` (each optionally `= <hash>` or `= {ENV_VAR}`, resolved from
`process.env` first), combined with `and`/`or`/`not`/`(...)` - `and` binds tighter than `or`.

```yaml
run:
  build:
    if: changed # changed since the last publish
  test:
    if: changed = a1b2c3d # changed since a specific commit
  deploy:
    if: changed = { CHANGE_HASH } # {NAME} substituted from process.env.NAME first
  lint:
    if: (changed or dirty) and not committed
```

An unrecognized atom name prints a one-time warning and evaluates to `true` (the package still
runs) rather than failing the whole command over a typo in the expression.

### Root pre/post hooks

If the repository root defines a `prebuild`/`postbuild` (matching `pre<script>`/`post<script>`)
npm script, or `.rmanrc run.<script>.preScript`/`.postScript`, it runs once each - exclusively,
before/after every package's own script - unless the root opts out via `run.<script>.skip`, fails
its own `run.<script>.if`, or the run is scoped to a single package (`--root` not given while
standing inside one package's own directory - a repo-wide bookend has no place there).

## See also

- [`build`](build.md) / [`test`](test.md) - aliases for `run build` / `run test`.
- [`exec`](exec.md) - the same scheduling machinery, but for an arbitrary shell command instead of
  an npm script (no pre/post hook convention).
- [`RunService`](../api.md#runservice) - the underlying service, including `parseIfExpr`/
  `evaluateIf` if you want to build your own tooling on the same `if` grammar.
