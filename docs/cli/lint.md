<!-- verified against commit 8dca6d0f837692b06beb6968854ac08ed0a74724 - see ../cli-rman.md for the baseline convention -->

# `rman lint`

```
rman lint [options...]
```

A literal alias for [`rman run lint`](run.md) - same options, same behavior, just with
`commandName: 'lint'` used for its own log-line labeling instead of `'run'`. Exists for the same
reason [`build`](build.md) and [`test`](test.md) do: `rman lint` reads better than `rman run lint`
for a script most repositories have.

**It knows a script name and nothing else**, which is why it is a core command rather than the
`node` preset's. A Cargo package declaring `lint: 'cargo clippy'` and a Go one declaring
`golangci-lint run` are served by the same command; nothing here is npm's.

## Options

Identical to [`rman run <script>`](run.md#options) (package filtering, branch guard, `--parallel`,
`--bail`, `--topo`, `--progress`, `--changed`/`--changed-since`, `--from-root`) - see that page
for the full table.

## Examples

```bash
rman lint
rman lint --changed               # only packages with uncommitted or unpushed changes
rman lint --parallel 4
rman lint --scope pkg-a --deps
```

## See also

- [`rman run <script>`](run.md) - the general form this is an alias of; also covers
  `.rmanrc run.lint.*` configuration and the `if` expression grammar.
- [`rman build`](build.md), [`rman test`](test.md) - the other two aliases.
