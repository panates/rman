<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman test`

```
rman test [options...]
```

A literal alias for [`rman run test`](run.md) - same options, same behavior, just with
`commandName: 'test'` used for its own log-line labeling instead of `'run'`.

**A contributed command may take the name**, and this is the alias that made it necessary: in a
repository whose tests are one run at the root rather than a script per package, `rman test` fanned
out over packages defining nothing and answered `No package defines a "test" script.` A command the
repository inherits - from a shared config's `commands`, or its own `.rman/test.mjs` - now replaces
this alias instead of being refused as a clash with a built-in. The alias is then not registered at
all, so `rman --help` lists one `test`; the override is named at `--log-level verbose`.
[`rman run test`](run.md) is always still there for tests that really are per package. See
[Precedence when two sources use one name](../cli-rman.md#precedence-when-two-sources-use-one-name).

## Options

Identical to [`rman run <script>`](run.md#options) (package filtering, branch guard, `--parallel`,
`--bail`, `--topo`, `--progress`, `--changed`/`--changed-since`, `--from-root`) - see that page
for the full table.

## Examples

```bash
rman test
rman test --topo=false            # test packages are usually independent of each other
rman test --changed               # only packages you have touched but not pushed
```

A common setup: since tests are typically independent of the build dependency graph, disable
`--topo` (or set it per-script via `.rmanrc run.test.topo: false`) so one package's test failure
never skips an unrelated package's tests.

## See also

- [`rman run <script>`](run.md) - the general form this is an alias of.
- [`rman build`](build.md) - the equivalent alias for `run build`.
