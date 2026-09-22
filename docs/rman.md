<!--
docs-baseline
git-commit: 9557470
package-version: 2.0.0-beta.2
date: 2026-09-22

Verified against `src/` (and `test/**/*.spec.ts` for usage examples) as of the commit above.
Before trusting/updating this file in a later session, run:

  git diff 9557470..HEAD -- packages/rman/src/

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
import { Repository, VersionPlanService } from 'rman';

const repository = await Repository.create();
const plan = await VersionPlanService.getPlanner(repository.app).getPlan(repository);
```

This document covers that programmatic surface: `RmanApplication`, `Repository`/`Package`, every
service, the `.rmanrc`/`.rmanrc.yml` configuration schema those services read, and a few standalone
utilities (`ChangeHashService`, `Logger`). For the CLI itself (commands, flags,
`--help` text), see [docs/cli-rman.md](cli-rman.md) (or [README.md](../README.md) for a fast-start overview).

> **Not part of this API:** anything under `src/cmd/*.command.ts` and `cli.ts`'s `runCli` -
> those are CLI-only (argv parsing, colored console output, confirmation prompts) and are not
> re-exported from the package's main entry point. If you need `runCli` itself (e.g. to embed the
> CLI in another tool), import it from `rman/cli.js` explicitly.

## Table of contents

- [Installation](#installation)
- [Core concepts](#core-concepts)
  - [`RmanApplication`](#rmanapplication)
  - [`Plugin`](#plugin)
  - [Declaring a command](#declaring-a-command)
  - [`Repository`](#repository)
  - [`Package`](#package)
- [Configuration (`.rmanrc` / `.rmanrc.yml`)](#configuration-rmanrc--rmanrcyml)
  - [JS config (`.rmanrc.cjs` / `.rmanrc.mjs` / `.rmanrc.js`)](#js-config-rmanrccjs--rmanrcmjs--rmanrcjs)
  - [Scoped `vars`](#scoped-vars)
  - [Reading a file (`read`)](#reading-a-file-read)
  - [Function steps](#function-steps)
  - [Function values](#function-values)
  - [Editor support (types)](#editor-support-types)
- [Services](#services)
  - [`VersionService`](#versionservice)
  - [`VersionPlanService`](#versionplanservice)
  - [`PublishTarget`](#publishtarget)
  - [`DockerPublishService`](#dockerpublishservice)
  - [`GithubReleaseService`](#githubreleaseservice)
  - [`ChangelogService`](#changelogservice)
  - [`RunService`](#runservice)
  - [`ExecService`](#execservice)
  - [`ListService`](#listservice)
  - [`ImportService`](#importservice)
  - [`SystemInfo`](#systeminfo)
- [Shared utilities](#shared-utilities)
  - [`ChangeHashService`](#changehashservice)
  - [`Logger` / `LogLevel` / `resolveRootLogLevel`](#logger--loglevel--resolverootloglevel)
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
  RmanApplication,
  Repository,
  Package,
  Registry,
  Service,
  defineConfig,
  definePlugin,
  declareCommand,
  basePlugin,
  targetsOf,
  shipsTo,
  VersionService,
  VersionPlanService,
  DockerPublishService,
  GithubReleaseService,
  ChangelogService,
  RunService,
  ExecService,
  ListService,
  ImportService,
  SystemInfo,
  filterPackages,
  ROOT_SELECTOR,
  isCalendarVersion,
  Logger,
  LOG_LEVELS,
  resolveRootLogLevel,
} from 'rman';
import type {
  RmanConfig,
  Plugin,
  PluginContext,
  PublishTarget,
  ServiceMap,
  CommandOption,
  PositionalOption,
  ArgsOf,
} from 'rman';
```

Services are **classes reached through the application** (`app.getService('version')`) - the
classes are exported so you can name their types, not so you can construct one.

**Everything npm-specific lives in `rman-node`** - `PublishService`, `CiService`, `CleanService`,
the `package.json` manifest reader, the version planner, `node_modules/.bin` on PATH, and the
`publish`/`ci`/`clean` commands. See [node.md](node.md). The package documented here knows nothing
about npm: a repository naming no plugin has no manifest reader at all, so a polyglot or non-Node
repository declares its own through the same seams the plugin uses. `info` is a **core** command
whose npm half the plugin augments in place.

## Core concepts

### `RmanApplication`

**One rman invocation, and everything it holds.** Created before anything else, handed to every
plugin, and the owner of every registry and service. Nothing is process-global: an application
starts empty and is thrown away whole, so two repositories in one process share nothing.

```ts
class RmanApplication {
  constructor(options?: { logLevel?: LogLevel });

  readonly plugins: Registry<Plugin>;             // the technologies this run knows about
  readonly publishTargets: Registry<PublishTarget>; // where a package's artifact can ship
  readonly logger: Logger;
  versionPlanner?: VersionPlanService;            // the plan orchestrator - see VersionPlanService

  get repository(): Repository;                   // throws before one is attached
  pluginFor(dir: string): Plugin;                 // the first plugin whose manifest reader claims it

  getService<K extends keyof ServiceMap>(name: K): ServiceMap[K];
  setService<K extends keyof ServiceMap>(name: K, factory: (app: RmanApplication) => ServiceMap[K]): void;
}
```

`Repository.create` builds one unless handed one, and the repository carries it:

```ts
const repository = await Repository.create();
const app = repository.app; // non-enumerable, so nothing that walks a Repository drags it in

// Or hand one over, e.g. to set the log level before anything reads config:
const own = new RmanApplication({ logLevel: 'silent' });
await Repository.create(undefined, { app: own });
```

- **`repository` throws before it is attached, deliberately.** Plugins are what *find* the packages,
  so they are loaded before any exists; `undefined` would let a plugin write a check that silently
  does nothing.
- **One application, one repository.** A second is refused.
- **`Registry<T>`** is the shape of a contribution list: `add` (idempotent by identity), `all`,
  `first(ask)` for "the first that recognizes this", and it is iterable. A registry is for a
  question whose answer is the *sum* of what was contributed; a question with exactly one answer is
  a service instead.

### `Plugin`

**A technology, as one unit.** What a package *is*, where packages are, where its scripts come
from, which directories hold its binaries, and how its releases are planned - answers that only
make sense together, which is why they are not separate seams.

```ts
interface Plugin {
  name: string;                        // what Package.provider reports
  manifestProvider: ManifestProvider;  // required - everything below is optional
  getWorkspace?: Workspace.Provider;
  getBinPaths?: BinPath.Provider;
  getRunSteps?: RunService.StepSource;
  versionPlanner?: VersionPlanService;
  init?(ctx: PluginContext): void | Promise<void>;
}

interface PluginContext {
  app: RmanApplication;
}
```

**`RmanPlugin` and `TechStack` were two types until 2.0, and are now one.** The plugin existed only
to *register* the stack - its whole `init` was `ctx.addTechStack(...)` plus a command or two - and
once a config carries commands and publish targets itself, that registration step has nothing left
to do. What remains of a plugin is the technology.

- **Everything optional is answered by its absence**, never by a default rman invented. The core
  ships `basePlugin`, whose reader recognizes nothing: a repository naming no plugin falls back to
  it and gets a package named after its directory at `0.0.0`. No `getWorkspace` means no packages
  beyond the root; no `versionPlanner` means `version`/`changed` fail naming the key rather than
  releasing a plausible but untrue set.
- **`manifestProvider` is checked when the plugin loads**, and is the one member that is not
  optional - it is what makes a plugin a technology at all. An rman 1.x plugin (`{ name, init }`)
  is exactly the object that reaches that check, and it is refused with a message saying so.
- **`getRunSteps`, not `onBuildRunSteps`**: it is a *query*, and not build-specific - `version`
  reads the same seam for `preversion`/`version`/`postversion`.
- **`init` is the escape hatch, not the front door.** Commands and publish targets are `.rmanrc`
  keys, so a plugin contributing only those needs no `init`. It runs during `Repository.create`,
  before any package is known, so `ctx.app.repository` throws there; anything wanting the
  repository belongs in a command's factory instead.

A published plugin is not usually named in `plugins` at all. Its package exports a config carrying
it, and the repository writes `extends`:

```ts
// the package's entry point
export default defineConfig({
  plugins: [new NodePlugin()],
  commands: [ciCommand, cleanCommand],
  publishTargets: [new NpmPublishTarget()],
});
```

```yaml
# the repository
extends: 'rman-node'
```

### Declaring a command

**A command says what it has; one function says what yargs is told.** Options are data, checked for
typos, and the `--config` keys and the handler's argv type both fall out of the same declaration.

```ts
import { declareCommand, packageFilterOptions, type ArgsOf, type CommandOption } from 'rman';

/** Hoisted, both of them - see the note below. */
const COMMAND = 'deploy [stage]' as const;
const config = {
  ...packageFilterOptions,
  wait: { target: 'cli', describe: 'block until healthy', type: 'boolean' },
  registry: { target: 'config', describe: 'where images are pushed from', type: 'string' },
} satisfies Record<string, CommandOption>;

type Args = ArgsOf<typeof config, typeof COMMAND>;

