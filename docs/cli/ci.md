<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

# `rman ci`

```
rman ci [options]
```

A from-scratch, reproducible install for CI pipelines. For every package (root included), deletes
`node_modules` and any known lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
`bun.lock`, `bun.lockb`) - or runs the package's own `"ci"` npm script instead, if it defines one.
Once every package is clean, installs **once** at the root with the configured package manager.

## Options

Accepts [package filtering](../cli.md#package-filtering) and [branch guard](../cli.md#branch-guard)
options, in addition to:

| Option | Type | Choices | Description |
| --- | --- | --- | --- |
| `--package-manager <name>` | string | `npm`, `yarn`, `pnpm`, `bun` | Package manager to install with. Default: `npm`, or `.rmanrc "packageManager"` (root-level). |
| `--progress` | boolean | - | Show a live progress panel while running (default `true`; auto-disabled when not a TTY). Unlike `run`/`build`, completion is **not** reported as a per-package tally - only failures are called out by name. |

## Examples

```bash
rman ci
rman ci --package-manager pnpm
rman ci --scope pkg-a               # only wipe/reinstall this one package (root install still runs)
rman ci --progress=false            # plain sequential log lines instead of the live panel
```

```
rmdir      pkg-a  node_modules
rmdir      pkg-a  package-lock.json
clean      pkg-b
install    Running "npm install"
ci completed (4.2s)
```

## Notes

- Never touches anything beyond `node_modules`/lockfiles and the final install - it does not run
  `build`/`test`. Chain it with `rman build`/`rman test` in a CI script if you need those too.
- `.rmanrc packageManager` is validated: an invalid value throws `Invalid "packageManager" in
  .rmanrc: "<value>" (expected one of: npm, yarn, pnpm, bun)` rather than silently falling back.

## See also

- [`rman clean`](clean.md) - removes *build output*, never touches `node_modules` (the opposite
  concern from `ci`).
- [`CiService`](../api.md#ciservice) - the underlying service, including the standalone `wipe()`
  primitive for wiping one directory yourself.
