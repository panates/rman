<!--
docs-baseline
git-commit: ec25859a35fa005aac2ca80faf8dee3a167e7ba9
package-version: 1.0.8
date: 2026-09-15

Verified against `src/` (and `test/**/*.spec.ts` for usage examples) as of the commit above.
Before trusting/updating this file in a later session, run:

  git diff ec25859a35fa005aac2ca80faf8dee3a167e7ba9..HEAD -- src/

and update only the sections touched by what that diff actually shows - don't regenerate the
whole file unless the diff is broad enough to warrant it. Once verified again, bump `git-commit`/
`package-version`/`date` above to the new HEAD.
-->

# rman API Reference

`rman` ships a full **programmatic API** alongside its CLI: every command is a thin wrapper
around a pure(ish) service function, and those services are exported directly so you can call them
from your own Node.js scripts (release tooling, CI glue code, custom dashboards, ...) without
shelling out to the `rman` binary at all.

```ts
import { Repository, VersionService } from 'rman';

const repository = await Repository.create();
const plan = await VersionService.getPlan(repository);
```

This document covers that programmatic surface: `Repository`/`Package`, every `*Service`
namespace, the `.rmanrc`/`.rmanrc.yml` configuration schema those services read, and a few
standalone utilities (`detectChangeHash`, `Logger`). For the CLI itself (commands, flags,
`--help` text), see [docs/cli.md](cli.md) (or [README.md](../README.md) for a fast-start overview).

> **Not part of this API:** anything under `src/commands/*.command.ts` and `cli.ts`'s `runCli` -
> those are CLI-only (argv parsing, colored console output, confirmation prompts) and are not
> re-exported from the package's main entry point. If you need `runCli` itself (e.g. to embed the
> CLI in another tool), import it from `rman/cli.js` explicitly.

## Table of contents