export const deployCommand = declareCommand(app => ({
  command: COMMAND,
  describe: 'Ships the current versions',
  configKeys: ['publish'],                 // keys it *reads*; its own key is derived
  config,
  positionals: { stage: { describe: 'which cluster', type: 'string' } },
  handler: async (args: Args) => { /* app.repository is available here */ },
}));
```

- **`declareCommand` for anything contributed, `registerCommand` for rman's own.** The difference
  is one line: `registerCommand` pushes onto a module-level registry every run walks, so a package
  using it would hand its commands to repositories that never named it. A package puts the function
  in its config's `commands` instead.
- **A factory of `app`, not the metadata.** A command closes over the repository, and over whatever
  the application carries - `publish` reads `app.publishTargets` to build its own option list. It is
  also a necessity: the config is read before any package is known, so the factory is stored
  and called later.
- **`target: 'cli' | 'config' | 'both'`** decides whether an option is a flag, a `.rmanrc` key, or
  both. The `config`/`both` ones become the command's slice of `RmanConfig` automatically, so the
  option list and the config type cannot drift:

  ```ts
  declare module 'rman' {
    namespace RmanConfig {
      interface CommandConfigs extends RmanConfig.CommandContribution<ReturnType<typeof deployCommand>> {}
    }
  }
  ```

- **`as const` on the command string is load-bearing twice**: the config key is derived from it
  (`'deploy'`), and so are the positional names, which are checked against `positionals`.
- **`ArgsOf` is annotated, never inferred** - hence the two hoisted consts. Inferring `argv` and
  keeping the metadata's own typo-checking cannot both work in one signature.
- **A `<required>` positional arrives required; everything else is optional.** yargs refuses the
  call before the handler runs, so `args.stage` would be a plain `string` had the example written
  `deploy <stage>` - no `!` and no `?? fallback`. An **option** stays optional even with a
  `default:`, so read one as `args.wait ?? true`: whether yargs applies a default depends on the
  option's `target`, and the type does not make that distinction.
- **A second parameter, `Extra`, is for what an option cannot describe** - `{ file, constant }`, or
  "a shell command or a function". Reach for it only when the shape genuinely resists; a `string[]`
  is `type: 'string'` plus `array: true`.

A repository's own `.rman/*.mjs` command is a different, older form (`defineCommand`, a
hand-written `builder`, a handler taking a `CommandContext`) and is not deprecated - see
[docs/cli/custom-commands.md](cli/custom-commands.md).

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
[Configuration](#configuration-rmanrc--rmanrcyml) below), which needs a dynamic `import()` for a
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
  manifest: Manifest; // this package's identity, as its own technology read it
  manifestFileName: string; // absolute path to the file it was read from ('' if none)
  dependencies: Package[]; // in-repo packages this one depends on (full transitive closure)
  config: RmanConfig; // this package's own effective, cascaded .rmanrc config
  repository: Repository; // the repository it belongs to (a repository's own is itself)
  parent?: Package; // the package whose directory contains this one; undefined for the root
  plugin: Plugin; // the technology whose manifest provider claimed this directory
  versionScheme: VersionScheme; // how its versions are numbered (semver by default)

  get basename(): string; // path.basename(dirname)
  get name(): string; // from the manifest
  get version(): string; // from the manifest
  get isPrivate(): boolean; // !!manifest.private
  get provider(): string; // which ecosystem read it - 'node', ''; see Plugin
  get isRoot(): boolean; // whether this is the repository's own root package

  reloadManifest(): Manifest; // re-reads from disk through its own technology's provider
  writeManifest(): void; // writes the manifest back to its own file
}
```

There is no `json`/`writeJson` here: `package.json` is npm's answer to where a package's name and
version are written, not rman's. `manifest.raw` is still the whole document for code that knows its
own ecosystem (guard it with `pkg.provider === 'node'`), while the core only ever touches `name`,
`version` and `private`.

`pkg.dependencies` holds **packages, not names** - a name identifies a package only where the
ecosystem guarantees uniqueness - and is **not** just what the manifest declares: `Repository`
computes the full transitive closure across every in-repo package (guarding against cycles), which
is what powers topological sort, `--deps`/`--dependents` filtering, and `RunService`'s task
scheduling. It also folds in anything declared under `.rmanrc dependencies` (see the
[config reference](#configuration-rmanrc--rmanrcyml)) - a way to tell rman about an in-repo
dependency relationship the manifests do not express, and the only way a repository with no
provider at all has a graph.

**`pkg.isRoot`** is decided by *directory* - the root package is the one whose directory is the
repository root, because a name can be anything. It is what `--scope /` selects (see
[package filtering](#package-filtering-scopeignoredepsdependents)) and what distinguishes the
repo-wide reading of a config key from a package's own.

```ts
const pkgA = repository.getPackage('pkg-a')!;
pkgA.manifest.raw.description = 'Updated via script';
pkgA.writeManifest();
```

## Configuration (`.rmanrc` / `.rmanrc.yml`)

Every directory between the repository root and a package can carry its own config, cascaded the
same way a `tsconfig.json` `extends` chain works: a value set closer to a package overrides
(replaces, not merges - for scalars/arrays; objects merge recursively) the same key set further up
toward the root.

**Who a declaration is about is decided by one sentence:** what is written above reaches below, and
a `"[selector]"` block narrows the audience. So the repository root's own `.rmanrc` is the baseline
for the whole repository, and a selector is how a statement stops being everyone's:

```yaml
# the repository root's own .rmanrc.yml
packageManager: pnpm                          # every package, and the root

"[/]":                                        # the root package alone
  run:
    build:
      before: node support/generate.cjs       # a repo-wide bookend, run once at the root
"[*]":                                        # the packages below - never the root
  run:
    build:
      after: node ../../support/postbuild.cjs # run in each package's own directory
"[*-dialect]":                                # a glob over package names
  publish: { skip: true }
"[pkg-a]":                                    # exactly one
  dependencies: [pkg-b]
```

Selector details:

- **Two audiences, and the second is a glob:**

  | | |
  | --- | --- |
  | `"[/]"` | the **root package** alone |
  | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | the packages **below** this directory that the glob matches |

  `/` for the root because that is what a repository root is called everywhere else, and no package
  can be named it.

  **The root is never selected by name.** A glob matches package names and the root is nobody's
  child, so `"[my-*]"` cannot quietly reach a repository whose root package is called `my-repo`, and
  `"[*]"` cannot hand a package-shaped setting to a root with no build directory to apply it to.

  In a **single-package repository the root is the one package**, so `"[/]"` reaches it and `"[*]"`
  reaches nothing.
- The pattern is a **glob over package names**, anchored at both ends - `"[*-dialect]"` matches
  `mysql-dialect`, not `my-dialect-helper`. Glob, not regex, like every other pattern in rman.
- In YAML the quotes are **required**. A bare `[*]` parses as a flow sequence, and `*` as an alias
  indicator - the file won't load at all.
- **Precedence: the unmarked keys first, then the selector blocks in the order they were written** -
  later wins, the way `overrides` does in eslint, prettier and babel. Directory levels closer to the
  package still win over everything above them.

  There is no specificity ranking behind that, and the omission is deliberate: specificity only
  orders sets that nest, and globs do not - for a package called `pkg-dialect`, neither `"[pkg-*]"`
  nor `"[*-dialect]"` contains the other. So a catch-all written *below* a narrower block does
  override it. Write catch-alls first; it is a convention, not a rule.

  The unmarked keys are the level's floor **wherever they sit in the file** - written after a
  selector block they still lose to it. They are not a third selector but the layer that also feeds
  the directories below.
- `"[ws:*]"` / `"[workspace:*]"` still works and means exactly `"[*]"`. The qualifier said "not the
  root" back when a bare glob included it; the shape of the set says that now. Don't write it in new
  configs.

**Migrating from 1.2.x.** Three mechanical rules and one that needs a look:

| was | now |
| --- | --- |
| `"[ws:*]"` | `"[*]"` |
| `"[*]"` (which included the root) | unmarked |
| a root key that is genuinely the root's | `"[/]"` |

The one to look at is **`run.<script>`**, because its hooks are the one place where the audience
changes the meaning: on the root they are a repo-wide bookend run once at the repository root; on a
package they are that package's own hook, run in its directory. Left unmarked they are now both -
once at the root and once per package. Put a repo-wide bookend under `"[/]"`. The other root keys
(`allowBranch`, `version.*`, `githubRelease.*`, `packageManager`) cascade harmlessly, since nothing
reads them at package level.

### Inheriting a shared config (`extends`)

```yaml
extends: "@panates/rman-monorepo"
# or a list, applied in declaration order - later entries win
extends: ["@panates/rman-monorepo", "./local-overrides.yml"]
```

Everything named is merged **underneath** the config that names it, so the declaring file always
wins. A bare name resolves through *that file's* own `node_modules`, which is where a repository's
shared config lives - so a subpath works too (`"@panates/rman-monorepo/strict"`). The target may be
YAML, JSON, or a module exporting a config through `defineConfig`, and may itself `extends` another;
a cycle is reported rather than recursed into.

Resolution happens per directory, once that directory's own file forms are combined - `extends` is
the base they sit on, and the directory chain then layers on top exactly as before. `extends` is
**top level only**: naming one inside a `"[selector]"` block is an error rather than a no-op, since
inheritance is a statement about the config and not about the packages a selector names.

An inherited **unmarked** key behaves exactly as one written in the inheriting file: it reaches that
directory and every package below it. That makes a base *portable* rather than fixed - the same file
inherited by the root is the repository's baseline, and inherited by a package's own `.rmanrc` is
that package's. A base that must always mean the root says `"[/]"`, which is fixed wherever it is
inherited from.

### Adding to what you inherited (`value`)

```yaml
# the root says   before: "rm ./build"
# a package says  before: "${{ [...value, 'rm ./cache'] }}"
# it resolves to  before: ["rm ./build", "rm ./cache"]
```

`value` is what this key resolved to in the layers **below** this one - a parent directory, a
`"[selector]"` block, or an `extends` base. It is what makes a shared config liveable: a base
declaring `before: ["rm ./build"]` would otherwise force every repository wanting one more step to
restate the whole list, and a restated list is a copy of the base, frozen at the version it was
copied from.

- **It is the list form of whatever is underneath**, so `[...value, 'x']` needs no guard: nothing
  inherited spreads as empty, and a scalar (`before: "rm ./build"`) spreads as one element. Every
  key this is reached for is declared `X | X[]`, where the list is the type and the scalar is
  shorthand - so normalizing it decides nothing new.
- It still **reads as the scalar** where one makes sense: `` `${value}.md` `` on an inherited
  `"out"` is `"out.md"`. A *list* underneath refuses that rather than splicing `a,b` into a
  sentence, and so does nothing-underneath.
- A **boolean** is handed over as itself, so `!value` works. It is never a list nor a list's
  shorthand, and an object cannot be fixed up for it - `!` and `? :` have no hook.
- The cost: `value === 'build'` is `false` and `value.includes('bui')` matches elements rather than
  substrings. Use `==`, `` `${value}` `` or `String(value)`.
- Layers resolve bottom-up in merge order: `extends` base → parent directories → each level's
  unmarked keys → that level's selector blocks in declaration order. Three layers each deriving
  from the one below them compose.

**There was a `+key` prefix and it is gone.** It said "add to what this resolved to below", which is
what `value` says - and `value` says it better: it composes, it can reorder or filter rather than
only append, and it needed no machinery keeping an append *outstanding* until the layer it belonged
to turned up. It also carried a bug `value` does not: appending onto a value that was a sole
`${{ }}` expression returning an array nested it. A `+key` still in a config is **refused**, naming
the key and what to write instead - rman validates no config keys, so ignoring it would drop the
line in silence.

Three keys still append without being asked, and there that is what the *key* means rather than a
choice made per layer: `plugins`, `commands` and `publishTargets`, each of which names
contributions rather than a setting a closer layer could sensibly overrule.

### Expressions (`${{ ... }}`)

Any string value may embed `${{ ... }}`, evaluated per package - which is what lets one root
declaration stay package-specific:

```yaml
"[*]":
  clean:
    include: ["build", "../../coverage/${{ pkg.basename }}"]
  publish:
    docker:
      image: "panates/${{ pkg.basename }}:${{ semver.major(pkg.version) }}"
  run:
    build:
      exec: "tsc -b ${{ pkg.manifest.tsconfig ?? 'tsconfig-build.json' }}"
```

The contents are **real JavaScript**, not a template mini-language, so there is no growing list of
substitutions to keep adding (`{{major}}`, `{{scope}}`, ...). In scope:

| | |
| --- | --- |
| `pkg` | the package the config was resolved for |
| `repository` | the repository - the root package's own fields, plus repo-level ones |
| `file` | where something is on disk, resolved against `pkg.dirname` - `exists` / `resolve` / `resolveFirst` |
| `read` | what is *in* a structured file - see [Reading a file](#reading-a-file-read) |
| `env` | a copy of `process.env`, so writing to it reaches nothing |
| `semver` | rman's own `semver`, for `semver.major(pkg.version)` and friends |
| `path` | Node's own `node:path`, the platform's flavour (`path.posix` / `path.win32` through it) |
| `git` | the checkout: `branch`, `sha`, `shortSha`, `dirty` |
| `value` | what this key resolved to in the layers below - see [Function values](#function-values) |

plus **the config's own top-level keys, bare** (`${{ vars.registry }}`, `${{ changelog.filePath }}`)
- resolved on demand, so key order in the file means nothing and a cycle is reported rather than
half-resolved. A scope binding wins a name clash, and a key that is not a valid identifier (a
`"[selector]"`, a `"lint:fix"`) is not bound at all.

`pkg` and `repository` share one shape, since the repository root *is* a package:

| | |
| --- | --- |
| `.name` | the package's own name, scope included (`@sqb/builder`) |
| `.scope` / `.unscopedName` | `@sqb` / `builder` - `scope` is `undefined` when unscoped |
| `.version` | its `package.json` version |
| `.basename` | its directory's last segment - **not** the same as `name`: sqb's root is named `sqb.v4` in a directory called `sqb` |
| `.dirname` / `.relativeDir` | absolute path / path from the repository root (`packages/builder`); `relativeDir` is `''` for the root itself |
| `.provider` | which ecosystem claimed it - `node`, or empty when no plugin did |
| `.manifest` | the whole manifest, as a copy (`pkg.manifest.engines.node`). **Not `.json`** - which file a package's identity lives in is the ecosystem's business now |
| `pkg.targetVersion` | the version this run is about to write - **only inside a `version.before`/`.exec`/`.after` hook**; anywhere else, reading it throws |

`repository` adds:

| | |
| --- | --- |
| `.monorepo` | boolean |
| `.packages` | every package, each in the shape above |
| `.package(name)` | one of them by name, or `undefined` - for reaching a sibling's directory |

and `git` is **top level, not `repository.git`** - which is where it used to be, through 1.0.x:

| | |
| --- | --- |
| `git.branch` | `undefined` on a detached HEAD, which a CI checkout often is - so `?? 'detached'` works |
| `git.sha` / `git.shortSha` | full, and the first 7 characters |
| `git.dirty` | whether the working tree has uncommitted changes |

It sits beside `env` because that is what it is: `repository` shares its shape with `pkg` since the
root *is* a package, and its other members (`monorepo`, `packages`, `package()`) say something
about the repository as a container of packages. A branch name says nothing about any package - it
describes the working tree all of them happen to be in.

Read from git **only if an expression asks**, then remembered for the whole run: every command
resolves config, so a repository that never mentions git spawns none (measured - and the same
measurement is why `interpolateConfig` builds its context from property descriptors rather than
spreading the scope, since a spread reads every getter). All four are `undefined` outside a
checkout, which is a state rather than an error.

- **`${{ }}`, deliberately not `{{ }}`.** A config value may legitimately carry `{{...}}` meant for
  something else (`helm template --set tag={{.Values.tag}}`), and with the plainer delimiter rman
  would try to evaluate it. A bare `{{...}}` is therefore left alone. To emit a literal `${{`, let
  an expression produce it, as in GitHub Actions: `${{ '${{' }}`.
- A string that is **nothing but** one expression keeps that value's own type
  (`skip: "${{ pkg.manifest.private === true }}"` → a boolean); embedded in surrounding text it is
  stringified. Without this, expressions could only ever produce strings and a setting like
  `run.<script>.skip` would be unreachable from one.
- A **nullish** result is fine standing alone (it just means "unset") but an **error** embedded in
  text: splicing in the word `undefined` yields an `app:undefined` that looks plausible and is
  wrong. Say what was meant with `?? 'fallback'`.
- Evaluation happens in a fresh V8 context holding only those bindings. That is a clean scope,
  **not a sandbox** - `node:vm` is [explicitly not a security
  mechanism](https://nodejs.org/api/vm.html), and none is called for: a `.rmanrc` that can say
  `exec: "..."` already runs arbitrary shell, so expressions add no trust boundary that wasn't
  already wide open.
- A failing expression throws, naming the config path that holds it (`run.build.after[1]`) -
  passing a mistake through silently is how a config ends up quietly doing nothing.
- **`pkg.targetVersion`** is the one binding that isn't available everywhere. The version a run is
  about to write doesn't exist until `version` has computed its plan, long after the config was
  resolved - so `version.before`/`.exec`/`.after` are left *unevaluated* at load and evaluated by
  `version` itself, with it bound (`DEFERRED_PATHS`). That is also why naming it anywhere else
  fails when the repository loads: no other command has a target version, and letting it evaluate
  to `undefined` would put an `app:undefined` somewhere it looks plausible.
- Unrelated to this: a **changelog template file's** `{{package}}`/`{{version}}` placeholders are
  that file's own content, not config values, and are never touched here.

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
and type errors in a JS config file. There is no equivalent for `.rmanrc`/`.rmanrc.yml`: rman
shipped a JSON Schema through 1.0.x and it is gone, so those two forms are unchecked - which is the
argument for a JS config as soon as one is non-trivial.

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

> **Note on `.rmanrc.cjs` and `require('rman')`.** rman is ESM-only, so `require('rman')` in a
> CommonJS config needs `require(esm)`, which arrived in Node 20.19 - below that it throws
> `ERR_REQUIRE_ESM`, and rman's own floor is `>=20.0`. The JSDoc form imports nothing and works on
> every supported version:
>
> ```js
> /** @type {import('rman').RmanConfig} */
> module.exports = { packageManager: 'pnpm' };
> ```
>
> Use `.rmanrc.mjs` if you want to call `defineConfig()` itself.

### Scoped `vars`

`vars` can be declared at **any level** of the config, and applies to that level's subtree:

```yaml
vars:
  x: 1
