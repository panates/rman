<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman build`

```
rman build [options...]
```

A literal alias for [`rman run build`](run.md) - same options, same behavior, just with
`commandName: 'build'` used for its own log-line labeling instead of `'run'`. Exists purely for
convenience/muscle memory (`rman build` reads better than `rman run build` for the one script
almost every project has).

**A contributed command may take the name.** `build` is one of the two built-ins (with
[`test`](test.md)) that carry no logic of their own, so a command a repository inherits - from a
shared config's `commands`, or its own `.rman/build.mjs` - replaces this alias rather than being
refused as a clash. The alias is then not registered at all, so `rman --help` lists one `build`;
the override is named at `--log-level verbose`. [`rman run build`](run.md) is always still there.
See [Precedence when two sources use one name](../cli-rman.md#precedence-when-two-sources-use-one-name).

## Options

Identical to [`rman run <script>`](run.md#options) (package filtering, branch guard, `--parallel`,
`--bail`, `--topo`, `--progress`, `--changed`/`--changed-since`, `--from-root`) - see that page
for the full table.

## Examples

```bash
rman build
rman build --changed              # only packages you have touched but not pushed
rman build --parallel 4
rman build --scope pkg-a --deps
```

## See also

- [`rman run <script>`](run.md) - the general form this is an alias of; also covers
  `.rmanrc run.build.*` configuration and the `if` expression grammar.
- [`rman test`](test.md) - the equivalent alias for `run test`.
