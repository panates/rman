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

Every command is also available as a **programmatic API** - see [docs/rman.md](https://github.com/panates/rman/blob/main/docs/rman.md) if you
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
worked examples of every single command, see **[docs/cli-rman.md](https://github.com/panates/rman/blob/main/docs/cli-rman.md)**.

| Command | Purpose |
| --- | --- |
| [`list` (`ls`)](#rman-list) | Lists packages in the repository. |
| [`info`](#rman-info) | Prints local environment and repository information. |
| [`run <script>`](#rman-run-script) | Runs an npm script in each package. |
| [`build`](#rman-build) | Alias for `run build`. |
| [`test`](#rman-test) | Alias for `run test`. |
| [`exec <command..>`](#rman-exec-command) | Runs an arbitrary shell command in each package. |
| [`config`](#rman-config) | Prints the effective `.rmanrc` config for the current directory's package. |
| [`diff [package]`](#rman-diff-package) | Shows the git diff since a package's (or the repo's) last release tag. |
| [`changelog`](#rman-changelog) | Generates a changelog per package from unreleased commits. |
| [`deps [names..]`](#rman-deps-names) | Lists dependencies with a newer version; `-u` upgrades them. |
| [`version [bump]`](#rman-version-bump) | Bumps versions of changed packages (and their dependents). |
| [`publish`](#rman-publish) | Publishes every package whose version isn't on its registry yet. |
| [`github-release`](#rman-github-release) | Creates the repository's GitHub Release for its release tag. |
| [`import <path>`](#rman-import-path) | Imports an external git repository as a new package, with history. |

**`ci` and `clean` come from the `node` built-in**, which ships inside this package - each is about
npm or TypeScript rather than about repositories. It needs no declaration: rman lays its own `node`
preset under every repository, so a clone with no `.rmanrc` at all already has them, plus the `node`
technology itself and the npm publish target. It used to take a second package (`rman-node`) and a
`.rmanrc` before anything worked.

A preset is an ordinary rman config rather than a type of its own, so another technology arrives the
same way and a polyglot repository asks for both:

```yaml
extends: ['rman:node', 'rman:cargo']
```

**`plugins: ['node']` is not a way to name a technology and is refused**, with a message saying so.
That key takes a plugin instance or a glob naming modules that export one; a name is what `extends`
resolves. The keys that do exist:

```yaml
platform: node      # which technology claims *this directory* - it does not load anything
platforms: [...]    # contributes technologies: an instance, or a glob naming modules exporting one
```

Whatever a repository declares is asked about a directory **before** the default preset, so
`extends: 'rman:cargo'` in a root holding both a `Cargo.toml` and a tooling `package.json` resolves
to what it declared.

**`publish` is here, but *where* a package ships is a plugin's to say.** A **publish target** is
one answer to "is this version on the registry, and how do I push it" - rman ships `docker`
(any language's project can push an image), and the `node` built-in contributes `npm` with the flags
that only mean something there (`--access`, `--tag`, `--otp`, `--registry`, ...). So
`rman publish --help` lists what this repository's targets actually understand.

Options shared across several commands:

- **`skip`** (`.rmanrc`, per package): leave this package alone - honoured by every command that
  *acts* on packages, ignored by `list`, which reports on them.
- **Package filtering** (`list`, `run`/`build`/`test`, `exec`, `version`, `changelog`, `publish`,
  `deps`, `clean`, `ci`, and a plugin's own commands): `--scope <glob>`, `--ignore <glob>`, `--deps`, `--dependents` - see
  [Package filtering](https://github.com/panates/rman/blob/main/docs/rman.md#package-filtering-scopeignoreplatformdepsdependents)
  for the full semantics. **`--scope /` is the repository's own root package** - the same `/`
  `.rmanrc`'s `"[/]"` block uses, and not a glob, so `--scope '*'` means the members and a glob
  never picks up the root by name.
- **`--from-root`/`-r`** (every command that narrows to the package you are standing in -
  `run`/`build`/`test`, `exec`, `clean`, `changelog`, `diff`, `config`): run against the whole
  repository instead.
- **Branch guard** (every command that mutates state or runs scripts - `run`/`build`/`test`,
  `exec`, `version`, `publish`, `github-release`, `clean`, `ci`): `--allow-branch <glob>`, `--ignore-branch <glob>` -
  refuses to run unless (or if) the current git branch matches, the same idea as GitHub Actions'
  own `branches`/`branches-ignore` workflow filters.

### `rman list`

Lists packages in the repository (alias: `ls`).

```bash
rman list                       # table: Package / Version / Group / Platform / Private / Publish / Changed / Path
rman ls --short                 # just the bare package names
rman list --json                # full detail as JSON
rman list --parseable           # location::name::version::PRIVATE::STATUS lines, for scripting
rman list --toposort            # dependencies before dependents, instead of directory order
rman list --graph               # dependency graph as a JSON adjacency list
rman list --changed             # only packages you have touched but not pushed
rman list --changed-since HEAD~5
rman list --scope '@myorg/*' --ignore '*-internal'
```

The table keeps each release group together, in `version`'s plan order (root, then groups, then
packages in no group), and indents a package by how deep it sits. `Group` appears only when it says
something; `Publish` names the targets a package ships to, or `-` when none is left. `--toposort`
orders by dependencies instead, and `--json` keeps the inventory's own order.

### `rman info`

Prints local environment (OS/CPU/memory, Node, git) and repository information. A platform adds its
own ecosystem's part - the `node` built-in reports whichever package manager
`.rmanrc "packageManager.node"` names (`npm` by default), plus the installed `rman` and `typescript`.

```bash
rman info
rman info --json
```

### `rman run <script>`

Runs an npm script in each package, in dependency order by default.

```bash
rman run build
rman run lint --topo=false          # independent packages, alphabetical order, no dependency waiting
rman run test --changed             # only in packages you have touched but not pushed
rman run build --changed-since v1.2.0
rman run build --parallel 4         # at most 4 packages at once
rman run build --parallel false     # serially, one at a time
rman run build --bail=false         # don't stop the whole batch on one package's failure
rman run build --scope pkg-a --deps # pkg-a plus everything it depends on
```

Per-package/script behavior (pre/post hooks, `if` conditions, skip, concurrency, ...) is
configurable via `.rmanrc run.<script>.*` - see [Configuration](#configuration) below and the full
writeup in [docs/rman.md](https://github.com/panates/rman/blob/main/docs/rman.md#runservice).

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

### `rman config`

Prints the **effective** config for the package of the current directory - after the directory
cascade, `"[selector]"` blocks, `extends` and `${{ ... }}` expressions have all been
applied. What rman actually sees there, which no single file shows.

```bash
rman config                  # the package you are standing in
rman config --from-root           # the repository root's own config instead
rman config --json | jq .run
```

### `rman diff [package]`

Shows the git diff since a package's (or the whole repository's) last release tag.

```bash
rman diff                # since the repository's own last tag
rman diff pkg-a          # since pkg-a's own last tag, scoped to its directory
```

### `rman changelog`

Generates a changelog per package from unreleased commits, with a section per Conventional Commits
type (✨ Features, 🐛 Bug Fixes, ⚡ Performance, ...; anything else under 💬 General Changes) -
renamed or extended with `.rmanrc "changelog.titles"`. With `changelog.groupBy: group`, one file per
release group instead of per package.

```bash
rman changelog                          # auto-detects each package's own last release
rman changelog --from a1b2c3d           # since a specific commit, for every package
rman changelog --write                  # prepend into each package's own CHANGELOG.md
rman changelog --write --file-path docs/CHANGELOG.md
rman changelog --rebuild                # regenerate the files from scratch instead of appending
```

### `rman deps [names..]`

Lists the dependencies that have a newer version on their registry - every package, the monorepo
root's own tooling included - and with `-u` writes the new ranges to the manifests, then checks that
they still install.

```bash
rman deps                       # what could move, and what holds it back
rman deps -u                    # write the new ranges, then check that they install
rman deps --target major        # across a major too
rman deps '@types/*'            # only the dependencies matching this glob
```

**A dependency stays inside its major by default** (`deps.target: minor`). Taking a major is a
decision a person makes: `--target major` for one run, `.rmanrc "deps.target"` for a standing
answer, or `deps.targets` for one dependency. Only a caret or tilde range is rewritten; a version is
offered only when every rule rman can see allows it. See
[docs/cli/deps.md](https://github.com/panates/rman/blob/main/docs/cli/deps.md).

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

See [docs/rman.md#versionservice](https://github.com/panates/rman/blob/main/docs/rman.md#versionservice) for the full grouping/propagation
algorithm, prerelease semantics, and `"workspace:"` dependency-range handling.

### `rman publish`

Publishes every package whose current version isn't on its registry yet. Shows the plan first, then
asks for confirmation (unless `--yes` or `--dry-run`), then publishes in topological order,
dependencies before dependents.

```bash
rman publish                    # show the plan, then ask for confirmation
rman publish --yes              # publish immediately, no confirmation
rman publish --dry-run --json   # "is there anything to release?", for a CI gate
rman publish --target docker    # only the packages configured for that target
```

**Where a package ships is a publish target, and a target is a contribution.** rman ships `docker`;
the `node` built-in contributes `npm`. A package says where it goes with `.rmanrc "publish.target"`, or says
nothing and goes wherever the installed targets claim it - so a Cargo package is never assumed to be
an npm one. Each target adds its own flags, so `rman publish --help` is worth reading in your own
repository. See
[docs/cli/publish.md](https://github.com/panates/rman/blob/main/docs/cli/publish.md).

It never looks at whether `version` ran: it inspects what is on disk and on each registry, so it
behaves the same right after a bump or days later, and re-running is safe.

### `rman github-release`

Creates the repository's GitHub Release for the version that just shipped - one per run, named after
the repository's own release tag, with notes covering every package that shipped under it.

```bash
rman github-release --yes
```

It is deliberately neither a `publish.target` nor opt-in: a release isn't a registry a package ships
to, it's the repository's own record that a version shipped, and every repository wants that record.
It needs no configuration at all - see
[docs/cli/github-release.md](https://github.com/panates/rman/blob/main/docs/cli/github-release.md).

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

## Shared config (`extends`) and adding to it (`value`)

House rules live in one package, and a repository names it:

```yaml
# .rmanrc.yml
extends: '@panates/rman-monorepo'

'[*]':
  run:
    build:
      # adds to the base's step, rather than replacing it
      before: "${{ [...value, 'rm -rf ./cache'] }}"
```

`extends` merges underneath the file naming it (a package, a path, or a list), and may itself be
chained. `value` is what the key already resolved to - from the base, a parent directory, or a
selector - which is what lets a repository add one step without restating a list it doesn't own. It
is the list form of whatever is underneath, so the spread needs no guard even when nothing is.
See [docs/rman.md](https://github.com/panates/rman/blob/main/docs/rman.md#inheriting-a-shared-config-extends).

There was a `+key` prefix for this and it is gone; one still in a config is refused, naming what to
write instead.

## Your own commands

A module in `.rman/` at the repository root becomes an `rman` command:

```js
// .rman/deploy.mjs
import { defineCommand, PublishService } from 'rman';

export default defineCommand({
  describe: 'Ships what was just published to the staging cluster',
  builder: y => y.option('stage', { choices: ['dev', 'prod'], demandOption: true }),
  async handler({ repository }, args) {
    const plan = await PublishService.getPlan(repository);
    console.log(plan.filter(e => e.status === 'publish').length, '->', args.stage);
  },
});
```

```bash
rman deploy --stage prod
```

It gets its own `--help` entry, its own options, and the `Repository` handed to it. For a shell step
across every package, reach for `.rmanrc "run.<script>"` instead - see
[docs/cli/custom-commands.md](https://github.com/panates/rman/blob/main/docs/cli/custom-commands.md) for where the line falls.

## Configuration

`rman` reads config cascaded from the repository root down to each package's own directory (the
same way a `tsconfig.json` `extends` chain works) - a value set closer to a package overrides the
same key set further up. Several file forms are supported per directory, merged in increasing
precedence: `package.json`'s own `"rman"` key, `.rmanrc.yml` (YAML), `.rmanrc` (**JSON**, despite
the dotfile-style name), and `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js` for config that needs real
logic (a JS module's default export).

**Who a declaration is about** follows one rule: what is written above reaches below, and a
`"[selector]"` block narrows the audience. An unmarked key configures its directory's package and
every package under it, so the repository root's own keys are the baseline for the whole repository.
`"[/]"` is the root package alone, `"[platform:node]"` every package of that technology, and a glob
such as `"[*]"` the packages below.

```yaml
# .rmanrc.yml, at the repository root
packageManager:
  node: pnpm
logLevel: info
allowBranch: [main, release/*]

'[/]': # the root package alone - run's scheduling keys are read from here
  run:
    build:
      concurrency: 4

version:
  commitMessage: 'chore(release): v{version}'

'[*]': # every package in the repository - quotes are required in YAML
  group: true # implicit repo-wide version group by default
  changelog:
    ignoreTypes: [chore, ci]
    tagPattern: 'v*'
  clean:
    include: [build, '../../coverage/${{ pkg.basename }}'] # any string may embed a JS expression
  run:
    test: mocha # a bare string is shorthand for { exec: mocha }
    build:
      before: [rman run lint]
      exec: tsc -b tsconfig-build.json
      after: node ../../support/postbuild.cjs
    lint:
      topo: false
      bail: false

'[*-dialect]': # a glob over package names, anchored at both ends
  group: dialects
```

```json
// packages/core/.rmanrc - this one package overrides just its own group
{ "group": false }
```

```json
// packages/plugin-a/.rmanrc - versions together with plugin-b, independent of everyone else
{ "group": "plugins" }
```

See [docs/rman.md#configuration-rmanrc--rmanrcyml](https://github.com/panates/rman/blob/main/docs/rman.md#configuration-rmanrc--rmanrcyml) for the
full key reference (every `run.<script>.*` sub-key, `clean.*`, `changelog.*`, selector precedence,
and which keys are root-level-only today).

**Editor autocomplete** comes from the `RmanConfig` type, so it applies to the JS forms of the
config - wrap a `.rmanrc.cjs`/`.mjs`/`.js` in the exported `defineConfig()` helper (or annotate it
with `/** @type {import('rman').RmanConfig} */`):

```js
// .rmanrc.mjs
import { defineConfig } from 'rman';
export default defineConfig({ allowBranch: ['main'] });
```

A plugin's keys arrive by declaration merging, so annotating with `RmanConfig` types them too;
`RmanNodeConfig` is the alias that says out loud which set a config is using. The
`.rmanrc`/`.rmanrc.yml` forms get no checking - see
[docs/rman.md#editor-support-types](https://github.com/panates/rman/blob/main/docs/rman.md#editor-support-types) for why the JSON Schema that
used to cover them was removed.

## Programmatic API

Every command above is a thin wrapper around an exported service - call them directly
from your own Node.js scripts without shelling out to the `rman` binary:

```ts
import { Repository, VersionPlanService } from 'rman';

const repository = await Repository.create();
const plan = await VersionPlanService.getPlanner(repository.app).getPlan(repository);
await repository.app.getService('version').applyPlan(plan, { changelog: true, push: true });
```

Full reference, with detailed examples for every service (`VersionService`, `PublishService`,
`ChangelogService`, `RunService`, `CiService`, `CleanService`, `ExecService`, `ListService`,
`ImportService`, `SystemInfo`) and the `Repository`/`Package` core classes: **[docs/rman.md](https://github.com/panates/rman/blob/main/docs/rman.md)**.

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