"[*]":
  run:
    vars:
      x: 2
    clean:
      before: '${{ read(vars.x + ".json") }}'    # reads 2.json
    build:
      vars:
        x: 3
      before: '${{ read(vars.x + ".json") }}'    # reads 3.json
```

- **A fresh copy at every level**, with that level's own block merged over what the level above
  resolved to. Merged **per key**, so redeclaring one var keeps the rest.
- **Nothing written at a level reaches the level above, or a sibling.** That is what the copy is
  for: a [value function](#function-values) is handed this object, so one that writes to it
  (`vars.built = Date.now()`) writes into its own level and nowhere else.
- A level's own block is resolved **against the level above it**, so
  `vars: { out: '${{ vars.x }}/dist' }` refines the `x` it is inheriting rather than reading its own
  half-built scope - which would make the answer depend on key order inside the block.

**`vars` is reserved at every level**, which costs a script that would have been called `vars`:
`run.vars` is a scope, not a script. Nothing enumerates `run`'s keys as a list of script names, so
that is where the cost stops.

**One gap, in the types only.** `run.vars` works at runtime and in YAML, but `RmanConfig` cannot
express it: `run` is keyed by script name, so any encoding that lets `vars` through has to widen the
index signature - and TypeScript then stops excess-property-checking *every* script's options
(measured: with the widened index, `run: { build: { exce: 'tsc' } }` compiles clean). Catching that
typo across every script is worth more than typing one key, so a typed JS config needs a cast:

```js
run: { vars: { x: 2 }, build: { exec: 'tsc' } } as RmanConfig['run'],
```

Every other level - `run.<script>.vars`, `version.vars`, `publish.vars`, `changelog.vars`,
`githubRelease.vars`, and a plugin's own option blocks - is typed through `ScopedVars`.

### Reading a file (`read`)

`file` says where something is; `read` says what is in it.

```yaml
"[*]":
  run:
    build:
      exec: 'tsc --outDir ${{ read("tsconfig.json").compilerOptions.outDir }}'
