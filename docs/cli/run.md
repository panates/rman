<!-- verified against commit 0e33a0a - see ../cli-rman.md for the baseline convention -->

# `rman run <script>`

```
rman run <script> [options...]
```

Runs an npm script (e.g. `build`, `lint`, `test`) in every matching package, in dependency order by
default, with concurrency, bail, and per-package/script `.rmanrc` configuration - including npm's
own `pre<script>`/`post<script>` convention. This is the general-purpose form; [`build`](build.md)
and [`test`](test.md) are just aliases for `run build`/`run test`.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--parallel <n>` | - | boolean \| number | CPU count | Max packages built at once: omit/`true` for CPU count (or `.rmanrc run.<script>.concurrency`), a number for that many, `false` to run serially (one at a time). Packages always build in dependency order regardless. |
| `--bail` | - | boolean | `true` | Stop the whole batch on the first failure. Overridable per-package via `.rmanrc run.<script>.bail` - see the precedence note below. |
| `--topo` | - | boolean | `true` | Respect the package dependency graph: a package waits for its dependencies and is skipped if one fails. Set `false` for independent scripts (`lint`, `test`, ...) - order becomes alphabetical and one package's failure never skips another. Overridable per-package via `.rmanrc run.<script>.topo`. |
| `--progress` | - | boolean | `true` | Show the live progress panel (auto-disabled when stdout isn't a TTY). Overridable via `.rmanrc run.<script>.progress`. |
| `--changed` | `-c` | boolean | `false` | Only run in packages that have changed since the last publish. |
| `--changed-since <hash>` | - | string | - | Only run in packages that have changed since the given git commit/hash. Falls back to `.rmanrc run.<script>.changedSince` (root-level) when omitted. |
| `--from-root` | `-r` | boolean | `false` | Run across the whole repository even when standing inside one package's own directory (which otherwise scopes the run to just that package, dropping the root pre/post hooks). No effect elsewhere. |

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
rman run build --from-root            # whole repo, even from inside one package's directory
rman run build --log-level verbose    # also print each step's "executing" line before it runs
```

A run with nothing in it ends two different ways, and the difference matters to a CI gate:

- **Nothing defines the script** (no package, and no root `pre`/`post` bookend): `No package defines
  a "<script>" script.` and a **non-zero exit**. The name is a mistake - a typo, or a script that
  used to exist - and `npm run` fails on exactly this. Note a monorepo root's own `<script>` does
  *not* count: the root contributes only its `pre`/`post` hooks, so a `qc` defined only there is
  this case, not an excuse for it.
- **Every package was filtered out** by `--scope`/`--changed`, a `run.<script>.skip`, or an `if:`
  that didn't match: `Nothing to run - every package was filtered out of "<script>".` and a
  **successful exit**. Zero is the right answer to what was asked; "build only what changed" must
  not fail a pipeline on a run where nothing changed.

## Per-package/script configuration (`.rmanrc run.<script>.*`)

Every option above has a matching `.rmanrc` key, so you rarely need to repeat flags on every
invocation. **Who a block is about follows the one config rule** (see
[the config reference](../rman.md#configuration-rmanrc--rmanrcyml)): unmarked keys configure the
package of the directory declaring them, and a `"[selector]"` block configures the packages it
names - so at the repository root, package-facing script config goes under `"[*]"`:

```yaml
"[*]":
  run:
    test: mocha # a bare string is shorthand for { exec: mocha }
    build:
      concurrency: 2
      before: [node ./generate.js, node ./validate.js] # array -> run in sequence
      exec: tsc -b # used only if the package's own package.json has no "build" script at all
      after: node ./copy-assets.js
      override: true # use these even if the package DOES already define build/prebuild/postbuild
    lint:
      topo: false # independent packages - alphabetical order, no dependency waiting
      bail: false # one package's lint failure doesn't stop the others
    coverage:
      skip: true # these packages opt out of "coverage" entirely
      if: changed # only actually runs when the package has changed since the last publish
```

Values may embed [`${{ ... }}` expressions](../rman.md#expressions---), evaluated per package - so one
declaration can still say something package-specific (`../../coverage/${{ pkg.basename }}`,
`app:${{ git.shortSha ?? 'local' }}`).

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
npm script, or an **unmarked** `.rmanrc run.<script>.before`/`.after`, it runs once each -
exclusively, before/after every package's own script - unless the root opts out via
`run.<script>.skip`, fails its own `run.<script>.if`, or the run is scoped to a single package
(`--from-root` not given while standing inside one package's own directory - a repo-wide bookend
has no place there).

Unmarked is the operative word: a bookend command is run at the repository root, so a
package-relative one (`node ../../support/postbuild.cjs`) belongs under `"[*]"`, not here. There is
no bookend in a single-package repository - the root *is* the one package, already running these
hooks in the same directory, so a bookend would simply run each of them twice.

## See also

- [`build`](build.md) / [`test`](test.md) - aliases for `run build` / `run test`.
- [`exec`](exec.md) - the same scheduling machinery, but for an arbitrary shell command instead of
  an npm script (no pre/post hook convention).
- [`RunService`](../rman.md#runservice) - the underlying service, including `parseIfExpr`/
  `evaluateIf` if you want to build your own tooling on the same `if` grammar.
