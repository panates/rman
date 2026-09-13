<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

# `rman build`

```
rman build [options...]
```

A literal alias for [`rman run build`](run.md) - same options, same behavior, just with
`commandName: 'build'` used for its own log-line labeling instead of `'run'`. Exists purely for
convenience/muscle memory (`rman build` reads better than `rman run build` for the one script
almost every project has).

## Options

Identical to [`rman run <script>`](run.md#options) (package filtering, branch guard, `--parallel`,
`--bail`, `--topo`, `--progress`, `--changed`/`--changed-since`, `--root`) - see that page for the
full table.

## Examples

```bash
rman build
rman build --changed              # only packages changed since the last publish
rman build --parallel 4
rman build --scope pkg-a --deps
```

## See also

- [`rman run <script>`](run.md) - the general form this is an alias of; also covers
  `.rmanrc run.build.*` configuration and the `if` expression grammar.
- [`rman test`](test.md) - the equivalent alias for `run test`.