```

| | |
| --- | --- |
| `read(path)` | parsed contents, format taken from the extension |
| `read(path, format)` | for a name that does not say - `read('.npmrc', 'ini')` |

| format | extensions |
| --- | --- |
| `json` | `.json` |
| `yaml` | `.yml`, `.yaml` |
| `ini` | `.ini` |
| `xml` | `.xml`, `.csproj`, `.vbproj`, `.fsproj`, `.props`, `.targets`, `.nuspec`, `.plist` |

An extension it does not recognize is an error naming the four, never a guess at JSON.

**`.env` is deliberately absent**, and that is the one exclusion on principle: `env` is already in
scope, and a `.env` file exists to be loaded *into* an environment by something else, so reading one
as data would mean two different things called the environment.

**XML comes back as a DOM**, not a plain object - the asymmetry is the honest shape rather than an
omission. An element can repeat, carry attributes and hold text at the same time, so any flattening
has to pick a convention and be wrong for somebody. So it reads the way every other XML tool reads:

```yaml
"[*]":
  version:
    stamp: '${{ read("pom.xml").getElementsByTagName("version")[0].textContent }}'
```

A malformed XML file is an error, not a half-parsed document: `@xmldom/xmldom` reports problems
through a handler and otherwise carries on with whatever it salvaged, so without that check a
truncated file would come back as a DOM whose contents are simply missing.

Resolved against `pkg.dirname`, like `file` - so one `"[*]"` declaration reads each package's own
copy. A repository-level file is reached explicitly:

```yaml
"[*]":
  version:
    stamp: '${{ read(path.join(repository.dirname, "release.json")).stampFiles }}'
```

**It throws when the file is absent**, as `file.resolve` does. Compose with `file.exists` when the
absence is a case to handle rather than a mistake - no second function is needed:

```yaml
outDir: '${{ file.exists("tsconfig.json") ? read("tsconfig.json").compilerOptions.outDir : "build" }}'
```

**A manifest is `pkg.manifest`, not this.** `read('package.json')` works and is the wrong answer:
which file a package's identity lives in belongs to the ecosystem, so that expression is already
wrong in a Cargo package sitting beside a Node one. Use `pkg.manifest`,
`repository.package(name)?.manifest`, or `repository.manifest`.

#### Caching, and why it is keyed the way it is

A file is parsed **once for the whole repository**, not once per package - config resolution runs
once per package, so twenty packages reading one shared file would otherwise parse it twenty times.

The cache key is the file's `mtimeNs` and size, not its path, because **rman writes JSON files while
it runs**: `version` rewrites every bumped manifest and then re-interpolates its own deferred hooks.
A cache that only remembered the path would hand those back as they were before the write. A `stat`
costs 1.3µs against 16.1µs for a read and parse, so the check costs a thirteenth of what it saves.

The result is **deeply frozen and shared between packages**. Changing it would quietly change what
the next package sees, so it raises a `TypeError` instead; spread it first if you need a copy:

```js
const tweaked = { ...read('tsconfig.json'), extends: undefined };
```

### Function steps

A `run.<script>` step, a `version` hook and a `run.<script>.if` can each be **a function instead of
a string**. The string form is a shell command and stays the right shape for one; the function form
exists for the cases a shell command answers badly.

```js
// .rmanrc.mjs
import fs from 'node:fs';
import path from 'node:path';

export default {
  '[*]': {
    run: {
      build: {
        exec: 'tsc -b tsconfig-build.json',
        // a list may mix the two, and runs them in order
        after: [
          'chmod +x build/cli.js',
          function copyDocs({ pkg, repository }) {
            for (const name of ['README.md', 'LICENSE']) {
              const from = [pkg.dirname, repository.dirname].map(d => path.join(d, name)).find(fs.existsSync);
              if (from) fs.copyFileSync(from, path.join(pkg.dirname, 'build', name));
            }
          },
        ],
      },
    },
  },
};
```

**Why it exists - and it is about *when*, not about taste.** A `${{ ... }}` expression is evaluated
while the config resolves, which *every* command does (`rman list` included). So an expression can
only see the state the config was loaded in, and anything it *did* would happen on every
invocation. A function step runs when its turn comes. Reach for it when that difference matters, or
when the work is genuinely code; write a shell command when the step is a shell command.

**The context** (`RunStepContext`), the same object an `if` receives:

| | |
| --- | --- |
| `pkg` | the package this step is for - always set, and spelled `pkg` as in `${{ pkg }}` |
| `repository` | the whole repository |
| `cwd` | the directory the step is *about* - the package's, or the root for a monorepo bookend |
| `runBin(bin, argv, opts?)` | the repository's locally installed binaries, already bound to `cwd` and this run's log level |
| `logger` | at this run's resolved log level |

**Trap: `process.cwd()` is not changed.** A shell step is a child process and gets a real working
directory; a function runs inside rman's own, and `run` executes packages **concurrently** - one
step calling `process.chdir()` would move the ground under every step running beside it. So join
paths yourself:

```js
fs.writeFileSync('out.txt', data)                     // the repository root. Wrong, and silently so.
fs.writeFileSync(path.join(ctx.cwd, 'out.txt'), data) // the package
```

`ctx.runBin` is already bound to `cwd`, so a binary run through it needs no such care.

**Failure is a throw.** The return value means nothing - exactly as a non-zero exit is what fails a
shell step. **Prefer `ctx.logger` to `console`**: with the live progress panel on, a direct write
lands beside the panel instead of in the step's own log.

**Only the JS config forms can hold one**, since YAML cannot. A repository whose own `.rmanrc.yml`
`extends` a JS config still gets the functions that config declares, so a shared config package can
use them on behalf of repositories that stay in YAML.

`rman config` prints a function as `[Function: copyDocs]`, which is why naming them is worth it.

### Function values

**Any other config value may also be a function** - and that one is the JS spelling of a
`${{ ... }}` expression: same question, same moment, same scope.

```js
// .rmanrc.mjs
import path from 'node:path';

