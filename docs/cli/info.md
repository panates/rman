<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

# `rman info`

```
rman info [options]
```

Prints local environment information (OS, CPU, memory, shell, Node + whichever package manager
`.rmanrc "packageManager"` actually configures (default npm), git, installed `rman`/`typescript`
versions) alongside basic repository information (monorepo vs. single package, name, version, root
path, package count). Useful for bug reports and CI debugging. No package filtering options apply -
this command reports on the whole environment/repository.

## Options

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--json` | `-j` | boolean | Print output as JSON instead of the formatted text report. |

## Examples

```bash
rman info
```

```
 System:
    OS      : macOS 15.1
    CPU      : (10) arm64 Apple M2 Pro
    Memory   : 2.1 GB / 32 GB
    Shell    : 5.9 - /bin/zsh
 Binaries:
    Node     : 22.9.0 - /usr/local/bin/node
    npm      : 10.8.3 - /usr/local/bin/npm
 Utilities:
    Git      : 2.46.0
 Repository:
    Type     : Monorepo
    Name     : my-monorepo
    Version  : (none)
    Root     : /Users/me/dev/my-monorepo
    Packages : 6 (run "list" to see them)
```

With `.rmanrc { "packageManager": "pnpm" }`, `Binaries` reports `pnpm`'s own version instead of
npm's - every package-manager-aware command (`ci`/`publish`) already shells out to the configured
one, not npm, so that's the version actually relevant here.

```bash
rman info --json
# { "System": {...}, "Binaries": {...}, "Utilities": {...}, "npmPackages": {...},
#   "repository": { "type": "monorepo", "name": "my-monorepo", "version": "", "root": "...",
#                   "packageCount": 6 } }
```

## See also

- [`SystemInfo`](../api.md#systeminfo) - the two underlying functions (`getSystemInfo`,
  `getRepositoryInfo`), callable independently from your own scripts.
