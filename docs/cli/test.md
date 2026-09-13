<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

# `rman test`

```
rman test [options...]
```

A literal alias for [`rman run test`](run.md) - same options, same behavior, just with
`commandName: 'test'` used for its own log-line labeling instead of `'run'`.

## Options

Identical to [`rman run <script>`](run.md#options) (package filtering, branch guard, `--parallel`,
`--bail`, `--topo`, `--progress`, `--changed`/`--changed-since`, `--root`) - see that page for the
full table.

## Examples

```bash
rman test
rman test --topo=false            # test packages are usually independent of each other
rman test --changed               # only packages changed since the last publish
```

A common setup: since tests are typically independent of the build dependency graph, disable
`--topo` (or set it per-script via `.rmanrc run.test.topo: false`) so one package's test failure
never skips an unrelated package's tests.

## See also

- [`rman run <script>`](run.md) - the general form this is an alias of.
- [`rman build`](build.md) - the equivalent alias for `run build`.