export default {
  vars: {
    coveragePath: ({ repository }) => path.join(repository.dirname, 'coverage'),
    buildDir: 'build',
  },
  '[*]': {
    changelog: { filePath: ({ vars }) => vars.notesFile },
    clean: { include: ({ vars }) => [vars.buildDir, '*.tsbuildinfo'] },
  },
  '[*]': {
    // `value` is what the layers underneath resolved to - the general form of `+key`
    clean: { include: ({ value, vars, pkg }) => [...value, path.join(vars.coveragePath, pkg.basename)] },
  },
};
```

It receives one object with **exactly** what an expression can name - `pkg`, `repository`, `file`,
`read`, `env`, `semver`, `path`, `git`, `value`, plus the config's own top-level keys (`vars`,
`publish`, …). There is no asymmetry between the two spellings:

| | |
| --- | --- |
| `value` | what this key resolved to in the layers **below** this one - the general form of `+key` |

`value` is bound in an expression too, so the same thing can be written either way:

```yaml
"[*]":    { version: { stamp: ['src/constants.ts'] } }
"[*]": { version: { stamp: "${{ [...value, 'src/version.ts'] }}" } }
```

A string that is *nothing but* one expression keeps that value's own type, which is what lets an
expression hand a real list back.

**`value` spreads as empty when nothing below sets the key**, so `[...value, 'x']` needs no guard.
That case is not exotic: a value written to extend an inherited list is also the first layer in a
repository that inherits nothing.

It used to be `undefined`, with `value ?? []` required at every site, on the grounds that defaulting
to `[]` would be a guess about the key's type - wrong for every key that is not a list. That
objection is answered rather than dropped: a non-list use **throws**, naming the key.

| | |
| --- | --- |
| `[...value, 'x']` | `['x']` |
| `` `${value}-x` `` | throws, naming the key |
| `value + 1` | throws, naming the key |

The last row is one the old answer got wrong: `undefined + 1` is `NaN`, which serialized to `null`
and read like a configured value.

`value ?? []` still works and still means the same thing, so a config already written needs no
change - the stand-in is an array, not `undefined`. The one consequence:
`value === undefined` is now `false`; ask `value.length === 0` instead.

**Why this is not just a nicer `${{ }}`:** an expression is a string, so it cannot carry a real
array or object, cannot see what it is overriding, and has to be written in a language with no
editor support inside a quoted value. A function is checked by TypeScript, refactorable, and can
import whatever it needs.

> **A value function must compute and return, never act.** It runs while the config resolves -
> which *every* command does - so one that copies a file copies it on `rman list`, `rman info` and
> `rman config` as well, once per package, with nothing having asked. This is also why `file` offers
> only `exists`/`resolve`/`resolveFirst` and will never gain a `copy` or `write`.
>
> Work belongs in a **step**, the one thing rman runs on purpose - and a step can be a function too,
> so nothing is lost by keeping the two apart:
>
> ```js
> clean: { include: ({ vars }) => [vars.buildDir] },            // computes. Right.
> run: { build: { after: ({ pkg }) => fs.copyFileSync(...) } }, // acts. Also right - it is a step.
> changelog: { filePath: () => { fs.mkdirSync('out'); ... } },  // acts at read time. Wrong.
> ```

#### Which functions are values, and which are code

Both kinds live in one config, and **the key decides** - exactly as the key already decides whether
a string is a shell command or a path:

| | |
| --- | --- |
| `run.<script>`, `run.<script>.before`/`.exec`/`.after`, `run.<script>.if`, `version.before`/`.exec`/`.after` | **code** - left alone, called later by `run`/`version` |
| `plugins` and anything under it | **code** - a plugin object is functions all the way down |
| everything else | **a value** - called when the config resolves |

```js
'[*]': {
  clean: { include: ({ vars }) => [vars.buildDir] },  // a value: called now
  run: { build: { after: ({ pkg }) => copy(pkg) } },  // a step: called by `rman build`
}
```

No marker to remember, and nothing about the function itself is inspected - arity or parameter
names would be a guess, and guessing wrong means either running build-time code while merely
*loading* the repository, or silently never running it.

A command interpolating a fragment of the config on its own must say where that fragment sits
(`interpolateConfig(value, scope, { at: ['version', slot] })`), or the path matches nothing and a
step there is mistaken for a value.

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
| `version.releaseTagPattern` | `string` (glob) | `'release-*'` | Root-level only. Names the **repository's** release, as opposed to the per-package/group tags `changelog.tagPattern` names - created only when the root is on a calendar version. Must not match any package's own pattern. |
| `version.stampDockerfile` | `boolean` | `true` | Per-package cascaded. Rewrite this package's Dockerfile `org.opencontainers.image.version` label to the version being written, in the same commit as the bump. Only ever rewrites a label already declared; reads `publish.docker.dockerfile`. |
| `version.stamp` | `string \| string[]` | none | Per-package cascaded. Source files (relative to the package's own directory) whose `version` constant is rewritten to the version being written, in the same commit. A listed file a package doesn't have is a silent no-op. |
| `version.before` / `.exec` / `.after` | `RunStepValue \| RunStepValue[]` | none | Per-package cascaded. Hooks around a version bump's write (real npm `preversion`/`version`/`postversion` scripts still win if the package defines them). A `RunStepValue` is a shell command **or a function** - see [Function steps](#function-steps). |
| `changelog.ignoreTypes` | `string[]` | `[]` | Per-package cascaded. Conventional Commit `type`s dropped entirely from changelog output. |
| `changelog.template` | `string` (a file **path**, relative to repo root) | built-in template | Per-package cascaded. Throws if the path doesn't exist. |
| `changelog.filePath` | `string` | `'CHANGELOG.md'` | Per-package cascaded, relative to that package's own directory. CLI `--file-path` wins when given. |
| `changelog.tagPattern` | `string` (glob, may contain `{name}`) | `'v*'` | Per-package cascaded. `{name}` → independent per-package tags (`{name}@*`); no `{name}` → one shared repo-wide tag scheme. |
| `clean.include` / `.exclude` | `string \| string[]` | `[]` | Per-package cascaded, resolved relative to that package's own directory. |
| `clean.skip` | `boolean` | `false` | Per-package cascaded - opts a package out of `clean` entirely. |
| `publish.target` | `string` or an array of them | whichever installed targets *claim* the package | Per-package cascaded. Which **registry** `publish` ships this package to - a name from the installed [publish targets](#publishtarget), never a fixed list. Each has its own "already published?" check: npm via `npm view`, docker via `docker manifest inspect`. A name nothing implements is an error naming the ones this repository has. The repository's GitHub Release is not a target here - see `githubRelease`. |
| `publish.npm.directory` | `string` | none (the package's own directory) | Per-package cascaded. Where the publishable output lives, relative to the package's own directory. A package's own `publishConfig.directory` wins over it; `--contents` is the last fallback. Publishing from such a directory means **`publish` generates the manifest there** - see below. |
| `publish.docker.image` | `string` | none (required once `"docker"` is a target) | A bare name is prefixed with `--docker-namespace`/`DOCKERHUB_NAMESPACE`; one already containing `/` is used verbatim. |
| `publish.docker.dockerfile` | `string` | `'Dockerfile'` | Relative to the package's own directory. |
| `publish.docker.platforms` | `string[]` | `['linux/amd64']` | `docker buildx build --platform` targets. |
| `publish.docker.cwd` | `string` | that package's own directory | Relative to the repository root. |
| `publish.docker.buildContexts` | `Record<string, string>` | `{}` | Named `--build-context <name>=<path>` entries, each path relative to the package's own directory. |
| `publish.docker.buildArgs` | `Record<string, string>` | `{}` | `--build-arg <name>=<value>` entries. A value of exactly `"$NAME"` expands from `process.env.NAME`. |
| `publish.docker.readme` | `string` | `'DOCKER_README.md'` | Relative to the package's own directory - becomes the DockerHub repo's description, if present. |
| `githubRelease.assets` | `string[]` | `[]` | Per-package cascaded. Globs (relative to the package's own directory) uploaded onto the one release. A release with no assets is still valid. |
| `githubRelease.repository` | `string` | parsed from the `origin` remote | Root-level only. `owner/repo` the release is created in. |
| `githubRelease.draft` | `boolean` | `false` | Root-level only. Create the release as an unpublished draft. |
| `githubRelease.prerelease` | `boolean` | whether the version is a semver prerelease | Root-level only. Mark the release as a prerelease. |
| `publish.skip` | `boolean` | `false` | Per-package cascaded - excludes this package from `publish` entirely (every target), regardless of `target`/`"private"`. `changelog` also skips it by default (its own `--include-skipped` overrides). `version` never consults this. |
| `run.<script>.concurrency` | `number` | CPU count | See [`RunService`](#runservice) below. |
| `run.<script>.topo` | `boolean` | `true` | Precedence: CLI flag > package config > fallback. |
| `run.<script>.bail` | `boolean` | `true` | **Unusual precedence:** package config > CLI flag > fallback (see below). |
| `run.<script>.progress` | `boolean` | `true` | Per-package cascaded (the panel itself is one shared instance per run). |
| `run.<script>.logLevel` | `LogLevel` | root's resolved log level | Per-package cascaded. |
| `run.<script>.changedSince` | `string` | none | Root-level fallback, used only when CLI `--changed-since` isn't given. |
| `run.<script>.skip` | `boolean` | `false` | Per-package cascaded - opts a package out of running this script entirely. |
| `run.<script>.if` | `string` (small expression grammar) \| `RunConditionFn` | none (always runs) | Per-package cascaded. See [`RunService`'s conditional execution](#conditional-execution-if) and [Function steps](#function-steps). |
| `run.<script>.before` / `.exec` / `.after` | `RunStepValue \| RunStepValue[]` | none | Per-package cascaded - supplies the step(s) to run when the package's own `package.json` doesn't define this script slot. A `RunStepValue` is a shell command **or a function** ([Function steps](#function-steps)); a list may mix them. A bare value in place of the whole `run.<script>` object is shorthand for `exec`. |
| `run.<script>.override` | `boolean` | `false` | Per-package cascaded - when `true`, the config's script replaces the package's own definition even when it has one. |
| `extends` | `string \| string[]` | none | Root of each file only. Configs to inherit from - see [above](#inheriting-a-shared-config-extends). |
| `dependencies` | `string[] \| Record<string, string>` | none | Extra in-repo "dependencies" not present in the package's real `package.json`, purely for rman's own dependency graph (topo-sort, `--deps`/`--dependents`, `run`'s task scheduling). Declared from the root through a selector (`"[pkg-a]": { dependencies: [...] }`) or in the package's own `.rmanrc`. |

`run.<script>.bail`'s precedence is worth calling out explicitly, since it's the one exception to
"CLI always wins": a package's own `.rmanrc bail: true/false` outranks even an explicit
`--bail`/`--no-bail` flag on the command line, because "this package's failure must always stop
the batch" is a more specific, intentional statement than a broad flag meant for the whole run -
and shouldn't be silently overridable by it.

### Editor support (types)

Autocomplete, inline docs and typo checking come from the **`RmanConfig` type**, so they apply to
the JS forms of the config - `.rmanrc.cjs`, `.rmanrc.mjs`, `.rmanrc.js`. Write the config through
`defineConfig`, which is an identity function whose only job is to type its argument:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman';

export default defineConfig({
  allowBranch: ['main'],
  '[*]': { run: { build: { exec: 'tsc -b' } } },
});
```

A JSDoc annotation does the same without the import, which is what a `.cjs` config usually wants:

```js
// .rmanrc.cjs
/** @type {import('rman').RmanConfig} */
module.exports = { allowBranch: ['main'] };
```

**With a plugin, import `defineConfig` from the plugin instead** - `rman-node`'s is the same
function typed with `RmanNodeConfig`, and the import is what carries the plugin's own keys
(`clean`, `publish.npm.directory`, `packageManager`) into the type:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman-node';