- [Installation](#installation)
- [Core concepts](#core-concepts)
  - [`Repository`](#repository)
  - [`Package`](#package)
- [Configuration (`.rmanrc` / `.rmanrc.yml`)](#configuration-rmanrc-rmanrcyml)
  - [JS config (`.rmanrc.cjs` / `.rmanrc.mjs` / `.rmanrc.js`)](#js-config-rmanrccjs-rmanrcmjs-rmanrcjs)
  - [Editor support (JSON Schema)](#editor-support-json-schema)
- [Services](#services)
  - [`VersionService`](#versionservice)
  - [`PublishService`](#publishservice)
  - [`DockerPublishService`](#dockerpublishservice)
  - [`GithubReleaseService`](#githubreleaseservice)
  - [`ChangelogService`](#changelogservice)
  - [`RunService`](#runservice)
  - [`CiService`](#ciservice)
  - [`CleanService`](#cleanservice)
  - [`ExecService`](#execservice)
  - [`ListService`](#listservice)
  - [`ImportService`](#importservice)
  - [`SystemInfo`](#systeminfo)
- [Shared utilities](#shared-utilities)
  - [`detectChangeHash`](#detectchangehash)
  - [`Logger` / `LogLevel` / `resolveRootLogLevel`](#logger-loglevel-resolverootloglevel)
- [The `logged` error convention](#the-logged-error-convention)
- [Package filtering (`scope`/`ignore`/`deps`/`dependents`)](#package-filtering-scopeignoredepsdependents)

## Installation

```bash
npm install rman
```

`rman` is ESM-only (`"type": "module"`) and requires **Node.js >= 20**. Everything below is
imported from the package's default export:

```ts
import {
  Repository,
  Package,
  defineConfig,
  VersionService,
  PublishService,
  ChangelogService,
  RunService,
  CiService,
  CleanService,
  ExecService,
  ListService,
  ImportService,
  SystemInfo,
  detectChangeHash,
  Logger,
  LOG_LEVELS,
  resolveRootLogLevel,
} from 'rman';
import type { RmanConfig } from 'rman';
```

## Core concepts

### `Repository`

`Repository` (extends `Package`) is the entry point to everything else in this API - it discovers
whether you're standing in a monorepo or a single package, resolves every package's `.rmanrc`
config, and builds the in-repo dependency graph.

```ts
class Repository extends Package {
  readonly rootPackage: Package;
  readonly monorepo: boolean;
  readonly packages: Package[]; // every package; root NOT included when monorepo
  readonly cwd: string; // the directory Repository.create() was actually invoked from

  static create(root?: string, options?: { deep?: number }): Promise<Repository>;

  get currentPackage(): Package | undefined;
  getPackages(options?: { scope?: string | string[]; toposort?: boolean }): Package[];
  getPackage(name: string): Package | undefined;
  listStatus(options?: { hash?: string }): Promise<Record<string, Repository.PackageStatus>>;
}

namespace Repository {
  type PackageStatus = 'dirty' | 'committed' | 'changed' | 'clean';
}
```

**`Repository.create(root?, options?)`** walks up from `root` (default `process.cwd()`), up to
`options.deep` (default `10`) directory levels, looking for a `package.json` with an array
`workspaces` field. The first one found becomes the monorepo root. If it instead hits a `.git`
directory before finding one, that directory becomes a non-monorepo repository root. If nothing is
found within the depth limit, you get a plain single-package `Repository` rooted at `root` itself.

Async because config resolution can load a `.rmanrc.cjs`/`.rmanrc.mjs`/`.rmanrc.js` module (see
[Configuration](#configuration-rmanrc-rmanrcyml) below), which needs a dynamic `import()` for a
genuinely-ESM file - always `await` it.

```ts
// From anywhere inside a monorepo or a single package:
const repository = await Repository.create();

// Or against an explicit path (e.g. a script that batch-processes several repos):
const repository = await Repository.create('/path/to/some/repo');

console.log(repository.monorepo); // true | false
console.log(repository.packages.map(p => p.name));
```

**`repository.currentPackage`** is the package whose directory contains `repository.cwd` (deepest
match wins) - `undefined` when `cwd` *is* the repository root, or isn't inside any known package.
Several services (`RunService`, `CleanService`, `ChangelogService`, ...) use this to scope
themselves to "just the package I'm standing in" unless a `root: true` option overrides it:

```ts
const repository = await Repository.create('/repo/packages/pkg-a');
repository.currentPackage?.name; // 'pkg-a'
```

**`repository.getPackages(options?)`** returns the resolved package list, optionally narrowed by
exact name (`scope`) and/or topologically sorted (`toposort: true` - dependencies before
dependents). This is a lower-level primitive than the glob-based
[`filterPackages`](#package-filtering-scopeignoredepsdependents) most services use internally.

**`repository.listStatus(options?)`** reports every package's git change status in one pass:

```ts
const status = await repository.listStatus();
// { 'pkg-a': 'dirty', 'pkg-b': 'committed', 'pkg-c': 'clean' }

const sinceRelease = await repository.listStatus({ hash: 'v1.2.0' });
// { 'pkg-a': 'changed', 'pkg-b': 'clean', ... }
```

- `'dirty'` always wins first (uncommitted local changes), regardless of `hash`.
- Without `hash`: `'committed'` means committed on the current branch but not yet pushed upstream.
- With `hash`: `'changed'` means the package differs from that commit/tag.
- Otherwise: `'clean'`.

### `Package`

```ts
class Package {
  readonly dirname: string;
  dependencies: string[]; // in-repo package names this one depends on (full transitive closure)
  config: RmanConfig; // this package's own effective, cascaded .rmanrc config

  get basename(): string; // path.basename(dirname)
  get name(): string; // package.json "name"
  get version(): string; // package.json "version"
  get json(): any; // the parsed package.json object (mutable in-memory)
  get jsonFileName(): string; // absolute path to package.json
  get isPrivate(): boolean; // !!json.private

  reloadJson(): any; // re-reads package.json from disk, discarding in-memory edits
  writeJson(): void; // writes `this.json` back to package.json (2-space indent)
}
```

`pkg.dependencies` is **not** just what's declared in `package.json` - `Repository` computes the
full transitive closure across every in-repo package (guarding against cycles), which is what
powers topological sort, `--deps`/`--dependents` filtering, and `RunService`'s task scheduling.
It also folds in anything declared under `.rmanrc packages.<name>.dependencies` (see the
[config reference](#configuration-rmanrc-rmanrcyml)) - a way to tell rman about an in-repo
dependency relationship that isn't expressed as a real `package.json` dependency.

```ts
const pkgA = repository.getPackage('pkg-a')!;
pkgA.json.description = 'Updated via script';
pkgA.writeJson();
```

## Configuration (`.rmanrc` / `.rmanrc.yml`)

Every directory between the repository root and a package can carry its own config, cascaded the
same way a `tsconfig.json` `extends` chain works: a value set closer to a package overrides
(replaces, not merges - for scalars/arrays; objects merge recursively) the same key set further up
toward the root. Root-only keys are only ever consulted from the *root's* own resolved config in
the current implementation (see the table below), even though nothing stops you from setting them
deeper.

For a single directory, up to six sources merge together in **increasing precedence**:

1. `package.json`'s own `"rman"` key (a plain object)
2. `.rmanrc.yml` (YAML, parsed with `js-yaml`)
3. `.rmanrc` (**JSON**, parsed with `JSON.parse` - despite the dotfile-style name, this is not INI
   or YAML; reach for `.rmanrc.yml` if you want a more human-friendly format)
4. `.rmanrc.cjs`, then `.rmanrc.mjs`, then `.rmanrc.js` - whichever exist, in that order (see below)

```json
// .rmanrc (JSON)
{
  "packageManager": "pnpm",
  "group": true,
  "version": { "commitMessage": "chore(release): v{version}" }
}
```

```yaml
# .rmanrc.yml (YAML) - equivalent to the above
packageManager: pnpm
group: true
version:
  commitMessage: 'chore(release): v{version}'
```

```json
// package.json - equivalent again, nested under "rman"
{
  "name": "my-repo",
  "rman": {
    "packageManager": "pnpm"
  }
}
```

### JS config (`.rmanrc.cjs` / `.rmanrc.mjs` / `.rmanrc.js`)

For config that needs real logic (reading an environment variable, computing a value, sharing a
fragment between packages), a JS file's **default export** (or its whole `module.exports`, for a
CommonJS file with no `default`) is used as the config object - the same shape as the other
formats, just computed instead of static:

```js
// .rmanrc.cjs (CommonJS - always, regardless of the nearest package.json "type")
module.exports = {
  packageManager: 'pnpm',
  logLevel: process.env.CI ? 'verbose' : 'info',
};
```

```js
// .rmanrc.mjs (native ESM - always) / .rmanrc.js (ESM only under a "type": "module" package.json)
export default {
  packageManager: 'pnpm',
};
```

`.rmanrc.cjs` is always CommonJS and `.rmanrc.mjs` is always ESM, regardless of the repository's own
`package.json` `"type"` field; a plain `.rmanrc.js` follows that field the same way any other `.js`
file in the repository would (CommonJS by default, ESM under `"type": "module"`). This is also
*why* [`Repository.create()`](#repository) is async: loading a genuinely-ESM file needs a dynamic
`import()`, which can't happen synchronously.

**Type-checked authoring:** `rman` exports an `RmanConfig` type and a `defineConfig()` identity
helper (the same pattern Vite/Vitest use) - wrap the config object in it to get full autocomplete
and type errors in a JS config file, the equivalent of what the [JSON Schema](#editor-support-json-schema)
gives `.rmanrc`/`.rmanrc.yml`:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman';

export default defineConfig({
  packageManager: 'pnpm', // autocompletes to 'npm' | 'yarn' | 'pnpm' | 'bun'
});
```

```js
// .rmanrc.cjs
const { defineConfig } = require('rman');

module.exports = defineConfig({
  packageManager: 'pnpm',
});
```

`defineConfig()` returns its argument completely unchanged - it exists purely for TypeScript
inference, not runtime behavior. `RmanConfig` is also importable on its own, e.g. for a `.rmanrc.ts`
authored with a separate build step, or just to annotate a config object built up elsewhere:

```ts
import type { RmanConfig } from 'rman';

const config: RmanConfig = { packageManager: 'pnpm' };
```

### Config keys reference

| Key | Type | Default | Scope / notes |
| --- | --- | --- | --- |
| `packageManager` | `'npm'\|'yarn'\|'pnpm'\|'bun'` | `'npm'` | Root-level only. Used by `ci`/`publish`. CLI flag wins when given. |
| `logLevel` | `'silent'\|'error'\|'info'\|'verbose'` | `'info'` | Root-level only. Invalid values fall back to `'info'`. CLI `--log-level` wins when given. |
| `allowBranch` | `string \| string[]` | none (no restriction) | Root-level only. A CLI `--allow-branch` **replaces** it entirely (never merges). |
| `ignoreBranch` | `string \| string[]` | none (no restriction) | Same as `allowBranch`. |
| `group` | `true \| false \| string` | `true` | Per-package cascaded. See [`VersionService`](#grouping-rmanrc-group) below. |
| `version.commitMessage` | `string` | `"chore(release): v{version}"` | Root-level only. `{version}` substituted when a commit's group shares one version. |
| `version.changelog` | `boolean` | `false` | Root-level only. Default for `version --changelog` when the CLI flag isn't given - `--no-changelog` still overrides it off for one run. |
| `version.script` / `.preScript` / `.postScript` | `string \| string[]` | none | Per-package cascaded. Hooks around a version bump's write (real npm `preversion`/`version`/`postversion` scripts still win if the package defines them). |
| `changelog.ignoreTypes` | `string[]` | `[]` | Per-package cascaded. Conventional Commit `type`s dropped entirely from changelog output. |
| `changelog.template` | `string` (a file **path**, relative to repo root) | built-in template | Per-package cascaded. Throws if the path doesn't exist. |
| `changelog.filePath` | `string` | `'CHANGELOG.md'` | Per-package cascaded, relative to that package's own directory. CLI `--file-path` wins when given. |
| `changelog.tagPattern` | `string` (glob, may contain `{name}`) | `'v*'` | Per-package cascaded. `{name}` → independent per-package tags (`{name}@*`); no `{name}` → one shared repo-wide tag scheme. |
| `clean.include` / `.exclude` | `string \| string[]` | `[]` | Per-package cascaded, resolved relative to that package's own directory. |
| `clean.skip` | `boolean` | `false` | Per-package cascaded - opts a package out of `clean` entirely. |
| `publish.target` | `'npm' \| 'docker' \| 'github'` or an array of them | `['npm']` | Per-package cascaded. Where `publish` releases this package to. Each target has its own "already published?" check: npm via `npm view`, docker via `docker manifest inspect`, github via the release for that version's tag. |
| `publish.docker.image` | `string` | none (required once `"docker"` is a target) | A bare name is prefixed with `--docker-namespace`/`DOCKERHUB_NAMESPACE`; one already containing `/` is used verbatim. |
| `publish.docker.dockerfile` | `string` | `'Dockerfile'` | Relative to the package's own directory. |
| `publish.docker.platforms` | `string[]` | `['linux/amd64']` | `docker buildx build --platform` targets. |
| `publish.docker.cwd` | `string` | that package's own directory | Relative to the repository root. |
| `publish.docker.buildContexts` | `Record<string, string>` | `{}` | Named `--build-context <name>=<path>` entries, each path relative to the package's own directory. |
| `publish.docker.buildArgs` | `Record<string, string>` | `{}` | `--build-arg <name>=<value>` entries. A value of exactly `"$NAME"` expands from `process.env.NAME`. |
| `publish.docker.readme` | `string` | `'DOCKER_README.md'` | Relative to the package's own directory - becomes the DockerHub repo's description, if present. |
| `publish.github.assets` | `string[]` | `[]` | Globs (relative to the package's own directory) uploaded onto the release. A release with no assets is still valid. |
| `publish.github.repository` | `string` | parsed from the `origin` remote | `owner/repo` the release is created in. |
| `publish.github.draft` | `boolean` | `false` | Create the release as an unpublished draft. |
| `publish.github.prerelease` | `boolean` | whether the version is a semver prerelease | Mark the release as a prerelease. |
| `publish.skip` | `boolean` | `false` | Per-package cascaded - excludes this package from `publish` entirely (every target), regardless of `target`/`"private"`. `changelog` also skips it by default (its own `--include-skipped` overrides). `version` never consults this. |
| `run.<script>.concurrency` | `number` | CPU count | See [`RunService`](#runservice) below. |
| `run.<script>.topo` | `boolean` | `true` | Precedence: CLI flag > package config > fallback. |
| `run.<script>.bail` | `boolean` | `true` | **Unusual precedence:** package config > CLI flag > fallback (see below). |
| `run.<script>.progress` | `boolean` | `true` | Per-package cascaded (the panel itself is one shared instance per run). |
| `run.<script>.logLevel` | `LogLevel` | root's resolved log level | Per-package cascaded. |
| `run.<script>.changedSince` | `string` | none | Root-level fallback, used only when CLI `--changed-since` isn't given. |
| `run.<script>.skip` | `boolean` | `false` | Per-package cascaded - opts a package out of running this script entirely. |
| `run.<script>.if` | `string` (small expression grammar) | none (always runs) | Per-package cascaded. See [`RunService`'s conditional execution](#conditional-execution-if). |
| `run.<script>.script` / `.preScript` / `.postScript` | `string \| string[]` | none | Per-package cascaded - supplies the command(s) to run when the package's own `package.json` doesn't define this script slot. |
| `run.<script>.override` | `boolean` | `false` | Per-package cascaded - when `true`, the config's script replaces the package's own definition even when it has one. |
| `packages.<pkgName>.dependencies` | `string[] \| Record<string, string>` | none | Declares extra in-repo "dependencies" not present in the package's real `package.json`, purely for rman's own dependency graph (topo-sort, `--deps`/`--dependents`, `run`'s task scheduling). |

`run.<script>.bail`'s precedence is worth calling out explicitly, since it's the one exception to
"CLI always wins": a package's own `.rmanrc bail: true/false` outranks even an explicit
`--bail`/`--no-bail` flag on the command line, because "this package's failure must always stop
the batch" is a more specific, intentional statement than a broad flag meant for the whole run -
and shouldn't be silently overridable by it.

### Editor support (JSON Schema)

`rman` ships a JSON Schema for `.rmanrc`/`.rmanrc.yml` at `rman/rmanrc.schema.json` (also available
in this repo at [`schemas/rmanrc.schema.json`](../schemas/rmanrc.schema.json)) - point your editor
at it to get autocomplete, inline docs, and typo/type validation while editing config. This only
applies to the JSON/YAML forms; a `.rmanrc.cjs`/`.mjs`/`.js` file is plain code, so a schema can't
validate it - your editor's own JS/TS tooling (JSDoc types, etc.) is the closest equivalent there.

**`.rmanrc` (JSON):** add a `"$schema"` key (rman itself ignores it):

```json
{
  "$schema": "./node_modules/rman/rmanrc.schema.json",
  "packageManager": "pnpm"
}
```

**`.rmanrc.yml` (YAML):** add a `yaml-language-server` directive as the first line (recognized by
VS Code's YAML extension, and by WebStorm/IntelliJ IDEs):

```yaml
# yaml-language-server: $schema=./node_modules/rman/rmanrc.schema.json
packageManager: pnpm
```

**WebStorm/IntelliJ, without editing the file at all:** since `.rmanrc` has no file extension,
the IDE needs to be told both that it's JSON and which schema applies - open *Preferences ->
Languages & Frameworks -> Schemas and DTDs -> JSON Schema Mappings*, add a mapping to
`node_modules/rman/rmanrc.schema.json`, and add a file path pattern of `.rmanrc` (and `.rmanrc.yml`
as a second mapping, under the *YAML* mappings section instead). This applies project-wide without
touching every config file's contents.

## Services

Every service is a `namespace` grouping one domain's functions and types - `VersionService.Entry`,
`VersionService.getPlan(...)`, and so on. Most follow the same **plan → apply** shape: a pure
`getPlan` (or `getEntries`/`getPackages`) function that computes what *would* happen without
touching anything, and a separate `applyPlan` (or `generateToFile`) that actually writes/commits/
publishes. This mirrors what `rman`'s own CLI commands do: compute a plan, print it, optionally ask
for confirmation, then apply it.

### `VersionService`

Computes and applies version bumps across the repository, with `.rmanrc group`-based release
grouping (fixed or independent versioning), Conventional Commits-based severity auto-detection,
cross-group dependency-range propagation, and prerelease (`--preid`) support.

"Since the last release" is resolved by the shared [`detectChangeHash`](#detectchangehash) - the very
same boundary `ChangelogService` measures from, so `changed`/`version`/`changelog` never disagree
about which commits are unreleased. This is deliberately a *commit*-driven question, independent of
what any registry currently holds: only commits can say how big a bump is warranted, and why. The
mirror-image question ("is this version already out there?") belongs to `PublishService`/
`DockerPublishService`/`GithubReleaseService`, which each answer it against their own registry.

```ts
namespace VersionService {
  type BumpKeyword = 'patch' | 'minor' | 'major';
  function isBumpKeyword(value: unknown): value is BumpKeyword;

  interface Options extends PackageFilterOptions {
    bump?: string; // a BumpKeyword, or an explicit semver version - omit to auto-detect
    ignoreDirty?: boolean; // default false
    preid?: string; // e.g. "beta" -> prerelease bumps
    npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>; // for tests
  }

  interface ApplyOptions {
    push?: boolean; // default false
    message?: string; // overrides .rmanrc version.commitMessage for this run
    changelog?: boolean; // also write CHANGELOG.md and fold it into the same commit
  }

  interface Entry {
    package: Package;
    groupKey: string;
    group: string; // human-readable group name
    status: 'bump' | 'skip' | 'error' | 'no-change';
    from: string;
    to?: string; // only set when status === 'bump'
    reason?: string;
  }

  function getPlan(repository: Repository, options?: Options): Promise<Entry[]>;
  function applyPlan(repository: Repository, plan: Entry[], options?: ApplyOptions): Promise<Entry[]>;
}

// Also exported at module scope, shared with PublishService:
const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
```

#### Basic usage

```ts
import { Repository, VersionService } from 'rman';

const repository = await Repository.create();

// 1. Compute a plan - never writes anything.
const plan = await VersionService.getPlan(repository); // auto-detect severity from commits

for (const entry of plan) {
  console.log(entry.status, entry.package.name, entry.from, '->', entry.to, entry.reason);
}

// 2. Apply it - writes package.json, commits, tags (once per group).
const applied = await VersionService.applyPlan(repository, plan, { push: true, changelog: true });
```

A tagged group release commit is always the **last** commit `applyPlan` makes: a monorepo root's
own informational version-sync commit goes in ahead of the group commits, so the release tag lands
on `HEAD` rather than one commit behind it (which would leave `git tag --points-at HEAD` empty for
anything reading back the tag it just released).

#### Explicit bump keyword or version

```ts
// Force every changed package's group to a minor bump, regardless of commit content:
const plan = await VersionService.getPlan(repository, { bump: 'minor' });

// Or set every changed package straight to an exact version:
const plan = await VersionService.getPlan(repository, { bump: '2.0.0-rc.1' });
```

#### Grouping (`.rmanrc group`)

Packages are partitioned into **groups**, and severity/version decisions happen per group, not
per package:

- `group: true` (the default) - one implicit repo-wide group. Every package in it shares one
  version line (classic "fixed" / Lerna-style versioning).
- `group: "<name>"` - joins exactly the other packages sharing that same string, regardless of the
  repo's own default. Use this to carve out a few packages that should version together while
  everything else stays independent (or vice versa).
- `group: false` - a solo group of one (fully independent versioning for that package).

```json
// packages/core/.rmanrc
{ "group": false }
```

```json
// packages/plugin-a/.rmanrc and packages/plugin-b/.rmanrc
{ "group": "plugins" }
```

With this setup: `core` versions entirely on its own; `plugin-a`/`plugin-b` share one version line
whenever either changes; every other package still shares the repo-wide default group.

Within a group, whichever severity is highest among its **changed** members (real commits since
that member's own last release tag, or an explicit `bump`) becomes the group's severity, and the
group's new version is its current version (the highest version currently found among its members)
bumped by that severity. Which members actually *receive* the new version depends on the severity:

| Severity | Who gets bumped |
| --- | --- |
| `patch` | Only the changed member(s) - a caret range already tolerates a patch, no republish needed downstream. |
| `minor` | Also every transitive **in-group** dependent of a changed member. |
| `major` | The **entire group**, changed or not. |

Across groups, a package depending on another group's bumped package always receives exactly a
**patch** bump of its own (never the source's severity) - this can itself ripple into a third
group, and so on, but a patch never re-triggers its own group's minor/major cascade.

#### Severity auto-detection from commits

With no explicit `bump`, each changed package's severity comes from its own commits since its last
release tag (Conventional Commits):

```ts
const plan = await VersionService.getPlan(repository); // no `bump` at all
```

| Commit | Detected severity |
| --- | --- |
| `fix: correct a typo` | `patch` |
| `feat: add a new option` | `minor` |
| `feat!: remove the old API` (`!` marker) | `major` |
| `feat: ...` with a `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer | `major` |
| anything non-conventional | `patch` (something changed, at least a patch is warranted) |

A `Release-As: patch|minor|major` commit-body footer overrides **that one commit's own**
contribution to the group's severity entirely - it doesn't suppress a later, un-overridden
commit's own natural severity in the same range:

```
feat: needs to ship right now, not wait for the rest of the minor

Release-As: patch
```

That commit alone won't force a minor bump - but if another `feat:` commit lands afterward in the
same release window *without* its own `Release-As:` override, the group still bumps `minor` for
that one.

#### Prereleases (`--preid` / `Options.preid`)

`preid` is a modifier applied to whichever severity gets computed (explicit or auto-detected), not
a bump keyword of its own:

```ts
// First run: 1.2.3 -> 1.3.0-beta.0 (a fresh prerelease of the computed "minor" severity)
let plan = await VersionService.getPlan(repository, { bump: 'minor', preid: 'beta' });
await VersionService.applyPlan(repository, plan);

// Later, with new commits: 1.3.0-beta.0 -> 1.3.0-beta.1 (same identifier -> increments)
plan = await VersionService.getPlan(repository, { bump: 'minor', preid: 'beta' });
await VersionService.applyPlan(repository, plan);

// Switching the identifier starts a fresh prerelease line instead of incrementing:
plan = await VersionService.getPlan(repository, { preid: 'rc' }); // -> 1.3.0-rc.0
```

`preid` has **no effect** when `bump` is an explicit semver version (`getPlan(repo, { bump:
'2.0.0', preid: 'beta' })` still produces exactly `2.0.0` - there's no severity left to "pre-ify").

#### Dependency ranges and the `"workspace:"` protocol

`applyPlan` refreshes every bumped package's dependency range on any other bumped package it
depends on, using a `^`-prefixed range by default:

```ts
// pkg-b depends on pkg-a: "pkg-a": "^1.0.0" -> after pkg-a bumps to 2.0.0 -> "pkg-a": "^2.0.0"
```

A pnpm/yarn `"workspace:"` range is handled specially:

- A **bare** selector (`"workspace:*"`, `"workspace:^"`, `"workspace:~"`) is left **untouched** -
  it already tracks the dependency's current version dynamically, and gets resolved to a real
  range only at publish time (see [`PublishService`](#publishservice) below).
- An **explicit** `"workspace:<range>"` (e.g. `"workspace:^1.0.0"`) *is* bumped, the same way a
  plain range would be: `"workspace:^1.0.0"` → `"workspace:^2.0.0"`.

#### Dirty packages

```ts
// Default: any package with uncommitted local changes aborts the whole plan (status "error").
const plan = await VersionService.getPlan(repository);
if (plan.some(e => e.status === 'error')) {
  throw new Error('Some packages have uncommitted changes');
}

// Or exclude them instead (status "skip"):
const plan = await VersionService.getPlan(repository, { ignoreDirty: true });
```

### `PublishService`

Computes and applies `npm publish` (or the equivalent for yarn/pnpm/bun) across every non-private
package whose local version isn't already on the registry.

```ts
namespace PublishService {
  interface Deps {
    npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>; // for tests
  }

  interface Options extends PackageFilterOptions {
    ignoreDirty?: boolean;
    registry?: string;
    userconfig?: string;
  }

  interface ApplyOptions extends Options {
    packageManager?: CiService.PackageManager;
    access?: 'public' | 'restricted';
    tag?: string;
    otp?: string;
    contents?: string; // subdirectory to publish from
  }

  interface Entry {
    package: Package;
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    registryVersion?: string;
    reason?: string;
  }

  function getPlan(repository: Repository, options?: Options, deps?: Deps): Promise<Entry[]>;
  function applyPlan(repository: Repository, plan: Entry[], options?: ApplyOptions): Promise<Entry[]>;
}
```

```ts
import { PublishService } from 'rman';

const plan = await PublishService.getPlan(repository);
for (const entry of plan) console.log(entry.status, entry.package.name, entry.reason);

const applied = await PublishService.applyPlan(repository, plan, {
  access: 'public',
  tag: 'next',
});
for (const entry of applied) {
  if (entry.status === 'error') console.error(`${entry.package.name}: ${entry.reason}`);
}
```

`getPlan` is deliberately decoupled from `VersionService` - it only ever compares the *current*
`package.json` version against the registry (via `npm view`, queried concurrently across every
package), so it works equally well right after a version bump or standing alone in a release
pipeline that bumped days earlier. A `private: true` package, or one with `.rmanrc
"publish.skip"`, is always `'skip'`ped; a dirty package is `'error'` (aborts the plan) unless
`ignoreDirty` downgrades it to `'skip'`.

`applyPlan` publishes **sequentially**, in topological order (dependencies before dependents) - if
a package fails, every still-pending dependent (transitively) is marked `'error'` and skipped,
rather than publishing a package whose dependency range points at something that never actually
reached the registry.

**`"workspace:"` protocol at publish time:** just before running the actual publish command for a
package, `applyPlan` rewrites any `"workspace:"` dependency range in its `package.json` to a real,
registry-consumable range (`"workspace:*"` → the dependency's exact current version, `"workspace:^"`/
`"workspace:~"` → `"^"`/`"~"` + that version, an explicit `"workspace:<range>"` → the range
verbatim, prefix stripped) - the same substitution pnpm/yarn's own `publish` performs. The original
file is restored immediately afterward, success or failure (via a `finally`), since `rman` publishes
directly from the working tree rather than a staged tarball.

```ts
// packages/b/package.json before publish: { "dependencies": { "pkg-a": "workspace:*" } }
await PublishService.applyPlan(repository, plan);
// -> "npm publish" for pkg-b saw {"pkg-a": "1.2.3"} (pkg-a's real current version)
// -> packages/b/package.json is back to "workspace:*" once applyPlan returns
```

### `DockerPublishService`

Computes and applies `docker buildx build --push` across every package that opts into the
`"docker"` publish target - unlike `PublishService`'s npm side (opt-out via `"private"`), this is
opt-in: only a package whose own (cascaded) `.rmanrc "publish.target"` includes `"docker"` is a
candidate at all. `.rmanrc "publish.skip"` excludes it regardless, same as on the npm side.

```ts
namespace DockerPublishService {
  interface Deps {
    imageExists?: (image: string, tag: string) => Promise<boolean>; // for tests
  }

  interface Options extends PackageFilterOptions {
    ignoreDirty?: boolean;
    namespace?: string; // prefixed onto a bare "publish.docker.image"
  }

  type ApplyOptions = Options;

  interface Entry {
    package: Package;
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    image?: string; // fully-qualified "<namespace>/<image>"
    reason?: string;
  }

  function getPlan(repository: Repository, options?: Options, deps?: Deps): Promise<Entry[]>;
  function applyPlan(repository: Repository, plan: Entry[]): Promise<Entry[]>;
}
```

```ts
import { DockerPublishService } from 'rman';

const plan = await DockerPublishService.getPlan(repository);
for (const entry of plan) console.log(entry.status, entry.package.name, entry.image, entry.reason);

await DockerPublishService.applyPlan(repository, plan);
```

A candidate package missing the required `publish.docker.image` config is `'error'` - opting into
the target without configuring it is a clear misconfiguration, not a silent no-op. A dirty package
is `'error'` too, unless `ignoreDirty` downgrades it to `'skip'` (same rule the npm side uses).
Otherwise, whether `<image>:<version>` already exists (`docker manifest inspect`, queried
concurrently) decides `'up-to-date'` vs `'publish'` - the same idea `npm view` serves on the npm
side.

`applyPlan` logs in once (`DOCKERHUB_USERNAME`/`DOCKERHUB_PASSWORD` environment variables) and runs
`docker buildx create --use` once, then for each `'publish'` entry a single `docker buildx build
--push`, using that package's own `publish.docker` config: `platforms` (default `["linux/amd64"]`),
named `buildContexts` (`--build-context <name>=<path>`, each path relative to the package's own
directory), `buildArgs` (`--build-arg <name>=<value>` - a value of exactly `"$NAME"` expands from
`process.env.NAME`), an optional `cwd` override (relative to the repository root, for a Dockerfile
whose own `COPY`/`ADD` paths expect something other than the package's own directory), and
`dockerfile` (default `"Dockerfile"`). Tags both `<image>:<version>` and `<image>:latest`. A
`publish.docker.readme` file (default `"DOCKER_README.md"`, relative to the package's own
directory), if present, updates the DockerHub repository's description afterward.

### `GithubReleaseService`

Computes and applies GitHub Releases across every package that opts into the `"github"` publish
target - the third answer to the same question `PublishService` and `DockerPublishService` ask ("is
this exact version already out there?"), for a package with no package registry of its own: a
standalone app shipped as release assets, or one deployed elsewhere with the release only recording
that it shipped. Opt-in like the docker target; `.rmanrc "publish.skip"` excludes it regardless.
Unlike docker, a `"publish.github"` config block is **optional** - every fact it needs already has a
default source. `"private": true` is irrelevant here (it only ever excluded npm candidates).

```ts
namespace GithubReleaseService {
  interface Deps {
    releaseExists?: (repository: string, tag: string) => Promise<boolean>; // for tests
  }

  interface Options extends PackageFilterOptions {
    ignoreDirty?: boolean;
    repository?: string; // "owner/repo" override for every package this run
  }

  interface Entry {
    package: Package;
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    tag?: string; // the same tag name "version" creates for this version
    repository?: string; // "owner/repo" this release lands in
    reason?: string;
  }

  function getPlan(repository: Repository, options?: Options, deps?: Deps): Promise<Entry[]>;
  function applyPlan(repository: Repository, plan: Entry[]): Promise<Entry[]>;
}
```

```ts
import { GithubReleaseService } from 'rman';

const plan = await GithubReleaseService.getPlan(repository);
for (const entry of plan) console.log(entry.status, entry.package.name, entry.tag, entry.reason);

await GithubReleaseService.applyPlan(repository, plan);
```

The release is identified by `expandTag(pkg, pkg.version)` - the same `.rmanrc
"changelog.tagPattern"` name `version` creates and `findLatestTag` reads back, so all three agree on
which tag a version belongs to. `owner/repo` comes from `options.repository`, then the package's own
`publish.github.repository`, then the `origin` remote's URL (SSH and HTTPS forms both parse); a
package it can't be resolved for at all is `'error'`, not a silent skip. A dirty package is `'error'`
unless `ignoreDirty` downgrades it to `'skip'`. Otherwise `GET /repos/{owner}/{repo}/releases/tags/
{tag}` decides `'up-to-date'` vs `'publish'` - a genuine 404 is the only "not released yet"; every
other failure (missing/invalid `GITHUB_TOKEN`, typo'd repository) surfaces as `'error'` at plan time
rather than as a publish that fails much later.

`applyPlan` groups `'publish'` entries by tag - the default repo-wide `v*` scheme has a whole group
release under one tag, so they produce **one** release between them, with every sharer's notes in
its body (`{name}@*` independent versioning gives each its own). Notes come from `ChangelogService`
itself, bounded by the tag immediately *before* the one being released (or the repository's root
commit for a first-ever release) - deliberately not `detectChangeHash`'s auto-detection, which would
resolve to the very tag being released and correctly find nothing. An existing release for the tag
(HTTP 422) is updated rather than failed, so a re-run after a partial failure converges.
`publish.github.assets` globs (relative to the package's own directory) are uploaded onto the
release afterward.

### `ChangelogService`

Generates (and optionally writes) a Markdown changelog per package from real commits, grouped into
Features/Fixes/Other via best-effort Conventional Commits parsing.

```ts
namespace ChangelogService {
  interface Deps {
    npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>;
  }

  interface Options extends PackageFilterOptions {
    from?: string; // commit/hash, or "npm"/omitted to auto-detect per package
    root?: boolean; // whole repository even when standing inside one package
    filePath?: string; // relative to each package's own directory, default "CHANGELOG.md"
    includeSkipped?: boolean; // include a .rmanrc "publish.skip" package too - excluded by default
    version?: string; // the version these entries are FOR - default: read back from git tags
  }

  interface Entry {
    package: Package;
    label: string; // "<repo dir name> repository" for root, its own name otherwise
    version: string; // options.version, else resolved from git tags (not package.json)
    features: string[];
    fixes: string[];
    other: string[];
    content: string; // the fully rendered entry
    filePath: string;
  }

  function getEntries(repository: Repository, options?: Options, deps?: Deps): Promise<Entry[]>;
  function generateToFile(repository: Repository, options?: Options, deps?: Deps): Promise<Entry[]>;
}
```

```ts
import { ChangelogService } from 'rman';

// Pure - just compute the entries, print/inspect them yourself:
const entries = await ChangelogService.getEntries(repository);
for (const entry of entries) console.log(entry.content);

// Since a specific commit, for every package:
const entries = await ChangelogService.getEntries(repository, { from: 'a1b2c3d' });

// Actually prepend each entry into its own CHANGELOG.md:
const written = await ChangelogService.generateToFile(repository, { root: true });
for (const entry of written) console.log('wrote', entry.filePath, 'for', entry.package.name);
```

By default (`from` omitted, or `"npm"`), the boundary is auto-detected per package from its own
most recent release tag first - the same one `version`/`changed` themselves use, so all three
agree on "since when" - falling back to its currently-published npm version only when it has no
tag at all yet (via [`detectChangeHash`](#detectchangehash)); a package that can't be resolved
either way (never tagged *and* never published) has no boundary at all, so its whole history
counts as unreleased - the same view `version` takes.

A commit touching a package's files is attributed to that package's changelog entry - unless it's
broad enough (touches at least 3 packages *and* more than half of all packages) to count as a
repo-wide maintenance change (a relicense, a doc pass across every package, ...), in which case
it's attributed to the root alone instead of being repeated verbatim across most of the repo.

A package with `.rmanrc "publish.skip"` gets no entry at all by default - there's little point
changelogging something that's never actually released - unless `includeSkipped` is set.

Release markers never appear in an entry: a bare version-bump commit (`"6.0.1"`), the message
`version` commits a bump with (`.rmanrc "version.commitMessage"`, or the built-in `chore(release):
v{version}`), and the monorepo root's own version-sync commit are all dropped regardless of
`ignoreTypes`.

`{{version}}` is read back from git tags rather than `package.json` (which can drift from what was
actually released) - so a caller generating notes for a release that **isn't tagged yet** has to
pass `version` itself, or every entry ends up labelled with the previous release's number.
`VersionService.applyPlan` does exactly that when folding the changelog into a bump commit, and
`GithubReleaseService` passes the version it's releasing.

Formatting comes from `.rmanrc changelog.template` - a **path** to a template file (not the
template text itself), supporting `{{package}}`/`{{version}}`/`{{date}}`/`{{commits}}` (the full
grouped block) and `{{features}}`/`{{fixes}}`/`{{other}}` (their bullet lists alone, for a template
with its own headings):

```
<!-- changelog.template.md -->
## {{version}} - {{date}}

{{features}}

{{fixes}}
```

```json
{ "changelog": { "template": "changelog.template.md" } }
```

### `RunService`

Runs an npm script (`run`/`build`/`test` in the CLI) across every matching package, in dependency
order, with concurrency, bail, and conditional-execution (`if`) support.

```ts
namespace RunService {
  interface Options extends PackageFilterOptions {
    parallel?: boolean | number; // true/omitted = CPU count, number = that many, false = serial
    topo?: boolean; // default true
    bail?: boolean;
    changed?: boolean;
    changedSince?: string;
    progress?: boolean; // default true; auto-disabled off-TTY
    logLevel?: LogLevel;
    root?: boolean;
  }

  function getConfig(pkg: Package, script: string): Record<string, unknown>;

  type IfNode =
    | { kind: 'atom'; name: string; value?: string }
    | { kind: 'not'; node: IfNode }
    | { kind: 'and'; left: IfNode; right: IfNode }
    | { kind: 'or'; left: IfNode; right: IfNode };
  function parseIfExpr(raw: unknown): IfNode | undefined;
  function evaluateIf(
    repository: Repository,
    pkg: Package,
    node: IfNode,
    statusCache: Map<string, Record<string, Repository.PackageStatus>>,
  ): Promise<boolean>;

  function runScript(repository: Repository, script: string, options?: Options & { commandName?: string }): Promise<void>;
}

// Also exported at module scope:
function resolveBool(cliValue: boolean | undefined, pkg: Package, script: string, key: string, fallback: boolean): boolean;
function resolveBail(cliValue: boolean | undefined, pkg: Package, script: string, fallback: boolean): boolean;
function resolveNumber(cliValue: number | undefined, pkg: Package, script: string, key: string, fallback: number): number;
function resolveLogLevel(cliValue: LogLevel | undefined, pkg: Package, script: string, fallback: LogLevel): LogLevel;
```

```ts
import { RunService } from 'rman';

// Runs "build" in every package, dependency order, CPU-count concurrency.
await RunService.runScript(repository, 'build');

// Only in packages changed since the last publish, serially, never bailing on a single failure:
await RunService.runScript(repository, 'test', { changed: true, parallel: false, bail: false });
```

`runScript` throws an `Error` with `.logged = true` (see [below](#the-logged-error-convention)) if
any package's steps failed - `await` it inside a `try`/`catch` if you want to keep going
programmatically instead of letting the process exit.

#### Per-script config (`.rmanrc run.<script>`)

```yaml
run:
  build:
    concurrency: 2
    script: tsc -b # used only if the package's own package.json has no "build" script
    preScript: [node ./generate.js, node ./validate.js]
    postScript: node ./copy-assets.js
    override: true # use these even if the package DOES define its own build/prebuild/postbuild
  lint:
    topo: false # lint scripts are independent - alphabetical order, no dependency waiting
    bail: false
  test:
    skip: true # this package opts out of "test" entirely
```

`getConfig(pkg, script)` reads exactly this resolved block for one package/script pair - useful if
you're building your own tooling on top of the same config convention.

#### Conditional execution (`if`)

A small, GitHub-Actions-`if`-flavored boolean grammar - atoms (`changed`, `dirty`, `committed`,
each optionally `= <hash-or-{ENV}>`) combined with `and`/`or`/`not`/`(...)` (`and` binds tighter):

```yaml
run:
  build:
    if: changed # changed since the last publish
  test:
    if: changed = a1b2c3d # changed since a specific commit
  deploy:
    if: changed = { CHANGE_HASH } # {NAME} -> process.env.NAME first
  lint:
    if: (changed or dirty) and not committed
```

```ts
const node = RunService.parseIfExpr('changed and not dirty');
const cache = new Map();
const shouldRun = await RunService.evaluateIf(repository, pkg, node!, cache);
```

An unrecognized atom name prints a one-time warning and evaluates to `true` (the package still
runs) rather than failing the whole command over a typo.

### `CiService`

A from-scratch, reproducible install: deletes `node_modules` and any known lockfile in every
package (root included) - or runs the package's own `"ci"` script instead, if it defines one -
then installs once at the root.

```ts
namespace CiService {
  type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

  interface Options extends PackageFilterOptions {
    packageManager?: PackageManager;
    progress?: boolean; // default true
    logLevel?: LogLevel;
  }

  function resolvePackageManager(repository: Repository, cliValue?: PackageManager): PackageManager;
  function wipe(dirname: string): Promise<string[]>; // returns what was actually removed
  function reinstall(repository: Repository, options?: Options): Promise<void>;
}
```

```ts
import { CiService } from 'rman';

await CiService.reinstall(repository, { packageManager: 'pnpm' });

// Or just the low-level primitive, e.g. to wipe one specific package directory yourself:
const removed = await CiService.wipe('/repo/packages/pkg-a');
// -> ['node_modules', 'package-lock.json']
```

Unlike `RunService`/`ExecService`, `reinstall` does **not** end with a per-package success tally -
only real failures are called out by name, since wiping a package is trivial and the one step that
can genuinely fail (the install) is a single repo-wide operation.

### `CleanService`

Removes compiled TypeScript output (`.js`/`.js.map`/`.d.ts` under `src`/`test`, plus any
`*.tsbuildinfo`) and whatever `.rmanrc clean.include`/`clean.exclude` says to remove, across every
package. Never touches `node_modules` (that's `CiService`'s job).

```ts
namespace CleanService {
  interface Options extends PackageFilterOptions {
    progress?: boolean; // default true
    dryRun?: boolean; // default false
    root?: boolean;
    logLevel?: LogLevel;
  }

  function clean(repository: Repository, options?: Options): Promise<void>;
}
```

```ts
import { CleanService } from 'rman';

// Preview only, nothing removed:
await CleanService.clean(repository, { dryRun: true });

// Actually remove, whole repository even from inside one package's own directory:
await CleanService.clean(repository, { root: true });
```

```json
// A package's own .rmanrc:
{ "clean": { "include": ["dist", "*.tmp"], "exclude": ["dist/keep-me.json"], "skip": false } }
```

### `ExecService`

Runs an arbitrary shell command (not an npm script - no `pre`/`post` lifecycle) directly in every
matching package's own directory.

```ts
namespace ExecService {
  interface Options extends PackageFilterOptions {
    parallel?: boolean | number;
    topo?: boolean; // default true
    bail?: boolean;
    changed?: boolean;
    changedSince?: string;
    progress?: boolean; // default true
    logLevel?: LogLevel;
    root?: boolean;
  }

  function exec(repository: Repository, command: string, options?: Options): Promise<void>;
}
```

```ts
import { ExecService } from 'rman';

await ExecService.exec(repository, 'rm -rf dist');
await ExecService.exec(repository, 'ls -la', { scope: 'pkg-a', topo: false });
```

Everything about package selection/scheduling matches `RunService` (dependency order, per-package
bail, the same `PackageFilterOptions`), just without any `package.json` script resolution.

### `ListService`

Pure data - every package's version, location, private flag, and change status. This is what the
CLI's `list`/`ls` command presents as a table/JSON/graph; call it directly if you want the raw data.

```ts
namespace ListService {
  interface Options extends PackageFilterOptions {
    toposort?: boolean;
    changed?: boolean;
    changedSince?: string;
  }

  interface Item {
    name: string;
    version: string;
    location: string; // relative to the repository root
    private: boolean;
    status: Repository.PackageStatus;
    dependencies: string[]; // in-repo package names - enough to build a dependency graph
    publishTargets: RmanConfig.PublishTarget[]; // this package's own "publish.target" (["npm"] when unset)
    docker?: RmanConfig.DockerPublishOptions; // present only when "docker" is one of publishTargets
  }

  function getPackages(repository: Repository, options?: Options): Promise<Item[]>;
}
```

```ts
import { ListService } from 'rman';

const items = await ListService.getPackages(repository, { toposort: true });
const graph = Object.fromEntries(items.map(i => [i.name, i.dependencies]));

const changedOnly = await ListService.getPackages(repository, { changed: true });
```

### `ImportService`

Imports an external git repository as a new in-repo package, preserving its **entire commit
history** (every original commit, author, date, message) - `git blame`/`git log --follow` keep
working on the imported files afterward, unlike a plain copy-and-commit.

```ts
namespace ImportService {
  interface Options {
    dest?: string; // subdirectory relative to the repo root, default "packages"
  }

  interface Result {
    name: string;
    targetDir: string; // absolute
    commitCount: number;
  }

  function importRepo(repository: Repository, sourcePath: string, options?: Options): Promise<Result>;
}
```

```ts
import { ImportService } from 'rman';

const result = await ImportService.importRepo(repository, '../my-old-standalone-repo', {
  dest: 'libs',
});
console.log(`Imported ${result.name} (${result.commitCount} commits) -> ${result.targetDir}`);
```

Mechanism: every commit reachable from the source repo's `HEAD` becomes a patch (`git format-patch
--root`, oldest first), each patch's file paths are rewritten with the new subdirectory prefix,
then replayed via `git am --3way` (preserving authorship). `sourcePath` must be a local clone
(not a URL) with at least one commit; a target directory that already exists is refused. Merge
commits or binary-file renames in the source repo can occasionally trip up a patch here or there -
the same caveat tools like `lerna import` have, since both replay patches rather than performing a
real merge.

### `SystemInfo`

Environment and repository diagnostics - what the CLI's `info` command prints.

```ts
namespace SystemInfo {
  interface RepositoryInfo {
    type: 'monorepo' | 'package';
    name: string;
    version: string;
    root: string;
    packageCount: number;
  }

  type SystemInfo = Record<string, Record<string, unknown>>; // shape is envinfo's own

  function getSystemInfo(
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun',
    options?: envinfo.RunConfig,
  ): Promise<SystemInfo.SystemInfo>;
  function getRepositoryInfo(repository: Repository): SystemInfo.RepositoryInfo;
}
```

```ts
import { CiService, SystemInfo } from 'rman';

// Node + whichever package manager .rmanrc "packageManager" actually configures (default npm) -
// the "info" command itself resolves this via CiService.resolvePackageManager(repository).
const sys = await SystemInfo.getSystemInfo(CiService.resolvePackageManager(repository));
const repo = SystemInfo.getRepositoryInfo(repository);
console.log(`${repo.type} "${repo.name}" - ${repo.packageCount} package(s)`);
```

## Shared utilities

### `detectChangeHash`

Resolves the commit/hash a package's changes should be measured "since" - the single boundary
`ChangelogService` **and** `VersionService` (so `changed`/`version` too) both call, rather than each
deciding for itself. Exported directly since it's broadly useful anywhere you want to answer "what
changed for this package" without re-implementing the npm-registry-to-git-tag mapping yourself.

Auto-detection order: (1) the package's own most recent release tag - the network-free
`findLatestTag` lookup; (2) failing that (no tag reachable from HEAD - a release cut on another
branch, a rewritten history, onboarding `rman` onto a repo with real npm history), the package's
currently-published npm version, mapped onto a tag name via `.rmanrc "changelog.tagPattern"` and
used only if that tag actually exists. Either way, `catchUpFile` (if given and existing) still
widens the result the same way.

```ts
interface DetectChangeHashOptions {
  from?: string; // an explicit hash wins outright; "npm" (or omitted) triggers auto-detection
  npmViewVersion?: (name: string, cwd: string) => Promise<string | undefined>; // for tests
  catchUpFile?: string; // widens the boundary to also cover what this file hasn't caught up on
}

function detectChangeHash(git: GitHelper, pkg: Package, options?: DetectChangeHashOptions): Promise<string | undefined>;
```

```ts
import { GitHelper } from 'rman'; // not exported - construct your own git access differently if needed
```

> Note: `GitHelper` itself is an internal utility (`src/utils/git.ts`) and is **not** re-exported
> from the package - `detectChangeHash` is exported for the cases above (`ChangelogService`,
> `VersionService`) where you already have a `GitHelper` instance from elsewhere in this API. In
> practice you'll call `detectChangeHash` indirectly through `ChangelogService.getEntries`/
> `generateToFile` rather than constructing a `GitHelper` yourself.

### `Logger` / `LogLevel` / `resolveRootLogLevel`

```ts
type LogLevel = 'silent' | 'error' | 'info' | 'verbose';
const LOG_LEVELS: LogLevel[]; // ['silent', 'error', 'info', 'verbose']

class Logger {
  constructor(level: LogLevel);
  info(...args: unknown[]): void; // hidden at 'silent'/'error'
  verbose(...args: unknown[]): void; // shown only at 'verbose'
  error(...args: unknown[]): void; // hidden only at 'silent'
}

function resolveRootLogLevel(repository: Repository): LogLevel; // .rmanrc "logLevel", default 'info'
```

```ts
import { Logger, resolveRootLogLevel } from 'rman';

const logger = new Logger(resolveRootLogLevel(repository));
logger.info('Starting...'); // suppressed if logLevel is 'silent' or 'error'
logger.error('Something failed'); // shown unless logLevel is 'silent'
```

## The `logged` error convention

Every service that can fail outright (a version bump with dirty packages, a failed `run`/`ci`/
`clean`/`exec` batch, an invalid `.rmanrc packageManager`, ...) throws a plain `Error`. Some of
these errors additionally carry `.logged = true` - a convention `rman`'s own CLI commands use to
avoid printing the same failure twice (the service already printed a colored, human-readable
message to the console before throwing; the CLI's top-level handler sees `.logged` and skips
re-printing a redundant generic one).

If you're calling these services programmatically, `.logged` is just a marker on the error object
- it doesn't change what you need to do:

```ts
try {
  await RunService.runScript(repository, 'build');
} catch (e: any) {
  // e.message === '"build" failed'; e.logged === true
  process.exitCode = 1;
}
```

## Package filtering (`scope`/`ignore`/`deps`/`dependents`)

Every service above that takes `PackageFilterOptions` narrows its target package set the same way:

```ts
interface PackageFilterOptions {
  scope?: string | string[]; // only packages whose name matches this glob (micromatch syntax)
  ignore?: string | string[]; // exclude packages matching this glob, applied after `scope`
  deps?: boolean; // also include everything the matched set depends on
  dependents?: boolean; // also include everything that depends on the matched set
}
```

```ts
// Everything under @myorg/, minus anything ending in -internal:
await RunService.runScript(repository, 'build', { scope: '@myorg/*', ignore: '*-internal' });

// A scoped package plus everything it needs to build first (dependency order handles the rest):
await RunService.runScript(repository, 'build', { scope: 'my-app', deps: true });

// Everything that could be affected by a scoped library's change - useful before a release:
await RunService.runScript(repository, 'test', { scope: 'core-lib', dependents: true });
```

`scope`/`ignore` accept [`micromatch`](https://github.com/micromatch/micromatch) glob syntax
(`*`, `**`, `{a,b}`, ...) matched against each package's bare name. `deps` and `dependents` each
independently expand the already-`scope`/`ignore`-matched set along the full transitive dependency
graph, and their results are **unioned** together (not compounded) - so passing both never
re-expands one direction's additions through the other, which would otherwise tend to explode
toward "the whole repository" on a well-connected graph.
