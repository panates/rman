<!-- verified against commit a36b6e5acf4c433f9c819753ea0ba707d39a4b9c - see ../cli.md for the baseline convention -->

# `rman info`

```
rman info [options]
```

Prints local environment information (OS, CPU, memory, shell, Node/npm/Yarn versions, git,
installed `rman`/`typescript` versions) alongside basic repository information (monorepo vs.
single package, name, version, root path, package count). Useful for bug reports and CI debugging.
No package filtering options apply - this command reports on the whole environment/repository.

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

```bash
rman info --json
# { "System": {...}, "Binaries": {...}, "Utilities": {...}, "npmPackages": {...},
#   "repository": { "type": "monorepo", "name": "my-monorepo", "version": "", "root": "...",
#                   "packageCount": 6 } }
```

## See also

- [`SystemInfo`](../api.md#systeminfo) - the two underlying functions (`getSystemInfo`,
  `getRepositoryInfo`), callable independently from your own scripts.