export default defineConfig({
  plugins: ['rman-node'],
  packageManager: 'pnpm',
  '[*]': { clean: { include: 'build' } },
});
```

**The JSON and YAML forms have no editor support, deliberately.** rman used to ship a JSON Schema
for them; it was removed because a schema cannot describe a config whose keys are contributed by
plugins. JSON Schema's own extension mechanism (`allOf` + `$ref`) cannot add a key to a closed
object - `additionalProperties: false` is evaluated against the properties of its *own* schema
object only, so a plugin's branch is rejected by the core's, measured on both draft-07 and 2019-09's
`unevaluatedProperties`. What remained possible was generating one merged document per repository,
which is not a JSON Schema feature at all but a build step of our own, producing a file no other
tool understands - and it still had no answer for a `.rman/*.mjs` command's own keys, which are
one repository's and never published anywhere. The type composes properly instead
(`declare module 'rman'`), so it is the single source, and the price is that `.rmanrc`/`.rmanrc.yml`
get no checking: **rman validates config at no point during a run**, so an unknown key in those
forms is silent. Use a JS config for anything non-trivial.

## Services

**Every service is a class, reached through the application** - `app.getService('version')`, never
a constructor call of your own. Each extends `Service`, which gives it `this.repository` and
`this.logger`; the repository is not a parameter any more, because the application carries it and
every caller had exactly one.

```ts
import { Repository } from 'rman';

const repository = await Repository.create();
const app = repository.app;
const version = repository.app.getService('version');
const plan = await repository.app.getService('list').getPackages();
```

- **`getService` is typed by `ServiceMap`**, a declaration-merged interface each service augments
  from its own file. A misspelled name is a compile error rather than a runtime `undefined`, and a
  plugin adds its own service the same way.
- **Built on first use.** `rman info` has no business constructing the changelog and release
  services, and services reach each other through the application - so resolving at call time is
  also what keeps that from being a construction cycle.
- **A plugin can replace one**, with `app.setService(name, app => new MyService(app))`, before it is
  first built.

Most follow the same **plan → apply** shape: a pure `getPlan` (or `getEntries`/`getPackages`) that
computes what *would* happen without touching anything, and a separate `applyPlan` (or
`generateToFile`) that writes, commits or publishes. That mirrors what rman's own commands do:
compute a plan, print it, optionally ask for confirmation, then apply it.

**Two things stayed plain exported functions**, and the line is whether they need the repository:
`ChangeHashService` and `ConventionalCommitsService` are pure functions of their arguments, so
putting an application between a caller and a parser would be ceremony.

### `VersionService`

Computes and applies version bumps across the repository, with `.rmanrc group`-based release
grouping (fixed or independent versioning), Conventional Commits-based severity auto-detection,
cross-group dependency-range propagation, and prerelease (`--preid`) support.

"Since the last release" is resolved by the shared [`ChangeHashService`](#changehashservice) - the very
same boundary `ChangelogService` measures from, so `changed`/`version`/`changelog` never disagree
about which commits are unreleased. This is deliberately a *commit*-driven question, independent of
what any registry currently holds: only commits can say how big a bump is warranted, and why. The
mirror-image question ("is this version already out there?") belongs to each
[publish target](#publishtarget) and to `GithubReleaseService`, which answer it against their own
registry.

```ts
namespace VersionPlanService {
  interface Options extends PackageFilterOptions {
    /** One of the root scheme's own `bumpNames`, or a concrete version it recognizes - either way
     *  this replaces auto-detection. Omit to detect the bump per group from commit subjects. */
    bump?: string;
    ignoreDirty?: boolean; // default false
    preid?: string; // e.g. "beta" -> prerelease bumps
    now?: () => Date; // the clock behind a calendar release version - injectable for tests
  }

  /** One package's outcome in a plan. */
  interface Entry {
    package: Package;
    groupKey: string; // internal group identity, not for display
    group: string; // human-readable group name
    status: 'bump' | 'skip' | 'error' | 'no-change';
    from: string;
    to?: string; // only set when status === 'bump'
    reason?: string;
  }

  type Cascade = 'changed' | 'dependents' | 'group';

  /** The registered orchestrator. Throws when a repository's plugins contribute none. */
  function getPlanner(app: RmanApplication): VersionPlanService;
}

/** Abstract - a technology supplies it (`Plugin.versionPlanner`). */
abstract class VersionPlanService {
  getPlan(repository: Repository, options?: VersionPlanService.Options): Promise<VersionPlanService.Entry[]>;

  /** The two a technology must answer. Asked of the *package's own* planner, not the orchestrator. */
  protected abstract detectBoundary(git: GitHelper, pkg: Package, options: Options): Promise<string | undefined>;
  protected abstract cascade(bump: string): VersionPlanService.Cascade;
}

namespace VersionService {
  interface ApplyOptions {
    push?: boolean; // default false
    message?: string; // overrides .rmanrc version.commitMessage for this run
    changelog?: boolean; // also write CHANGELOG.md and fold it into the same commit
  }

  /** What `applyPlan` did - not the plan it was given. */
  interface ApplyResult {
    entries: VersionPlanService.Entry[]; // the plan, as given
    updated: VersionPlanService.Entry[]; // the entries whose manifest was actually written
    commits: { sha: string; message: string; packages: string[] }[];
    tags: { name: string; created: boolean; release?: boolean }[];
    pushed: boolean;
  }
}

class VersionService {
  applyPlan(plan: VersionPlanService.Entry[], options?: ApplyOptions): Promise<ApplyResult>;
}
```

**The plan comes from `VersionPlanService`, not from here.** `VersionService` only *applies* one -
the split is what lets an ecosystem answer the two questions no repository-in-general can (see
[`VersionPlanService`](#versionplanservice)), while the writes, commits and tags stay the core's.

#### Basic usage

```ts
import { Repository, VersionPlanService } from 'rman';

const repository = await Repository.create();
const app = repository.app;

// 1. Compute a plan - never writes anything. The planner comes from the repository's plugins.
const plan = await VersionPlanService.getPlanner(app).getPlan(repository); // severity from commits

for (const entry of plan) {
  console.log(entry.status, entry.package.name, entry.from, '->', entry.to, entry.reason);
}

// 2. Apply it - writes package.json, commits, tags (once per group).
const result = await app.getService('version').applyPlan(plan, { push: true, changelog: true });

console.log(`${result.updated.length} packages`);
for (const c of result.commits) console.log(c.sha, c.message, c.packages);
for (const t of result.tags) console.log(t.name, t.created ? 'created' : 'already existed');
console.log(result.pushed ? 'pushed' : 'not pushed');
```

**`applyPlan` reports what it did**, because none of it is derivable from the plan: a run makes one
commit per group *plus* a monorepo root's informational sync, tags each group, may add a repository
release tag, and leaves an already-existing tag alone. `updated` is deliberately narrower than the
plan's `'bump'` entries - a monorepo root's entry is never written, so counting it said two writes
where there was one. It returned the plan array untouched before, which is why `rman version`
could only re-print the table it had already shown.

A tagged group release commit is always the **last** commit `applyPlan` makes: a monorepo root's
own version-sync commit goes in ahead of the group commits, so the release tag lands on `HEAD`
rather than one commit behind it (which would leave `git tag --points-at HEAD` empty for anything
reading back the tag it just released).

#### The repository's own version (monorepo root)

A monorepo root is never published, but its version is the **repository's release identity** - what
a GitHub Release is named after. How it's computed is derived from the repo, never configured:

- **One group** - the root follows it, so repo and packages share one number. Unchanged behavior.
- **Several groups** - a calendar version, `YYYY.M.D-HHmm` with nothing padded (`2026.9.5-930`;
  semver forbids leading zeroes in numeric identifiers, and the root's `package.json` must stay
  valid). With several version lines there is no shared number to report: the older "highest among
  the groups" rule left the root standing still whenever a *lower* line released, so a release had
  no identity of its own.

The choice is sticky - once the repo (or its last release tag) is on a calendar version it stays
there, because going back would *lower* the root version (`2026.9.15-1430` → `1.4.0` compares as a
decrease). On a calendar version `applyPlan` also creates a repository release tag
(`version.releaseTagPattern`, default `release-*`) alongside the per-group ones; with a single
version line the group's own tag already is the release, so no second name is created.

`Options.now` injects the clock behind that version, so tests are deterministic.

#### Explicit bump keyword or version

```ts
// Force every changed package's group to a minor bump, regardless of commit content:
const plan = await VersionPlanService.getPlanner(app).getPlan(repository, { bump: 'minor' });

// Or set every changed package straight to an exact version:
const plan = await VersionPlanService.getPlanner(app).getPlan(repository, { bump: '2.0.0-rc.1' });
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
const plan = await VersionPlanService.getPlanner(app).getPlan(repository); // no `bump` at all
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
const app = repository.app;
// First run: 1.2.3 -> 1.3.0-beta.0 (a fresh prerelease of the computed "minor" severity)
let plan = await VersionPlanService.getPlanner(app).getPlan(repository, { bump: 'minor', preid: 'beta' });
await app.getService('version').applyPlan(plan);

// Later, with new commits: 1.3.0-beta.0 -> 1.3.0-beta.1 (same identifier -> increments)
plan = await VersionPlanService.getPlanner(app).getPlan(repository, { bump: 'minor', preid: 'beta' });
await app.getService('version').applyPlan(plan);

