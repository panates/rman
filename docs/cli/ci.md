<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman ci`

> Comes from the **[`node` built-in](../rman.md#the-node-built-in)**, not from rman's core. Its preset
> is laid under every repository by default, so the command is there without being named; a caller
> passing `presets: []` gets a bare core without it. It acts on **node packages only** - in a
> polyglot repository the packages of other technologies are left alone, with no `--platform` needed.

```
rman ci [options]
```

A from-scratch, reproducible install for CI pipelines. For every package (root included), deletes
`node_modules` and any known lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
`bun.lock`, `bun.lockb`) - or runs the package's own `"ci"` npm script instead, if it defines one.
Once every package is clean, installs **once** at the root with the configured package manager.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Type | Choices | Description |
| --- | --- | --- | --- |
| `--package-manager <name>` | string | `npm`, `yarn`, `pnpm`, `bun` | Package manager to install with. Default: the root's `.rmanrc "packageManager.node"`, else `npm`. |
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
- `.rmanrc "packageManager"` is keyed by technology - `packageManager: { node: pnpm }` - and is
  validated: a tool Node does not have throws `Invalid "packageManager.node" in .rmanrc: "<value>"
  (expected one of: npm, yarn, pnpm, bun)`, and the old bare `packageManager: pnpm` is refused with
  the spelling to use instead, rather than silently installing with npm.

## See also

- [`rman clean`](clean.md) - removes *build output*, never touches `node_modules` (the opposite
  concern from `ci`).
- [`CiService`](../rman.md#the-node-built-in) - the underlying service, including the standalone `wipe()`
  primitive for wiping one directory yourself.
