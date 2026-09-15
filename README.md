# rman

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

**rman** is a monorepo management CLI: a self-contained alternative to reaching for Lerna,
Changesets, and a handful of shell scripts glued together. One tool for running scripts across
packages, computing semantic version bumps from your commit history, publishing, changelogs,
importing external repos with history intact, and more - all driven by a single, cascading
`.rmanrc`/`.rmanrc.yml` config.

Every command is also available as a **programmatic API** - see [docs/api.md](docs/api.md) if you
want to call `rman`'s logic directly from a Node.js script instead of shelling out to the CLI.

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Programmatic API](#programmatic-api)
- [Node compatibility](#node-compatibility)
- [License](#license)

## Installation

```bash
npm install --save-dev rman
```

Or run it without installing, via `npx`:

```bash
npx rman list
```

`rman` requires **Node.js >= 20**.

## Quick start

`rman` auto-detects your repository layout - point it at a directory containing a `package.json`
with a `workspaces` array (npm/yarn/pnpm-style) and every matched package becomes available to
every command:

```json
// package.json (repository root)
{
  "name": "my-monorepo",
  "private": true,
  "workspaces": ["packages/*"]
}
```

```bash
# See what's in the repository
rman list

# Run "build" in every package, dependencies first
rman build

# See what the next release would look like, without changing anything
rman version

# Apply it: bump versions, write CHANGELOG.md, commit, tag
rman version --changelog

# Publish everything that isn't already on the registry
rman publish
```

Run any command with `--help` for its full option list (`rman version --help`, `rman run --help`, ...).

## Commands

The summaries and examples below cover the common cases. For the full option list, defaults, and
worked examples of every single command, see **[docs/cli.md](docs/cli.md)**.

| Command | Purpose |
| --- | --- |
| [`list` (`ls`)](#rman-list) | Lists packages in the repository. |
| [`info`](#rman-info) | Prints local environment and repository information. |
| [`run <script>`](#rman-run-script) | Runs an npm script in each package. |
| [`build`](#rman-build) | Alias for `run build`. |
| [`test`](#rman-test) | Alias for `run test`. |
| [`exec <command..>`](#rman-exec-command) | Runs an arbitrary shell command in each package. |
| [`ci`](#rman-ci) | Deletes `node_modules`/lockfiles everywhere, then reinstalls from scratch. |
| [`clean`](#rman-clean) | Removes compiled TypeScript output and configured extra files/dirs. |
| [`changed`](#rman-changed) | Shows which packages the next `version` run would bump. |
| [`diff [package]`](#rman-diff-package) | Shows the git diff since a package's (or the repo's) last release tag. |
| [`changelog`](#rman-changelog) | Generates a changelog per package from unreleased commits. |
| [`version [bump]`](#rman-version-bump) | Bumps versions of changed packages (and their dependents). |
| [`publish`](#rman-publish) | Publishes every package to its configured target(s) - npm, Docker and/or GitHub Releases. |
| [`import <path>`](#rman-import-path) | Imports an external git repository as a new package, with history. |

Options shared across several commands:

- **Package filtering** (`list`, `run`/`build`/`test`, `exec`, `ci`, `clean`, `version`, `publish`,
  `changelog`): `--scope <glob>`, `--ignore <glob>`, `--deps`, `--dependents` - see
  [Package filtering](docs/api.md#package-filtering-scopeignoredepsdependents) for the full
  semantics.
- **Branch guard** (every command that mutates state or runs scripts - `run`/`build`/`test`,
  `exec`, `ci`, `clean`, `version`, `publish`): `--allow-branch <glob>`, `--ignore-branch <glob>` -
  refuses to run unless (or if) the current git branch matches, the same idea as GitHub Actions'
  own `branches`/`branches-ignore` workflow filters.

### `rman list`

Lists packages in the repository (alias: `ls`).

```bash
rman list                       # table: Package / Version / Private / Changed / Path
rman ls --short                 # just the bare package names
rman list --json                # full detail as JSON
rman list --parseable           # location::name::version::PRIVATE::STATUS lines, for scripting
rman list --toposort            # dependencies before dependents, instead of directory order
rman list --graph               # dependency graph as a JSON adjacency list
rman list --changed             # only packages changed since the last publish
rman list --changed-since HEAD~5
rman list --scope '@myorg/*' --ignore '*-internal'
```

### `rman info`

Prints local environment (OS/CPU/memory, Node + whichever package manager `.rmanrc
"packageManager"` configures, git) and repository information.

```bash
rman info
rman info --json
```

### `rman run <script>`

Runs an npm script in each package, in dependency order by default.

```bash
rman run build
rman run lint --topo=false          # independent packages, alphabetical order, no dependency waiting
rman run test --changed             # only in packages changed since the last publish
rman run build --changed-since v1.2.0
rman run build --parallel 4         # at most 4 packages at once
rman run build --parallel false     # serially, one at a time
rman run build --bail=false         # don't stop the whole batch on one package's failure
rman run build --scope pkg-a --deps # pkg-a plus everything it depends on
```

Per-package/script behavior (pre/post hooks, `if` conditions, skip, concurrency, ...) is
configurable via `.rmanrc run.<script>.*` - see [Configuration](#configuration) below and the full
writeup in [docs/api.md](docs/api.md#runservice).

### `rman build`

Alias for `rman run build`.

```bash
rman build
```

### `rman test`

Alias for `rman run test`.

```bash
rman test
```

### `rman exec <command..>`

Runs an arbitrary shell command in each package - unlike `run`, it isn't tied to any npm script.

```bash
rman exec rm -rf dist
rman exec -- eslint --fix          # "--" needed only if the command shares a flag name with exec's own
rman exec --scope pkg-a -- ls -la
rman exec --topo=false pwd         # every package independently, alphabetical order
```

### `rman ci`

Deletes `node_modules` and any lockfile in every package (or runs the package's own `"ci"` script
instead, if it defines one), then installs once at the root.

```bash
rman ci
rman ci --package-manager pnpm
```

### `rman clean`

Removes compiled TypeScript output (`.js`/`.js.map`/`.d.ts` under `src`/`test`, plus any
`*.tsbuildinfo`) and whatever `.rmanrc clean.include`/`clean.exclude` configures. Never touches
`node_modules` - that's `ci`'s job.

```bash
rman clean
rman clean --dry-run              # preview what would be removed
```

### `rman changed`

Shows which packages the next `rman version` run would bump, without changing anything.

```bash
rman changed
rman changed --json
```

### `rman diff [package]`

Shows the git diff since a package's (or the whole repository's) last release tag.

```bash
rman diff                # since the repository's own last tag
rman diff pkg-a          # since pkg-a's own last tag, scoped to its directory
```

### `rman changelog`

Generates a changelog per package from unreleased commits, grouped into ✨ Features / 🐛 Bug Fixes
/ 🔧 Other Changes.

```bash
rman changelog                          # auto-detects each package's own last release
rman changelog --from a1b2c3d           # since a specific commit, for every package
rman changelog --write                  # prepend into each package's own CHANGELOG.md
rman changelog --write --file-path docs/CHANGELOG.md
```

### `rman version [bump]`

Bumps versions of changed packages (and their in-group dependents), grouped via `.rmanrc "group"`.

```bash
rman version                     # auto-detect severity from commits, preview only - writes nothing
rman version --interactive       # preview, then ask for confirmation either way
rman version patch               # apply a patch bump to every changed package/group, immediately
rman version minor
rman version major
rman version 2.0.0-rc.1          # an explicit semver version, applied verbatim
rman version minor --preid beta  # 1.2.3 -> 1.3.0-beta.0 (run again with --preid beta to increment it)
rman version --changelog         # also write/fold in each bumped package's CHANGELOG.md
rman version patch --push        # commit, tag, and push in one go
rman version patch --message "chore(release): {version}"
rman version --ignore-dirty      # exclude dirty packages instead of aborting the whole run
rman version patch --show        # preview what an explicit patch bump would do, without applying it
```

Severity, when not given explicitly, is auto-detected per package/group from
[Conventional Commits](https://www.conventionalcommits.org/) since that group's last release tag -
`fix:` → patch, `feat:` → minor, `feat!:`/a `BREAKING CHANGE:` footer → major. A `Release-As:
patch|minor|major` commit-body footer can override one specific commit's own contribution to that
- e.g. to ship a `feat:` as a patch right now instead of waiting for the rest of a minor's worth of
work:

```
feat: needs to ship right now

Release-As: patch
```

See [docs/api.md#versionservice](docs/api.md#versionservice) for the full grouping/propagation
algorithm, prerelease semantics, and `"workspace:"` dependency-range handling.

### `rman publish`

Publishes every package to its configured registry - `npm` by default, or whatever each package's
own `.rmanrc "publish.target"` says (`"npm"`, `"docker"`, or both). Each target decides for itself
whether the current version is already out there: `npm view` on the npm side, `docker manifest
inspect` on the docker side.

```bash
rman publish                              # show the plan, then ask for confirmation
rman publish --yes                        # publish immediately, no confirmation
rman publish --dry-run                    # only show the plan, never publish
rman publish --access public               # required for a new scoped package
rman publish --tag next
rman publish --otp 123456
rman publish --registry https://registry.example.com --userconfig ./ci.npmrc
rman publish --package-manager pnpm
rman publish --target docker              # only the packages configured for the "docker" target
```

A `"workspace:*"`/`"workspace:^"`/`"workspace:~"` dependency range is automatically rewritten to a
real, registry-consumable range immediately before each package's publish, and restored right
after - see [docs/api.md#publishservice](docs/api.md#publishservice).

A package opts into building/pushing a Docker image via `.rmanrc "publish.target": ["docker"]` plus
a `"publish.docker"` block (`image`, `platforms`, `buildContexts`, `buildArgs`, ...) - see
[docs/cli/publish.md#docker-publishing-publishdocker](docs/cli/publish.md#docker-publishing-publishdocker).

### `rman github-release`

Creates the repository's GitHub Release for the version that just shipped - one per run, named after
the repository's own release tag, with notes covering every package that shipped under it.

```bash
rman github-release --yes
```

It is deliberately neither a `publish.target` nor opt-in: a release isn't a registry a package ships
to, it's the repository's own record that a version shipped, and every repository wants that record.
It needs no configuration at all - see
[docs/cli/github-release.md](docs/cli/github-release.md).

### `rman import <path>`

Imports an external git repository as a new package, preserving its **entire commit history**
(`git blame`/`git log --follow` keep working on the imported files afterward).

```bash
rman import ../my-old-standalone-repo
rman import ../my-old-standalone-repo --dest libs   # under libs/ instead of packages/
```

`path` must be a local clone (not a URL) - clone the source repository first if it isn't local
already. After importing, add the new directory to your `workspaces` glob if it isn't already
covered, then run `rman ci` to install it.

## Configuration

`rman` reads config cascaded from the repository root down to each package's own directory (the
same way a `tsconfig.json` `extends` chain works) - a value set closer to a package overrides the
same key set further up. Several file forms are supported per directory, merged in increasing
precedence: `package.json`'s own `"rman"` key, `.rmanrc.yml` (YAML), `.rmanrc` (**JSON**, despite
the dotfile-style name), and `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js` for config that needs real
logic (a JS module's default export).

```yaml
# .rmanrc.yml, at the repository root
packageManager: pnpm
logLevel: info
allowBranch: [main, release/*]

group: true # implicit repo-wide version group by default

version:
  commitMessage: 'chore(release): v{version}'

changelog:
  ignoreTypes: [chore, ci]
  tagPattern: 'v*'

run:
  build:
    concurrency: 4
  lint:
    topo: false
    bail: false
  test:
    changedSince: v1.0.0
```

```json
// packages/core/.rmanrc - this one package overrides just its own group
{ "group": false }
```

```json
// packages/plugin-a/.rmanrc - versions together with plugin-b, independent of everyone else
{ "group": "plugins" }
```

See [docs/api.md#configuration-rmanrc-rmanrcyml](docs/api.md#configuration-rmanrc-rmanrcyml) for the
full key reference (every `run.<script>.*` sub-key, `clean.*`, `changelog.*`, precedence rules,
and which keys are root-level-only today).

**Editor autocomplete:** `rman` ships a JSON Schema for `.rmanrc`/`.rmanrc.yml` at
`rman/rmanrc.schema.json` - add `"$schema": "./node_modules/rman/rmanrc.schema.json"` to your
`.rmanrc` (or the equivalent `# yaml-language-server: $schema=...` comment in `.rmanrc.yml`) to get
autocomplete and validation in VS Code/WebStorm. For a `.rmanrc.cjs`/`.mjs`/`.js` config, wrap it in
the exported `defineConfig()` helper instead for the same autocomplete via the `RmanConfig` type:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman';
export default defineConfig({ packageManager: 'pnpm' });
```

See
[docs/api.md#editor-support-json-schema](docs/api.md#editor-support-json-schema) for details,
including a WebStorm setup that needs no changes to the config file itself.

## Programmatic API

Every command above is a thin wrapper around an exported service function - call them directly
from your own Node.js scripts without shelling out to the `rman` binary:

```ts
import { Repository, VersionService } from 'rman';

const repository = await Repository.create();
const plan = await VersionService.getPlan(repository);
await VersionService.applyPlan(repository, plan, { changelog: true, push: true });
```

Full reference, with detailed examples for every service (`VersionService`, `PublishService`,
`ChangelogService`, `RunService`, `CiService`, `CleanService`, `ExecService`, `ListService`,
`ImportService`, `SystemInfo`) and the `Repository`/`Package` core classes: **[docs/api.md](docs/api.md)**.

## Node compatibility

- Node.js >= 20

## License

rman is available under the [MIT](LICENSE) license.

[npm-image]: https://img.shields.io/npm/v/rman
[npm-url]: https://npmjs.org/package/rman
[downloads-image]: https://img.shields.io/npm/dm/rman.svg
[downloads-url]: https://npmjs.org/package/rman
[ci-test-image]: https://github.com/panates/rman/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/rman/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/rman/dev.svg
[coveralls-url]: https://coveralls.io/r/panates/rman