// Switching the identifier starts a fresh prerelease line instead of incrementing:
plan = await VersionPlanService.getPlanner(app).getPlan(repository, { preid: 'rc' }); // -> 1.3.0-rc.0
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
  range only at publish time (see [`PublishService`](node.md#publishservice), in `rman-node`).
- An **explicit** `"workspace:<range>"` (e.g. `"workspace:^1.0.0"`) *is* bumped, the same way a
  plain range would be: `"workspace:^1.0.0"` → `"workspace:^2.0.0"`.

#### Stamping the version where the package declares it

`applyPlan` also rewrites a bumped package's `org.opencontainers.image.version` Dockerfile label to
the new version and folds that file into the same commit as the bump (`stampVersionLabel`, in
[`src/utils/version-stamp.ts`](../src/utils/version-stamp.ts)). The label is by specification *the
version of the packaged software*, so there is exactly one correct value for it and this is what
knows it; doing it from a build script instead leaves the edit uncommitted and records a stale label
in the commit that was tagged.

The file is the one `DockerPublishService` builds from (`publish.docker.dockerfile`, default
`Dockerfile`, relative to the package's own directory), so the two can never disagree. A label the
Dockerfile doesn't already declare is never inserted, the existing quoting style is preserved, and
the same key outside a `LABEL` instruction is ignored. Opt out with `version.stampDockerfile: false`.

The same pass rewrites the `version` constant in every file `version.stamp` lists
(`stampVersionConstant`) - `export const version = '1'` → the new version, matching an object
property (`version: '...'`) too, only on the whole identifier, quoting preserved. Explicitly listed
rather than discovered, since no standard says a given file holds the version; a listed file a
package doesn't have is a silent no-op.

#### Dirty packages

```ts
// Default: any package with uncommitted local changes aborts the whole plan (status "error").
const plan = await VersionPlanService.getPlanner(app).getPlan(repository);
if (plan.some(e => e.status === 'error')) {
  throw new Error('Some packages have uncommitted changes');
}

// Or exclude them instead (status "skip"):
const plan = await VersionPlanService.getPlanner(app).getPlan(repository, { ignoreDirty: true });
```


### `VersionPlanService`

**Abstract - a technology supplies it**, through `Plugin.versionPlanner`. `version`/`changed`
fail naming that key when a repository's plugins contribute none: there is no version plan that is
merely a diminished one, and a wrong boundary or cascade releases a plausible, untrue set of
packages.

Two roles, and they resolve differently:

| | |
| --- | --- |
| **Orchestrator** | `app.versionPlanner` - one slot, last registration wins. Drives groups, the commit→size reading, the cross-group ripple and the root's release identity: none of it belongs to a technology, and all of it is computed for the whole repository at once. |
| **Per package** | `detectBoundary` and `cascade`, asked of `pkg.techStack.versionPlanner` (falling back to the orchestrator). |

That split is not cosmetic. Both used to come off the single slot, so in a polyglot repository a
Cargo package's boundary fell back to `npm view` and its cascade assumed npm's caret ranges -
whichever plugin registered last decided for every package. A group whose members disagree about
`cascade` takes the **widest** answer: too narrow releases too little, which is the invisible
failure; too wide releases a package that did not strictly need it.

The two abstract members are exactly the decisions no repository-in-general has an answer to:

- **`detectBoundary`** - since when is a package unreleased. Git tags answer it for any repository
  (`ChangeHashService.detect` is exported for that), but *which* registry stands in when a package
  has no tag yet is the ecosystem's business.
- **`cascade`** - how far into its group a bump reaches, named in the scheme's own `bumpNames`. The
  familiar patch/minor/major mapping is a statement about **npm's dependency ranges**: `^1.2.0`
  already tolerates a patch, so nothing downstream needs republishing. An ecosystem pinning exact
  versions has to release every dependent for the same patch.

```ts
class NodeVersionPlanService extends VersionPlanService {
  protected detectBoundary(git: GitHelper, pkg: Package) {
    return ChangeHashService.detect(git, pkg);
  }
  protected cascade(bump: string): VersionPlanService.Cascade {
    return bump === 'major' ? 'group' : bump === 'minor' ? 'dependents' : 'changed';
  }
}
```

### `PublishTarget`

**Where a package's artifact ships, as a contribution.** The [`publish`](cli/publish.md) command is
rman's; a target is one answer to "is this version on the registry, and how do I push it", which is
the only part of publishing an ecosystem owns. rman registers `docker`; `rman-node` registers `npm`.

```ts
interface PublishTarget {
  name: string;                                    // what publish.target and --target call it
  describe?: string;                               // one line, for --target's help
  options?: Record<string, RmanConfig.CommandOption>; // merged into `publish`'s own flags
  claims?(pkg: Package): boolean;                  // is this package mine when it declares nothing?
  getPlan(ctx: PublishTarget.Context): Promise<PublishTarget.Entry[]>;
  applyPlan(ctx: PublishTarget.Context, plan: PublishTarget.Entry[]): Promise<PublishTarget.Entry[]>;
}

namespace PublishTarget {
  interface Context {
    app: RmanApplication;
    repository: Repository;
    options: Options;             // the shared filters, read off argv once by the command
    args: Record<string, any>;    // the parsed argv - where a target reads its own flags
  }

  interface Options extends PackageFilterOptions {
    ignoreDirty?: boolean;
  }

  interface Entry {
    package: Package;
    version: string;
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    detail?: string;              // printed beside the package - docker's resolved image ref
    reason?: string;
  }
}
```

Registered on the application, in `plugins` declaration order:

```ts
export const cargoPlugin = definePlugin({
  name: 'rman-cargo',
  init(ctx) {
    ctx.app.publishTargets.add(cratesIoTarget);
  },
});
```

- **`claims` is where a default belongs.** A package with no `publish.target` of its own is offered
  to every target that claims it - `npm`'s answer is `pkg.provider === 'node'`, and `docker` has no
  answer at all, which is what makes it opt-in. rman itself cannot state either; it used to try, with
  a hardcoded `['npm']`, and reported `publishTargets: ["npm"]` for a Cargo package.
- **`options` are merged into `publish`'s flags** where the command is built. Two targets declaring
  the same option name throws, naming both - npm has a `--registry` and so would a Cargo target,
  and any rule for picking a winner gives you a flag that silently means the other one's thing.
- Which packages a target is asked about is `shipsTo(pkg, target)` / `targetsOf(app, pkg)`, both
  exported - use them rather than re-reading `publish.target`, so `publish` and `rman list --json`
  cannot disagree.

### `DockerPublishService`

Computes and applies `docker buildx build --push` across every package that opts into the
`"docker"` publish target - unlike the npm side (opt-out via `"private"`), this is opt-in: only a
package whose own (cascaded) `.rmanrc "publish.target"` includes `"docker"` is a candidate at all.
`.rmanrc "publish.skip"` excludes it regardless, same as on the npm side.

Reached through `dockerPublishTarget`, which is what `publish` actually calls; the service is the
implementation and stays callable on its own.

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

}

class DockerPublishService {
  getPlan(options?: Options, deps?: Deps): Promise<Entry[]>;
  applyPlan(plan: Entry[]): Promise<Entry[]>;
}
```

```ts
import { DockerPublishService } from 'rman';

const app = repository.app;
const plan = await app.getService('dockerPublish').getPlan();
for (const entry of plan) console.log(entry.status, entry.package.name, entry.image, entry.reason);

await app.getService('dockerPublish').applyPlan(plan);
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

Computes and applies the repository's GitHub Release, behind the [`github-release`](cli/github-release.md)
command. It asks a question that only *looks* like `PublishService`'s and `DockerPublishService`'s:
those ask whether a package's artifact has reached a registry; this asks whether the repository has
recorded that a version shipped.

That difference is why it is **not** a `publish.target` and **not** opt-in. A release's tag covers
the whole source tree, so a run produces **one** release whose body covers every package that
shipped under it - a per-package release would have to invent a tag no package owns - and there is
no useful repository that releases code and wants no record of it. It needs no configuration at all;
the optional `"githubRelease"` block only carries details. `"private": true` and `publish.skip` are
both irrelevant here (they only ever excluded registry candidates).

```ts
namespace GithubReleaseService {
  interface Deps {
    releaseExists?: (repository: string, tag: string) => Promise<boolean>; // for tests
  }

  interface Options {
    ignoreDirty?: boolean;
    repository?: string; // "owner/repo" override - no package filtering: this is repo-level
  }

  interface Entry {
    package: Package; // always the repository root
    version: string; // the repository's own release version
    status: 'publish' | 'skip' | 'up-to-date' | 'error';
    tag?: string; // the repository's release tag
    repository?: string; // "owner/repo" this release lands in
    reason?: string;
  }

}

class DockerPublishService {
  getPlan(options?: Options, deps?: Deps): Promise<Entry[]>;
  applyPlan(plan: Entry[]): Promise<Entry[]>;
}
```

```ts
import { GithubReleaseService } from 'rman';

const app = repository.app;
const plan = await app.getService('githubRelease').getPlan();
for (const entry of plan) console.log(entry.status, entry.package.name, entry.tag, entry.reason);

await app.getService('githubRelease').applyPlan(plan);
```

The release is identified by the repository's own version (the root's - see
[The repository's own version](#the-repositorys-own-version-monorepo-root)): its release tag
(`version.releaseTagPattern`) when that version is a calendar one, and otherwise the tag of the
single shared version, which is the group's own tag - so a repo with one version line gets no second
name for the release it already has. `owner/repo` comes from `options.repository`, then the root's
`githubRelease.repository`, then the `origin` remote's URL (SSH and HTTPS forms both parse); an
unresolvable one is `'error'`, not a silent skip. Uncommitted changes anywhere are `'error'` unless
`ignoreDirty` downgrades them to `'skip'`, and so is a release tag that doesn't exist in this clone -
either `version` never ran or the tags weren't fetched, and releasing anyway would silently produce
notes covering the entire history (the previous release tag that bounds them can't be found either). Otherwise `GET /repos/{owner}/{repo}/releases/tags/{tag}`
decides `'up-to-date'` vs `'publish'` - a genuine 404 is the only "not released yet"; every other
failure (missing/invalid `GITHUB_TOKEN`, typo'd repository) surfaces as `'error'` at plan time
rather than as a publish that fails much later.

`applyPlan` builds the body from `ChangelogService`, one section per package, each bounded by the
*previous repository release* and headed with that package's own version - so a repo whose packages
sit on different version lines still reads correctly. A package with nothing in that range
contributes no section, which is also how a package that didn't ship this time is left out. The
boundary is deliberately not `ChangeHashService.detect`'s auto-detection, which would resolve to the very
tag being released and correctly find nothing. An existing release for the tag (HTTP 422) is updated
rather than failed, so a re-run after a partial failure converges. Every package's
`githubRelease.assets` globs (resolved against its own directory) are uploaded onto the one
release.

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

}

class ChangelogService {
  getEntries(options?: Options): Promise<Entry[]>;
  generateToFile(options?: Options): Promise<Entry[]>;
}
```

```ts
import { ChangelogService } from 'rman';

const app = repository.app;
// Pure - just compute the entries, print/inspect them yourself:
const entries = await app.getService('changelog').getEntries();
for (const entry of entries) console.log(entry.content);

// Since a specific commit, for every package:
const entries = await app.getService('changelog').getEntries({ from: 'a1b2c3d' });

// Actually prepend each entry into its own CHANGELOG.md:
const written = await app.getService('changelog').generateToFile({ root: true });
for (const entry of written) console.log('wrote', entry.filePath, 'for', entry.package.name);
```

By default (`from` omitted, or `"npm"`), the boundary is auto-detected per package from its own
most recent release tag first - the same one `version`/`changed` themselves use, so all three
agree on "since when" - falling back to its currently-published npm version only when it has no
tag at all yet (via [`ChangeHashService`](#changehashservice)); a package that can't be resolved
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

}

class RunService {
  runScript(script: string, options?: Options & { commandName?: string }): Promise<void>;
}

// Also exported at module scope:
function resolveBool(cliValue: boolean | undefined, pkg: Package, script: string, key: string, fallback: boolean): boolean;
function resolveBail(cliValue: boolean | undefined, pkg: Package, script: string, fallback: boolean): boolean;
function resolveNumber(cliValue: number | undefined, pkg: Package, script: string, key: string, fallback: number): number;
function resolveLogLevel(cliValue: LogLevel | undefined, pkg: Package, script: string, fallback: LogLevel): LogLevel;
```

```ts
import { RunService } from 'rman';

const app = repository.app;
// Runs "build" in every package, dependency order, CPU-count concurrency.
await app.getService('run').runScript('build');

// Only in packages changed since the last publish, serially, never bailing on a single failure:
await app.getService('run').runScript('test', { changed: true, parallel: false, bail: false });
```

`runScript` throws an `Error` with `.logged = true` (see [below](#the-logged-error-convention)) if
any package's steps failed - `await` it inside a `try`/`catch` if you want to keep going
programmatically instead of letting the process exit. "Any" is counted from the per-package
outcomes, not from whether the underlying task tree rejected: a package's own `bail` aborts that
tree, whose promise then settles while the packages already in flight keep running, so reading the
run off it used to resolve on a failed run - and inconsistently, depending on which siblings
happened to still be going.

It also throws when **nothing defines the script at all** - a typo, or a script that was removed,
which `npm run` fails on too. A monorepo root's own `<script>` doesn't count as defining it, since
the root only ever contributes `pre`/`post` bookends; a script living solely there runs nothing, and
treating it as "defined" is what let a CI step report success for months while doing nothing. Every
package being **filtered out** instead (`scope`/`changed`/`run.<script>.skip`/a non-matching `if`)
resolves normally: zero is the right answer to what was asked.

#### Per-script config (`.rmanrc run.<script>`)

```yaml
run:
  test: mocha # a bare string is shorthand for { exec: mocha }
  build:
    concurrency: 2
    before: [node ./generate.js, node ./validate.js]
    exec: tsc -b # used only if the package's own package.json has no "build" script
    after: node ./copy-assets.js
    override: true # use these even if the package DOES define its own build/prebuild/postbuild
  lint:
    topo: false # lint scripts are independent - alphabetical order, no dependency waiting
    bail: false
  test:
    skip: true # this package opts out of "test" entirely
```

`getConfig(pkg, script)` reads exactly this resolved block for one package/script pair - useful if
you're building your own tooling on top of the same config convention.

**`RunService` does not ask every key of every package.** `concurrency`, `progress`, `changed` and
`changedSince` it reads off the **root package only** - one scheduler, one answer for the whole
batch - while `logLevel`, `skip`, `if`, `override` and the step slots are per package, and `topo`
and `bail` are read both ways and mean different things at each. The block above is unmarked, so it
reaches the root package as well as the members and every key lands; a `"[*]"` block would not
reach the root, and the scheduling keys in it would be silently ignored. See
[the table in `docs/cli/run.md`](cli/run.md#per-packagescript-configuration-rmanrc-runscript).

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
const app = repository.app;
const node = RunService.parseIfExpr('changed and not dirty');
const cache = new Map();
const shouldRun = await app.getService('run').evaluateIf(pkg, node!, cache);
```

An unrecognized atom name prints a one-time warning and evaluates to `true` (the package still
runs) rather than failing the whole command over a typo.



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

}

class ExecService {
  exec(command: string, options?: Options): Promise<void>;
}
```

```ts
import { ExecService } from 'rman';

const app = repository.app;
await app.getService('exec').exec('rm -rf dist');
await app.getService('exec').exec('ls -la', { scope: 'pkg-a', topo: false });
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
    publishTargets: string[]; // where it actually ships: its own "publish.target", or what claims it
    docker?: RmanConfig.DockerPublishOptions; // present only when "docker" is one of publishTargets
  }

}

class ListService {
  getPackages(options?: Options): Promise<Item[]>;
}
```

```ts
import { ListService } from 'rman';

const app = repository.app;
const items = await app.getService('list').getPackages({ toposort: true });
const graph = Object.fromEntries(items.map(i => [i.name, i.dependencies]));

const changedOnly = await app.getService('list').getPackages({ changed: true });
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

}

class ImportService {
  importRepo(sourcePath: string, options?: Options): Promise<Result>;
}
```

```ts
import { ImportService } from 'rman';

const app = repository.app;
const result = await app.getService('import').importRepo('../my-old-standalone-repo', {
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

  interface Options {
    repository?: Repository; // the core uses it for nothing - it is there for augmentations
    envinfo?: envinfo.RunConfig; // extra categories, merged OVER the defaults
  }

  type GetSystemInfo = (options?: Options) => Promise<SystemInfo.SystemInfo>;

  function getSystemInfo(options?: Options): Promise<SystemInfo.SystemInfo>;
  function getRepositoryInfo(repository: Repository): SystemInfo.RepositoryInfo;
}
```

```ts
import { SystemInfo } from 'rman';

const sys = await SystemInfo.getSystemInfo({ repository });
const repo = SystemInfo.getRepositoryInfo(repository);
console.log(`${repo.type} "${repo.name}" - ${repo.packageCount} package(s)`);
```

What it reports is **deliberately empty of anything language-specific**: OS, CPU, memory, shell,
Node and git - facts about the machine, true of any repository. There is no `packageManager` option
here, and that is the point rather than a gap: the core has no opinion about npm, so a Cargo
repository cannot end up reporting `npm: Not Found`, which is a wrong answer rather than a missing
one. A plugin adds its ecosystem's half by augmenting `Options` and wrapping `getSystemInfo` -
`Options.repository` exists for exactly that, giving an augmentation somewhere to read a setting
from (`rman-node` takes `.rmanrc "packageManager"` off it). `envinfo` merges *over* the defaults, so
an augmentation can replace `Binaries` rather than only append to it. See
[node.md](node.md#systeminfo-the-npm-half).

## Shared utilities

### `ChangeHashService`

Resolves the commit a package's changes should be measured "since" - the single boundary
`ChangelogService` **and** `VersionService` (so `changed`/`version` too) both call, rather than each
deciding for itself. It also owns tag naming in both directions, so nothing else builds a tag name.

```ts
namespace ChangeHashService {
  const AUTO = 'auto'; // what omitting `from` already means

  interface DetectOptions {
    from?: string; // an explicit ref wins outright; AUTO asks for auto-detection
    catchUpFile?: string; // widens the boundary to cover what this file never recorded
  }

  function detect(git: GitHelper, pkg: Package, options?: DetectOptions): Promise<string | undefined>;

  function tagPattern(pkg: Package): string;
  function findLatestTag(git: GitHelper, pkg: Package): Promise<string | undefined>;
  function expandTag(pkg: Package, version: string): string; // version -> tag name
  function extractVersion(tag: string, expandedPattern: string): string; // and back
  function applyTagPattern(pattern: string, name: string, version: string): string;
}
```

Auto-detection order, first match winning: (1) the package's own most recent release tag - the
network-free `findLatestTag` lookup, `git tag --list` for a `{name}`-bearing pattern and
`git describe` for a repo-wide one; (2) failing that, the plugin's `manifestProvider.publishedVersion(pkg)` - the
package's **own ecosystem's** registry, mapped onto a tag name via `expandTag` and used only if that
tag actually exists in git. It is not a "has this been published" check: it borrows a version string
to guess a tag name, for the case where a tag exists but isn't in HEAD's ancestry. With no plugin
registered, this step resolves nothing. (3) `catchUpFile`, if given and present, still widens the
result backwards either way.

**`from: 'auto'`, not `'npm'`.** The keyword named a *source*, and the wrong one - most of detection
is git, and the registry half is the ecosystem's now. A rename rather than an alias: `--from npm`
means a ref literally called `npm` and fails as one.

`GitHelper` is exported, so this is directly callable - though in practice it is reached through
`ChangelogService.getEntries`/`generateToFile`, which construct one.

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
const app = repository.app;
try {
  await app.getService('run').runScript('build');
} catch (e: any) {
  // e.message === '"build" failed'; e.logged === true
  process.exitCode = 1;
}
```

## Package filtering (`scope`/`ignore`/`deps`/`dependents`)

Every service above that takes `PackageFilterOptions` narrows its target package set the same way:

```ts
interface PackageFilterOptions {
  scope?: string | string[]; // only packages whose name matches this glob, or "/" for the root
  ignore?: string | string[]; // exclude packages matching this glob (or "/"), applied after `scope`
  deps?: boolean; // also include everything the matched set depends on
  dependents?: boolean; // also include everything that depends on the matched set
}
```

```ts
const app = repository.app;
// Everything under @myorg/, minus anything ending in -internal:
await app.getService('run').runScript('build', { scope: '@myorg/*', ignore: '*-internal' });

// A scoped package plus everything it needs to build first (dependency order handles the rest):
await app.getService('run').runScript('build', { scope: 'my-app', deps: true });

// Everything that could be affected by a scoped library's change - useful before a release:
await app.getService('run').runScript('test', { scope: 'core-lib', dependents: true });
```

`scope`/`ignore` accept [`micromatch`](https://github.com/micromatch/micromatch) glob syntax
(`*`, `**`, `{a,b}`, ...) matched against each package's bare name.

**`"/"` (`ROOT_SELECTOR`) is the repository's own root package, and it is not a glob** - the same
`/` `.rmanrc`'s `"[/]"` block uses, for the reason stated there: *the root is never selected by
name.* A glob is never offered the root, so `scope: '*'` means the members and `scope: '/'` means
the root; `ignore: '/'` is every package but the root. It is accepted everywhere `scope`/`ignore`
are, and selects nothing where the root is not a candidate to begin with - `repository.packages`
holds the workspace members only, so `run`, `list` and `exec` see no root, while `clean` and
`changelog` put it in their candidate list on purpose.

```ts
// The root package's own changelog entry (repo-wide commits), and nothing else:
await app.getService('changelog').getEntries({ scope: '/' });

// Clean every member but skip the root's own sweep:
await CleanService.clean(repository, { ignore: '/' });
```

`deps` and `dependents` each
independently expand the already-`scope`/`ignore`-matched set along the full transitive dependency
graph, and their results are **unioned** together (not compounded) - so passing both never
re-expands one direction's additions through the other, which would otherwise tend to explode
toward "the whole repository" on a well-connected graph.
