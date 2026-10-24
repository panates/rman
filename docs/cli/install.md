<!-- verified against commit c118b93 (2.35.0) - see ../cli-rman.md for the baseline convention -->

# `rman install`

> Comes from the **[`node` built-in](../rman.md#the-node-built-in)**, like [`rman ci`](ci.md), and is
> there in every repository without being named.

```
rman install [options] [-- <package manager's own flags>]
rman i [options]
```

Installs the repository's dependencies **once, at the repository root**, with the repository's own
package manager - so nobody has to know whether this one is npm or pnpm. Run from inside a package,
it still installs at the root.

Unlike [`rman ci`](ci.md) it deletes nothing first: no `node_modules`, no lockfile. It installs into
what is there.

**Which package manager** is decided the way `ci` and `publish` decide it: `--package-manager`,
else `.rmanrc "packageManager.node"`, else the lockfile at the root (`package-lock.json` → npm,
`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock` → bun), else npm.

## Options

Each is spelled once here and translated for the tool that runs. A flag that tool has no spelling of
is refused before anything runs - pass its own flag after `--` instead.

| Option | npm | pnpm | bun | yarn |
| --- | --- | --- | --- | --- |
| `--frozen-lockfile` - exactly the lockfile, failing rather than changing it | `npm ci` | `--frozen-lockfile` | `--frozen-lockfile` | `--frozen-lockfile` |
| `--prod` - no `devDependencies` | `--omit=dev` | `--prod` | `--production` | - |
| `--ignore-scripts` - no lifecycle scripts | `--ignore-scripts` | `--ignore-scripts` | `--ignore-scripts` | - |
| `--lockfile-only` - update the lockfile, install nothing | `--package-lock-only` | `--lockfile-only` | `--lockfile-only` | - |
| `--offline` - the local cache only | `--offline` | `--offline` | `--offline` | - |
| `--prefer-offline` - the cache first, the network for what is missing | `--prefer-offline` | `--prefer-offline` | `--prefer-offline` | - |
| `--dry-run` - report, write nothing | `--dry-run` | `--dry-run` (11.8+) | `--dry-run` | - |
| `--registry <url>` - for this run | `--registry=<url>` | `--registry=<url>` | `--registry=<url>` | - |
| `--package-manager <name>` | `npm`, `yarn`, `pnpm`, `bun` - overrides the choice above | | | |

Spellings are each tool's own `install --help`: npm 11.12.1, pnpm 12.10.1, bun 1.4.2, yarn 3.4.1.

- **`--frozen-lockfile` is `npm ci` under npm**, which removes `node_modules` first - npm has no
  frozen install that keeps it. That is the one case this command deletes anything.
- **yarn takes `--frozen-lockfile` and nothing else here.** yarn 2+'s `install` has no production,
  offline, dry-run or registry flag; yarn 1 spells them differently. Both accept
  `--frozen-lockfile`.
- `--frozen-lockfile` with `--lockfile-only` is refused: one forbids changing the lockfile, the
  other only changes it.

## Examples

```bash
rman install
rman i --frozen-lockfile              # CI: exactly the lockfile
rman i --prod --ignore-scripts
rman i -- --legacy-peer-deps          # anything else goes to the package manager as written
```

## Notes

- **No package name.** `rman i lodash` is not taken: adding a dependency is `npm install <pkg>` but
  `pnpm add <pkg>` - a different verb with its own flags.
- [`rman ci`](ci.md) is the from-scratch version: it wipes every package's `node_modules` and
  lockfile, then installs.
