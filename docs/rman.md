<!--
docs-baseline
git-commit: 8430603
package-version: 2.14.0
date: 2026-10-06

Verified against `src/` (and `test/**/*.spec.ts` for usage examples) as of the commit above.
Before trusting/updating this file in a later session, run:

  git diff 8430603..HEAD -- packages/rman/src/

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

> **Not part of this API:** anything under `src/commands/*.command.ts` and `cli.ts`'s `runCli` -
> those are CLI-only (argv parsing, colored console output, confirmation prompts) and are not
> re-exported from the package's main entry point. If you need `runCli` itself (e.g. to embed the
> CLI in another tool), import it from `rman/cli.js` explicitly.

## Table of contents

- [Installation](#installation)
- [Core concepts](#core-concepts)
  - [`RmanApplication`](#rmanapplication)
  - [`Platform` and `Plugin`](#platform-and-plugin)
  - [`Workspace`: finding the packages](#workspace-finding-the-packages)
  - [Declaring a command](#declaring-a-command)
  - [`Repository`](#repository)
  - [`Package`](#package)
- [Configuration (`.rmanrc` / `.rmanrc.yml`)](#configuration-rmanrc--rmanrcyml)
  - [JS config (`.rmanrc.cjs` / `.rmanrc.mjs` / `.rmanrc.js`)](#js-config-rmanrccjs--rmanrcmjs--rmanrcjs)
  - [Scoped `vars`](#scoped-vars)
  - [Reading a file (`read`)](#reading-a-file-read)
  - [Function steps](#function-steps)
  - [Step objects](#step-objects)
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
  - [`ProgressPanel`](#progresspanel)
  - [`Logger` / `LogLevel` / `resolveRootLogLevel`](#logger--loglevel--resolverootloglevel)
- [The `node` built-in](#the-node-built-in)
  - [What it contributes](#what-it-contributes)
  - [`"workspace:"` ranges](#workspace-ranges)
- [The `logged` error convention](#the-logged-error-convention)
- [Package filtering (`scope`/`ignore`/`platform`/`deps`/`dependents`)](#package-filtering-scopeignoreplatformdepsdependents)

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
  definePlatform,
  definePlugin,
  declareCommand,
  basePlatform,
  targetsOf,
  shipsTo,
  skipReasonFor,
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
  mergeConfig,
  runOptions,
  readRunOptions,
  parallelOptions,
  readParallelOptions,
  DependencyUpdater,
  ProgressPanel,
  isCalendarVersion,
  Logger,
  LOG_LEVELS,
  resolveRootLogLevel,
} from 'rman';
import type {
  RmanConfig,
  ResolvedConfig,
  ConfigValue,
  ConfigValueContext,
  ConfigScope,
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

**Everything npm-specific is the `node` built-in's** - `PublishService`, `CiService`,
`CleanService`, the `package.json` manifest reader, the version planner, the dependency updater,
`node_modules/.bin` on PATH, and the `ci`/`clean` commands. It ships inside rman and is laid under
every repository by default - see [The `node` built-in](#the-node-built-in). The core documented
here knows nothing about npm: with `presets: []` there is no manifest reader at all, so a polyglot
or non-Node repository declares its own through the same seams the built-in uses. `info` is a
**core** command whose npm half the built-in augments in place.

## Core concepts

### `RmanApplication`

**One rman invocation, and everything it holds.** Created before anything else, handed to every
plugin, and the owner of every registry and service. Nothing is process-global: an application
starts empty and is thrown away whole, so two repositories in one process share nothing.

```ts
class RmanApplication {
  constructor(options?: { logLevel?: LogLevel });

  readonly platforms: Registry<Platform>;         // the technologies this run knows about
  readonly plugins: Registry<Plugin>;              // who contributed them - see Platform and Plugin
  readonly publishTargets: Registry<PublishTarget>; // where a package's artifact can ship
  readonly logger: Logger;
  versionPlanner?: VersionPlanService;            // the plan orchestrator - see VersionPlanService

  get repository(): Repository;                   // throws before one is attached
  platformFor(dir: string): Platform;             // the first platform whose manifest reader claims it

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
  `size`, `first(ask)` for "the first that recognizes this", and it is iterable. A registry is for a
  question whose answer is the *sum* of what was contributed; a question with exactly one answer is
  a service instead.

### `Platform` and `Plugin`

**A platform is one technology, whole; a plugin is whatever a package contributes.** What a package
*is*, where packages are, where its scripts come from, which directories hold its binaries and how
its releases are planned are answers that only make sense together - so they are one type, and
`manifestProvider` is what makes it a platform at all.

```ts
interface Platform {
  name: string;                        // what Package.provider reports
  manifestProvider: ManifestProvider;  // required - everything below is optional
  getWorkspace?: Workspace.Provider;
  getBinPaths?: BinPath.Provider;
  getRunSteps?: RunService.StepSource;
  versionPlanner?: VersionPlanService;
  dependencyUpdater?: DependencyUpdater; // what `rman deps` asks
}

interface Plugin {
  name: string;
  afterInitApplication?(ctx: { app: RmanApplication }): void | Promise<void>;
  afterInitRepository?(ctx: { app: RmanApplication; repository: Repository }): void | Promise<void>;
}
```

**`Platform` and `Plugin` are two unrelated things, not a narrow type and a broad one.** A platform
is **one technology** - `manifestProvider` is what makes it one - and it reaches a repository
through the `platforms` config key, the same route `commands` and `publishTargets` already take. A
plugin is a name and whatever it wants to do at a stage.

```ts
import { definePlatform, definePlugin } from 'rman';

// a technology: contributed through `platforms`, and this is almost every entry
const cargo = definePlatform({ name: 'cargo', manifestProvider: cargoManifest });

// a plugin: a name, and something to do once the core has finished a stage
const audit = definePlugin({
  name: 'audit',
  afterInitRepository({ repository }) { /* every package is known here */ },
});
```

- **`Plugin.platforms` is gone**, and nothing produced one: no built-in shipped a technology through
  a plugin, and the field's only two readers were plumbing. A technology is a `platforms` config
  key now. `init` went with it - every occurrence in the tree was a test fixture.
- **Two stages, named for *when* they run.** `afterInitApplication` runs inside `Repository.create`,
  before any package is known, so `ctx.app.repository` throws there; `afterInitRepository` is the
  one to use for anything that needs the packages. Deliberately not a hook bus: every later point a
  plugin might want already has a mechanism it would compete with (`run.<script>.before`/`.after`,
  `version.<slot>`, `publishTargets`), and a second way in means a precedence rule nothing can make
  obvious.
- **Both must be declared through their factory**, and the mark says *which*: one non-enumerable
  `Symbol.for('rman.declared')` whose value is `'platform' | 'plugin'`. No structural check could
  replace it - an rman **1.x plugin was `{ name, init }`**, and a 2.x plugin doing nothing but
  `afterInitApplication` is a plain object too. The kind is what lets a refusal state a fact: a
  platform found in `plugins` is told which key it belongs in, and the mirror holds for `platforms`.
- **Everything optional is answered by its absence**, never by a default rman invented. The core
  ships `basePlatform`, whose reader recognizes nothing: a directory no technology claimed falls
  back to it and gets a package named after its directory at `0.0.0`. No `getWorkspace` means no
  packages below it; no `versionPlanner` means `version` fails naming the key rather than releasing
  a plausible but untrue set; no `dependencyUpdater` means `deps` leaves that technology's packages
  alone.
- **`getRunSteps`, not `onBuildRunSteps`**: it is a *query*, and not build-specific - `version`
  reads the same seam for `preversion`/`version`/`postversion`.
- **A stage is the escape hatch, not the front door.** Commands, platforms and publish targets are
  all `.rmanrc` keys, so a package contributing those needs no plugin at all. `afterInitRepository`
  exists for what the keys cannot express - a plugin that contributes no command and still wants the
  packages - which is exactly the case the old advice ("put it in a command's factory") had no
  answer for.
- `declaredKind(value)` says which of the two a value is, and `isPlatform(value)` reads that mark
  rather than testing for `manifestProvider`. The structural test was the only one available while
  one type was both halves; as a question about an arbitrary import it gets the common mistake
  backwards.

**Which platform claims a directory** is `RmanApplication.platformFor(dir)` - the first registered
platform whose manifest provider recognizes it, `basePlatform` when none does. A package is handed
its platform when it is constructed, by the walk that found it (see
[`Workspace`](#workspace-finding-the-packages)), so nothing re-derives the answer later.

**`dependencyUpdater` is the `deps` seam** - how a technology checks its dependencies against a
registry and moves them. The command owns the filters, the plan table and the confirm; the
technology owns every answer:

```ts
interface DependencyUpdater {
  getPlan(ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<DependencyUpdater.Entry[]>;
  applyPlan(ctx: DependencyUpdater.Context, plan: readonly DependencyUpdater.Entry[]): Promise<DependencyUpdater.Applied>;
  verify?(ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<string | undefined>;
}

namespace DependencyUpdater {
  interface Context { app: RmanApplication; repository: Repository; options: Options }
  interface Options {
    names?: string[]; target?: string; reject?: string[]; minAge?: number; // this run's flags
    concurrency: number;
    onProgress?(done: number, total: number): void;
  }
  interface Entry {
    package: Package;
    name: string;
    types: string[];   // the fields that declare it, in the ecosystem's words
    current: string;
    status: 'update' | 'held' | 'skipped' | 'up-to-date' | 'error';
    target?: string; latest?: string; available?: string; bump?: string; reason?: string;
  }
  interface Applied { files: string[]; restore(): void } // restore() undoes the write when verify fails

  function settingsFor(pkg: Package, options: Options): Settings;   // deps.* resolved, flags applied
  function targetFor(settings: Settings, name: string): { size: string; from: string };
  function defaultTarget(bumps: readonly string[]): string;         // every size but the largest
}
```

- **`settingsFor` is how a technology reads `deps.*`**, so every updater agrees about what the keys
  mean: `--target` replaces `deps.target` *and* drops `deps.targets` for the run, `--reject` adds to
  `deps.reject`, and a target the package's version scheme does not name is an error. `targetFor`
  names which key decided, for the `reason` a held entry carries.
- **`verify` answers whether the written result still installs**, as an error text or `undefined`;
  `deps --upgrade` calls `restore()` when it does not. Optional - a technology without a resolver
  to ask leaves it out.

**A published plugin is not usually named in `plugins` at all.** Its package exports a config
carrying it, and the repository writes `extends`:

```ts
// the package's entry point
export default defineConfig({
  platforms: [cargoPlatform],
  commands: [buildCommand],
  publishTargets: [new CratesPublishTarget()],
});
```

```yaml
# the repository
extends: 'rman-cargo'
```

**The `node` platform ships inside rman**, so a Node repository names no package at all - see
[The `node` built-in](#the-node-built-in).

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
- **The handler gets a [`CommandContext`](cli/custom-commands.md) as its second argument** -
  `handler(args, context)`, with this run's `runBin` and `logger` and the scheduler's
  `forEachPackage` and `parallel` (see [`RunService`](#runservice)). Optional, so a handler taking
  `args` alone still fits, and the opposite order to `defineCommand`'s `(context, args)` for that
  reason: appending a parameter broke no declared command, prepending one would have broken all.
- **`printsDocument: true` when stdout *is* the answer.** Every other command gets a live status
  line on stderr naming it, and a result line with the elapsed time; a command printing a document
  (`config`, `list`, `changelog`) declares this so nothing is written around it. A command whose
  `config` holds a `json` option is treated as owning `--json` - the global run-log `--json` leaves
  its stdout alone.
- **`shadowable: true` lets a contributed command take the name.** Only `build` and `test` carry
  it - both are `run <script>` under a shorter name - so a preset's own `test` (one run at the
  repository root, say) replaces rman's alias instead of throwing. A shadowed built-in is not
  registered at all; the override is reported at `--log-level verbose`. Every other built-in name
  still refuses.

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

  static create(
    root?: string,
    options?: { deep?: number; app?: RmanApplication; presets?: readonly string[] },
  ): Promise<Repository>;

  get currentPackage(): Package | undefined;
  get dependencyCycles(): readonly (readonly string[])[];
  getPackages(options?: { scope?: string | string[]; toposort?: boolean }): Package[];
  getPackage(name: string): Package | undefined;
  listStatus(options?: { hash?: string }): Promise<Record<string, Repository.PackageStatus>>;
}

namespace Repository {
  type PackageStatus = 'dirty' | 'committed' | 'changed' | 'clean';
}
```

**`Repository.create(root?, options?)`** walks up from `root` (default `process.cwd()`), up to
`options.deep` (default `10`) levels, stopping at the first directory holding a `.git`. The root is
then, in order: the **outermost** directory in that chain holding an `.rmanrc*`; failing that the
`.git` directory itself; failing that `root`.

**Outermost, not nearest**, because a *package* may have an `.rmanrc` of its own - which is a
supported thing - so from inside one the nearest is the package's and not the repository's. What
that costs, since only one answer can win: a self-contained project nested inside a larger git
repository *and sharing its `.git`* resolves to the outer root (measured). A nested project with a
`.git` of its own is found correctly, because the walk stops there before the outer `.rmanrc` is
seen.

**This question is answered without knowing anything about any ecosystem**, and it has to be: the
plugins that would know are named in the config file the walk is looking for. So a `package.json`
with a `workspaces` array means **nothing** here - a repository is marked by an `.rmanrc*` or a
`.git`, and `package.json#rman` is deliberately not one of the forms, since it would make the root
question npm-shaped again. Which directories then hold packages is the technology's answer, through
[`Workspace`](#workspace-finding-the-packages).

- **`options.app`** hands over an [`RmanApplication`](#rmanapplication) instead of building one -
  how a caller sets the log level before anything reads config, or registers its own technologies.
- **`options.presets`** replaces the default preset list rman lays under the root (`['node']`).
  `presets: []` is the opt-out for a caller bringing an ecosystem of its own, and the core's own
  test fixture passes it.

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
themselves to "just the package I'm standing in" unless a `fromRoot: true` option overrides it:

```ts
const repository = await Repository.create('/repo/packages/pkg-a');
repository.currentPackage?.name; // 'pkg-a'
```

**`repository.getPackages(options?)`** returns the resolved package list, optionally narrowed by
exact name (`scope`) and/or topologically sorted (`toposort: true` - dependencies before
dependents, keeping the given order among packages that do not constrain each other). This is a
lower-level primitive than the glob-based
[`filterPackages`](#package-filtering-scopeignoreplatformdepsdependents) most services use internally.

`toposort: true` **throws** when the selected packages cannot be ordered, naming the cycle:

```
Dependency cycle: @opra/cli -> @opra/api-ui -> @opra/cli
```

Only the edges inside the selection count, so a `scope` that leaves a cycle out is still ordered.

**`repository.dependencyCycles`** is that same answer without the throw - every cycle in the
declared graph as a path of names returning to its start, and `[]` for a graph that can be ordered.
A cycle is not an error in itself: `list`, `info` and `config` need no order and keep working, which
is what lets you find it. It becomes one in `run`/`build`, `exec`, `publish` and `list --toposort`.

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
  config: ResolvedConfig; // its own effective, cascaded .rmanrc - value functions already called
  rawConfig: RmanConfig; // the same config before interpolation - every ${{ }} still as written
  repository: Repository; // the repository it belongs to - non-enumerable; a repository's own is itself
  children: Package[]; // the packages directly inside this one - the tree edge
  parent?: Package; // the one containing it - non-enumerable; undefined for the root
  platform: Platform; // the technology whose manifest provider claimed this directory
  selector: string; // what "[glob]" and --scope match it by
  versionScheme: VersionScheme; // how its versions are numbered (semver by default)

  get basename(): string; // path.basename(dirname)
  get name(): string; // from the manifest
  get version(): string; // from the manifest
  get isPrivate(): boolean; // !!manifest.private
  get provider(): string; // which ecosystem read it - 'node', ''; see Platform
  get isRoot(): boolean; // whether this is the repository's own root package

  platformSelector(): string; // what its platform says addresses it, before any config is consulted
  reloadManifest(): Manifest; // re-reads from disk through its own technology's provider
  writeManifest(): void; // writes the manifest back to its own file
}
```

**`config` and `rawConfig` are two fields rather than two stages of one**, because they have
different *types*: `config` is a `ResolvedConfig` by contract and is read everywhere, so holding an
uninterpolated config there for the window between the cascade and the bake would make the type say
something untrue at every reader. `Workspace` produces `rawConfig` when it cascades the directory
chain, `Repository` evaluates it into `config`. Read `config` unless you specifically want the
unevaluated text.

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
[package filtering](#package-filtering-scopeignoreplatformdepsdependents)) and what distinguishes the
repo-wide reading of a config key from a package's own.

**`children` / `parent` are one edge with two directions, and only one is walkable.**
`children` is an ordinary field; `parent` and `repository` are **non-enumerable**, so a tree
serialized from the root goes downwards and does not cycle. Both are still readable - non-enumerable
is not private. They come from the walk that found the packages rather than from comparing path
prefixes afterwards, which is what makes a package nested inside another expressible at all.

```ts
const tree = JSON.stringify(repository.rootPackage.children); // no cycle
for (const child of repository.getPackage('pkg-a')!.children) console.log(child.selector);
```

**`selector` is what addresses a package; `name` is what it calls itself.** They coincide wherever
the technology names its packages - which is every Node repository - and they are not the same
question: a package having a name at all is an *ecosystem's* promise, not rman's. The selector comes
from the first of three that answers:

1. the package's own `.rmanrc "name"` - the repository assigning one;
2. its platform's `ManifestProvider.selector`;
3. the manifest's own name, which is what that seam falls back to.

So `"[glob]"` blocks and `--scope`/`--ignore` match `selector`, while tags, changelogs and the
registry read `name`. A selector must be **unique** within a repository, and a duplicate is an error
naming both directories - `"[that]"` and `--scope that` cannot mean two packages.

```ts
const pkgA = repository.getPackage('pkg-a')!;
pkgA.manifest.raw.description = 'Updated via script';
pkgA.writeManifest();
```

### `Workspace`: finding the packages

**Discovery descends, asking each directory its own technology where its children are.**

```ts
class Workspace {
  readonly rootDir: string;
  readonly rootPackage: Package;
  readonly packages: Package[];    // every package below the root, the tree flattened
  readonly platforms: Platform[];  // the technologies in play, in the order they were loaded
  readonly plugins: Plugin[];      // everything else a level contributed

  static create(rootDir: string, options: Workspace.Options): Promise<Workspace>;
  packageAt(dirname: string): Package | undefined;
}

namespace Workspace {
  interface Options {
    app: RmanApplication;
    plugins?: Plugin[];            // the application's, to start from
    platforms?: Platform[];
    presets?: readonly string[];   // rman's own, laid under the root level only; [] opts out
    deep?: number;
    reader?: ConfigReader;         // the test seam
  }

  type Provider = (dir: string) => string[] | undefined; // child package dirs, or "not mine"

  interface Node {
    dirname: string;
    platform: Platform;
    children: Node[];
  }

  function walk(app: RmanApplication, rootDir: string, options?: { deep?: number; declared?: DeclaredPlatform }): Promise<Node>;
  function flatten(node: Node): Node[]; // every node below it, depth-first, excluding itself
  function findRoot(from: string, deep?: number): string;
}
```

**`Workspace` is a class as well as a namespace**, and the class is what `Repository.create` uses:
it runs the walk, resolves every package's selector, checks those selectors are unique, and cascades
the directory chain into each `Package.rawConfig`. The namespace's `walk`/`flatten`/`findRoot` are
the pieces underneath, usable on their own.

**`presets` is passed to the root level only** - everything below inherits whatever the root settled
on, and laying them again at an intermediate directory would put a preset's technology ahead of one
that directory declared.

One step, applied recursively: take the directory's **declared** platform if its `.rmanrc` names one
and otherwise the first that recognizes it, ask **that** platform where its children are, and repeat
for each answer.

**A provider used to answer for the whole repository** - `(root) => { root, packageDirs }`, asked
once, at the top, by the first platform that recognized it. Two consequences followed, and both were
documented as limitations rather than fixed: a polyglot repository's package set was decided by
whichever technology was listed first in `plugins`, and a package nested inside another was only
recoverable afterwards by comparing path prefixes. Asked per directory, a platform only ever speaks
about its own packages - which is all a platform knows.

- **The root node always exists**, so this never returns `undefined`. A repository nobody recognizes
  is a root with no children, which is the single-package answer arrived at rather than guessed.
- **A directory is visited once.** Two globs may legitimately overlap, and a provider naming an
  ancestor would otherwise never terminate.
- `deep` bounds the descent for the same reason `findRoot` bounds its climb.
- `Repository.packages` is this tree flattened; `Package.children`/`parent` are its edges.

**`Workspace.Layout` and `Workspace.resolve` are gone** with the seam they belonged to.

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
"[*]":                                        # the packages - not a monorepo's root
  run:
    build:
      after: node ../../support/postbuild.cjs # run in each package's own directory
"[platform:node]":                            # the packages of a technology
  clean: { include: [build] }
"[*-dialect]":                                # a glob over package names
  publish: { skip: true }
"[pkg-a]":                                    # exactly one
  dependencies: [pkg-b]
```

Selector details:

- **Three audiences**, and what each is matched against:

  | | speaks for | matched against |
  | --- | --- | --- |
  | `"[/]"` | the **root package** alone, structurally | - |
  | `"[platform:node]"`, `"[platform:node,cargo]"` | every package of those **technologies**, the root included | `pkg.platform.name` |
  | `"[*]"`, `"[pkg-a]"`, `"[*-dialect]"` | the packages this directory holds that the glob matches | `pkg.selector` |

  `/` for the root because that is what a repository root is called everywhere else, and no package
  can be named it.

  **A monorepo's root is never selected by name, and only a glob is held off it.** A glob matches
  package names and a monorepo's root is nobody's child, so `"[my-*]"` cannot quietly reach a
  repository whose root package is called `my-repo`, and `"[*]"` cannot hand a package-shaped
  setting to a root with no build directory to apply it to. Neither reason touches
  `"[platform:node]"` - it is not a name and it is not a catch-all - so a platform block answers
  about the root like any other package, and `"[platform:node]" > "[/]"` is how you say *the root,
  when it is a node repository*.

  A package **no technology claimed** carries a platform whose name is `''`, so it matches no
  platform block at all rather than quietly falling into one.

  In a **single-package repository the root is the one package, so every selector reaches it** -
  `"[/]"` because it is the root, `"[*]"` and a matching name glob because it is a package. Both
  reasons for holding a glob off a root describe a *container*: a name shape shared with the things
  below, and a directory with no build output of its own. A root with nothing below it is neither.
  The two blocks are then layered in declaration order, like any two selectors that both match.

  This is what lets a shared config declare one package block. `@panates/rman-preset` puts
  `run.build`, `publish.npm.directory` and `version.stamp` under `"[platform:node]" > "[*]"`, and a
  single-package repository extending it gets them without restating a line.
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
- **A selector block may hold further selector blocks, and nesting is an AND.** A nested block
  applies where its own audience *and* every audience it sits inside all match - which is how you
  say "these packages, but only the ones that are also X" for a whole block:

  ```yaml
  "[platform:node]":
    group: node
    vars: { tier: base }

    "[pkg-*]":                   # node packages whose selector starts with pkg-
      group: node-and-pkg
      vars: { tier: narrowed }   # merges per key: `base` is replaced, the rest is kept
  ```

  Nest as deep as the question needs. The alternative for a single key is an `if:` expression, and
  it does not reach far enough on its own - `if` exists on run steps, not on `vars`, `clean.include`
  or `publish.npm.directory`, so a block is the only way to narrow more than one key at once.

  - **Nesting narrows the audience; it does not raise precedence.** A nested block is merged where
    its parent sits, depth-first in declaration order, so the layers for
    `"[platform:node]" { a, "[pkg-*]" { b } }` followed by `"[*]" { c }` are `a`, `b`, `c` - and `c`
    still wins. That is the same cost the missing specificity ranking has above, and for the same
    reason: two blocks that both match are siblings whatever depth they sit at, and the order they
    were written in is the one answer nobody has to invent.
  - **A selector under a *setting* is refused**, because a setting is not an audience and the block
    could never be applied:

    ```yaml
    "[*]":
      run:
        build:
          "[pkg-*]": { exec: tsc }   # refused - naming where it sits
    ```

  - **`"[platform:node]" > "[/]"` is the root, when the root is a node package.** A platform block
    asks `pkg.platform.name` and the root is a package with a platform, so a technology's whole
    shared config fits in one block - the `vars` beside the nested blocks reach the root and the
    packages alike:

    ```yaml
    "[platform:node]":
      vars: { coverage: coverage }
      "[/]": { clean: { include: "${{ [...value, vars.coverage] }}" } }
      "[*]": { publish: { npm: { directory: build } } }
    ```

    Only a **glob** is held off the root, and for two reasons that are both about names: `"[my-*]"`
    must not pick up a repository whose root package happens to be called `my-repo`, and a catch-all
    must not hand a package-shaped setting to a root with no build directory. Neither applies to
    `platform:node`.
  - **A nested pair that could never match together is refused**, rather than loading and matching
    nothing. Two are decidable and both are checked: `"[/]"` paired with a **glob**, either way round
    (a glob never matches a monorepo's root, so the pair is empty - the check is made per directory,
    before any package is known, so it cannot ask whether this repository has only one; in a
    single-package repository `"[/]"` alone already reaches everything, so nothing is lost by the
    refusal standing there too), and two `"[platform:...]"` blocks naming
    nothing in common (a package carries one platform). `"[platform:node,cargo]" > "[platform:node]"`
    narrows and is fine. A glob pair is deliberately *not* checked - whether two globs intersect is a
    real computation, where a platform set is a membership test.
  - **`platform` cannot sit in a nested `"[/]"`.** Which technology claims a directory is settled
    before any block is matched, so it is read from a level's own keys or a top-level `"[/]"` and
    nowhere deeper.
  - `vars` and the contribution keys (`plugins`, `commands`, `publishTargets`) are exempt from all of
    this - their contents are not config keys, so a bracketed name in either is data.

  Nesting was refused outright until 2.0.0-beta.4, on the reasoning that selectors do not intersect
  because specificity ranking was dropped. That conflated two questions: ranking answers which of
  two *siblings* wins, and nesting asks nothing of the sort. What the refusal got right, and what
  the checks above keep, is that the shape must never be silent - before it, the inner block reached
  every package the outer one did and sat in `rman config` output as a literal `'[pkg-*]'` key,
  looking as though it had worked.
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

A module base may be ESM or CommonJS - `.mjs`, `.cjs`, or a `.js` read as whichever its nearest
`package.json` says. (Through 2.0.0-beta.2 a CommonJS base came back as an empty object under an
ESM loader hook, and an empty object is a valid config, so it contributed nothing and said nothing.
Both paths share one loader now.)

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
measurement is why `ConfigInterpolator` builds its context from property descriptors rather than
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

**Assembling one config out of several objects: `mergeConfig`, not a spread.**

```ts
function mergeConfig(target: Record<string, any>, source: Record<string, any>, origin?: string): Record<string, any>;
```

It merges `source` onto `target` exactly the way rman layers an `extends` base, a directory level
or a `"[selector]"` block, and returns `target`, mutated. A spread gets that wrong twice: it is
shallow, so two objects both declaring `changelog` keep only the later one; and a generic deep merge
*replaces* arrays, while `plugins`, `platforms`, `commands` and `publishTargets` always append - so
a preset's commands would vanish the day anything else declared one. `origin` is the file `source`
came from, recorded per key so a failing expression can name it; omit it for an object you built.

```js
// a shared preset composing a platform-neutral part and a Node one
import { mergeConfig } from 'rman';
import base from './base.js';
import node from './node.js';

export default mergeConfig(mergeConfig({}, base), node);
```

Try `extends: ['./base.js', './node.js']` first where it fits - it costs no API at all and keeps the
origins exact. `mergeConfig` is for a module that has to hand back one finished object.

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

### Step objects

A step may also be written as an object, which is how it says something **about itself** rather than
about what it does. One such thing exists today: where the package starts waiting for its
dependencies.

```yaml
"[*]":
  run:
    build:
      before:
        - { topo: false, command: eslint . }   # nothing to wait for
      exec: { topo: true, command: tsc -b }    # cannot start before the dependencies are built
```

| | |
| --- | --- |
| `command` | the step itself - a shell command **or a function**, exactly as the plain value form. `${{ }}` in a string is interpolated as usual |
| `topo` | whether this step waits for every package this one depends on to finish |

One key for the step, because `run.<script>.exec` is already one key taking both forms - a second
name for the function case would be two spellings of one thing plus a rule about which to use.
**An unknown key is refused**: `script` names the *lifecycle* (`run.<script>`), not the step, and a
plausible-looking step that silently ran nothing while the run reported success is what that
refusal prevents.

`run.<script>.topo` says whether a package waits at all; a step's `topo` says **where**. The rules,
and their costs:

- **The wait is for each dependency's whole script**, not for the same step in it - wider than
  strictly needed, and chosen over the alternative, which requires two packages' step lists to line
  up and has no answer when they do not.
- **So the first `topo: true` is where the package actually blocks.** Everything after it has its
  dependencies behind it already, which makes a later `topo: false` a true statement about the step
  that changes nothing about when it runs - worth writing as intent, not a lever.
- **With no `true`, the wait is before the first unmarked step.** An unmarked step takes
  `run.<script>.topo`, on by default; a `false` frees its own step and nothing else. So a script
  where no step mentions `topo` waits before its first step, as it always has, and one waits
  nowhere only when **every** step says `false`.
- **A package's own script keeps the mark of the `exec` it replaces.** A `package.json` `build`
  cannot say `topo`, so it inherits the configured `exec: { topo: true, ... }` it takes the place
  of. `run.<script>.topo: false` and `--no-topo` still turn ordering off outright.
- **`run.<script>` only.** A `version` hook runs for one package around its own version write, with
  no package graph to wait on, and the key is refused there instead of quietly doing nothing.

The step-vs-value rule extends to the object: a function under `command`, at any depth inside a step
slot, is still a **step**. Measured on `@panates/rman-preset`, whose build hook is exactly that:
without the rule, every command in a repository extending it died with `Config function in
"run.build.after.command" ... failed`, the hook called with the config scope while the config was
merely being resolved.

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
    changelog: { filePath: ({ vars }) => `${vars.buildDir}/NOTES.md` },
    clean: { include: ({ vars }) => [vars.buildDir, '*.tsbuildinfo'] },
  },
};
```

A layer *below* is what `value` reads, so deriving from one takes two files - a shared config and
the repository that `extends` it, or a directory above and one below. Not two blocks in one object:
`'[*]'` twice in a single literal is one key written twice, and JavaScript keeps the last.

```js
// the repository's own .rmanrc.mjs, extending the config above
export default {
  extends: '@acme/rman-config',
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

#### Two views of one config

A function is valid where an author writes a config and impossible where code reads one, because by
then rman has already called it. So there are two types, and only one of them is written by hand:

| | |
| --- | --- |
| `RmanConfig` | what an **author** writes - `defineConfig`, `/** @type {import('rman').RmanConfig} */`. A value may be a function here. |
| `ResolvedConfig` | what `pkg.config` is - **derived** from `RmanConfig` by `Resolved<T>`, with every value function replaced by what it returns. |

A command reading `pkg.config.changelog?.filePath` gets a `string`, with no cast and no
`typeof === 'function'` check; a config writing that same key may hand over a function. Nothing has
to be declared twice - the reader's view is computed.

**A step is not a value, and the types keep them apart.** `run.<script>.before`/`.exec`/`.after`,
`run.<script>.if` and `version.<slot>` take a function that rman calls *later*, with a
`RunStepContext`; the derivation leaves those exactly as declared. So do `plugins`, `commands` and
`publishTargets`, which are code all the way down. Which keys accept a value function is decided by
the key, the same rule the runtime applies.

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
(`interpolate({ config: value, scope, at: ['version', slot] })`), or the path matches nothing and a
step there is mistaken for a value.

### Config keys reference

| Key | Type | Default | Scope / notes |
| --- | --- | --- | --- |
| `plugins` | a plugin, or a glob naming modules that export one | none | Root-level only - it is read before any package exists. Always **appends** across layers. A *name* is never accepted, built-in or package: it is refused, naming `extends` as the fix. |
| `platforms` | a platform, or a glob naming modules that export one | none | The key a **technology** arrives through, the same shape `plugins` takes and appending the same way. Read at any level, not only the root. |
| `commands` | a command, or a glob naming modules that export one | `['.rman/*.mjs', ...]` | Always appends. A *relative glob* is anchored to the file that declared it. Declaring a glob anywhere replaces the `.rman/` default, so a config meant to be inherited lists its commands individually. |
| `publishTargets` | a publish target | none | Always appends. Where a package's artifact can ship - see [`PublishTarget`](#publishtarget). |
| `platform` | `string` | the first loaded platform that recognizes the directory | Per-directory cascaded. Which technology claims this directory, by `Platform.name`. **It loads nothing** - a name no loaded technology provides is an error naming the file, and the fix is `platforms` or `extends`. A declaration is held to the directory: a platform that does not recognize it is an error naming the file it looked for. Never an expression; refused inside a `"[glob]"` block and inside a nested `"[/]"`. |
| `name` | `string` | the platform's answer, else the manifest's name | Per-package cascaded. The selector this package answers to - what `"[glob]"` and `--scope` match. Does **not** rename the package: `pkg.name` stays what the manifest says. Must be unique; refused inside a `"[glob]"` block. |
| `packageManager` | `'npm'\|'yarn'\|'pnpm'\|'bun'` | `'npm'` | Root-level only. Used by `ci`/`publish`. CLI flag wins when given. |
| `logLevel` | `'silent'\|'error'\|'info'\|'verbose'` | `'info'` | Root-level only. Invalid values fall back to `'info'`. CLI `--log-level` wins when given. |
| `allowBranch` | `string \| string[]` | none (no restriction) | Root-level only. A CLI `--allow-branch` **replaces** it entirely (never merges). |
| `ignoreBranch` | `string \| string[]` | none (no restriction) | Same as `allowBranch`. |
| `group` | `true \| false \| string` | `true` | Per-package cascaded. See [`VersionService`](#grouping-rmanrc-group) below. A **named** group is at most 15 characters of letters, digits, `.`, `-` and `_`, starting with a letter or digit - it is written into a file name under `changelog.groupBy: 'group'`, so anything else is refused where it is read. |
| `version.commitMessage` | `string` | `"chore(release): v{version}"` | Root-level only. `{version}` substituted when a commit's group shares one version. |
| `version.changelog` | `boolean` | `false` | Root-level only. Default for `version --changelog` when the CLI flag isn't given - `--no-changelog` still overrides it off for one run. |
| `version.releaseTagPattern` | `string` (glob) | `'release-*'` | Root-level only. Names the **repository's** release, as opposed to the per-package/group tags `changelog.tagPattern` names - created only when the root is on a calendar version. Must not match any package's own pattern. |
| `version.cascade` | `'changed' \| 'dependents' \| 'group'` | none (the technology's answer) | Per-package cascaded; a group whose members disagree takes the widest. The narrowest this repository will release a group - a **floor, never a ceiling** under the platform's own [`cascade`](#versionplanservice). `group` keeps a group in lockstep on every bump; under npm, `dependents` equals the default and `changed` is a no-op. Never consulted by an explicit `rman version <v>`. |
| `version.stampDockerfile` | `boolean` | `true` | Per-package cascaded. Rewrite this package's Dockerfile `org.opencontainers.image.version` label to the version being written, in the same commit as the bump. Only ever rewrites a label already declared; reads `publish.docker.dockerfile`. |
| `version.stamp` | `string \| {file, constant?, optional?} \| (…)[]` | none | Per-package cascaded. Source files (relative to the package's own directory) whose `version` constant is rewritten to the version being written, in the same commit. `constant` names the identifier when it is not spelled `version`. A listed file a package doesn't **have** is a silent no-op; one that exists and holds nothing rewritable is an **error**, raised before anything is written - that is what catches a typo'd path or a renamed identifier before it ships a stale constant on every release. `optional: true` waives that refusal, for a **shared preset** naming one path for every package of a technology, which is saying "stamp it where there is one" and cannot know which repositories keep a constant there. |
| `version.before` / `.exec` / `.after` | `RunStepValue \| RunStepValue[]` | none | Per-package cascaded. Hooks around a version bump's write. **The same composition rule `run` uses** - npm's `preversion`/`postversion` run *inside* the config's `before`/`after` rather than replacing them, and only `version` (the `exec` slot) is replaced by the package's own. Left **unevaluated** at load (`DEFERRED_PATHS`), which is what lets `${{ pkg.targetVersion }}` bind here and nowhere else. A `RunStepValue` is a shell command **or a function** - see [Function steps](#function-steps). A step object's `topo` is refused here: a version hook runs for one package and has no dependency order to join. |
| `changelog.titles` | `Record<string, string>` | one heading per **standard** Conventional Commits type, in this order: `feat` ✨ Features, `fix` 🐛 Bug Fixes, `perf` ⚡ Performance and Optimizations, `revert` ⏪ Reverts, `refactor` 🔧 Refactoring, `docs` 📚 Documentation, `test` 🧪 Tests, `build` 📦 Build System, `ci` 🤖 Continuous Integration, `chore` 🧹 Chores, `style` 🎨 Code Style, `*` 💬 General Changes | Per-package cascaded. The heading each commit type is listed under, and the order the sections come out in. **Merged over the defaults per key**, so naming one type does not cost you the others. A type rman does not ship a heading for - `dev`, `bench` - falls in the catch-all until you give it one. `'*'` is the catch-all and always renders last. Two types sharing a heading share one section. These add sections and hide nothing: `ignoreTypes` is what drops a type. |
| `changelog.sortTitles` | `string[]` (commit types) | none | Per-package cascaded. The order the sections come out in. A sort, not a filter: an unlisted type keeps its place after the listed ones, a listed type with no heading of its own sorts nothing, and `'*'` is always last. |
| `changelog.ignoreTypes` | `string[]` | `[]` | Per-package cascaded. Conventional Commit `type`s dropped entirely from changelog output. |
| `changelog.template` | `string` (a file **path**, relative to repo root) | built-in template | Per-package cascaded. Throws if the path doesn't exist. |
| `changelog.commitHash` | `boolean` | `true` | Per-package cascaded. Whether each bullet ends with its commit's short sha. GitHub autolinks a bare abbreviated sha wherever it renders Markdown inside the repository, so it is a link on the page and stays readable in a terminal; turn it off for notes read elsewhere. A message repeated inside one section is written once either way, keeping the earliest commit's sha. |
| `changelog.unreleased` | `boolean` | `true` | Per-package cascaded. Whether the not-yet-released commits get an entry of their own. `false` gives a changelog of released history alone - but a release named through `--release-version` is still documented, so `version --changelog` keeps working. |
| `changelog.startingAt` | `string` (a version/tag, a `YYYY-MM-DD` date, or a commit) | none | Per-package cascaded. Where this package's changelog begins - releases older than it are left out, inclusive of the one named. The unreleased entry is never dropped by it. A value matching none of the three forms is an error. |
| `changelog.progress` | `boolean` | `true` | **Read off the repository root only.** Whether `rman changelog` draws a live progress panel. Auto-disabled when stderr is not a TTY; drawn on stderr so redirecting the notes to a file does not capture it. |
| `changelog.groupBy` | `'package' \| 'group'` | `'package'` | **Read off the repository root only** - it is one layout for the whole repository. `'package'` gives every package its own changelog. `'group'` gives one to each set of packages that releases together (`group`), written at the repository root: `CHANGELOG.md` for the default group, `CHANGELOG-<name>.md` for a named one. A `group: false` package is a group of itself either way, so its file stays its own. |
| `changelog.groupFiles` | `Record<string, string>` | none | **Read off the repository root only.** Under `groupBy: 'group'`, where each **named** group's changelog is written, relative to the repository root - `{ core: 'packages/core/CHANGELOG.md' }`. An unlisted group keeps `CHANGELOG-<name>.md`; the default group's file is `changelog.filePath`. A key naming no group, a path outside the repository and two groups resolving to one file are refused before anything is written. `--file-path` overrides it for a run. Move an existing file with `git mv`, or its `documented-up-to` marker is lost and the next `--write` reads the whole history. |
| `changelog.filePath` | `string` | `'CHANGELOG.md'` | Per-package cascaded, relative to that package's own directory. CLI `--file-path` wins when given. |
| `changelog.tagPattern` | `string` (glob, may contain `{name}`) | **derived** - `'v*'` with one version line, `'{name}@*'` with several | Per-package cascaded. `{name}` → independent per-package tags (`{name}@*`); no `{name}` → one shared repo-wide tag scheme. See below. |
| `clean.include` / `.exclude` | `string \| string[]` | `[]` | Per-package cascaded, resolved relative to that package's own directory. |
| `clean.skip` | `boolean` | `false` | Per-package cascaded - opts a package out of `clean` entirely. |
| `publish.target` | `string` or an array of them | whichever installed targets *claim* the package | Per-package cascaded. Which **registry** `publish` ships this package to - a name from the installed [publish targets](#publishtarget), never a fixed list. Each has its own "already published?" check: npm via `npm view`, docker via `docker manifest inspect`. A name nothing implements is an error naming the ones this repository has. The repository's GitHub Release is not a target here - see `githubRelease`. |
| `publish.npm.directory` | `string` | none (the package's own directory) | Per-package cascaded. Where the publishable output lives, relative to the package's own directory. A package's own `publishConfig.directory` wins over it; `--contents` is the last fallback. Publishing from such a directory means **`publish` generates the manifest there**, and decides `private` from that manifest - see [`rman publish`](cli/publish.md#publishing-from-a-build-directory-publishnpmdirectory). |
| `publish.npm.staged` | `boolean` | `false` | Per-package cascaded. Run `npm stage publish` instead of `npm publish`, so the version waits in npm's staging queue until a maintainer runs `npm stage approve` with 2FA. `--staged`/`--no-staged` overrule it for one run. Needs npm ≥ 11.15.0 and Node ≥ 22.14.0 on whatever publishes. See [`rman publish`](cli/publish.md#staged-publishing). |
| `publish.docker.image` | `string` | none (required once `"docker"` is a target) | A bare name is prefixed with `--docker-namespace`/`DOCKERHUB_NAMESPACE`; one already containing `/` is used verbatim. |
| `publish.docker.dockerfile` | `string` | `'Dockerfile'` | Relative to the package's own directory. |
| `publish.docker.architectures` | `string[]` | `['linux/amd64']` | `docker buildx build --platform` targets. |
| `publish.docker.cwd` | `string` | that package's own directory | Relative to the repository root. |
| `publish.docker.buildContexts` | `Record<string, string>` | `{}` | Named `--build-context <name>=<path>` entries, each path relative to the package's own directory. |
| `publish.docker.buildArgs` | `Record<string, string>` | `{}` | `--build-arg <name>=<value>` entries. A value of exactly `"$NAME"` expands from `process.env.NAME`. |
| `publish.docker.readme` | `string` | `'DOCKER_README.md'` | Relative to the package's own directory - becomes the DockerHub repo's description, if present. |
| `deps.target` | a bump name of the package's version scheme | every size but the largest (`minor` under semver) | Per-package cascaded. The largest move [`deps`](cli/deps.md) may make to a dependency. `--target` overrides it - and every `deps.targets` entry - for a run. A name the scheme does not have is an error naming the ones it does. |
| `deps.targets` | `Record<string, string>` (glob → bump name) | `{}` | Per-package cascaded. The largest move for the dependencies a glob matches, ahead of `deps.target` - `{ "@types/node": "major" }`. The last glob matching a name wins. |
| `deps.reject` | `string \| string[]` (globs) | `[]` | Per-package cascaded. Dependencies left alone. `--reject` **adds** to it rather than replacing it. |
| `deps.minAge` | `number` (days) | `0` | Per-package cascaded. Only move to a version published at least this many days ago. `--min-age` overrides it. |
| `deps.types` | `string[]` | every kind | Per-package cascaded. The dependency kinds to look at, in the ecosystem's own words - for npm `prod`/`dev`/`optional`/`peer` or the field names themselves. |
| `githubRelease.assets` | `string[]` | `[]` | Per-package cascaded. Globs (relative to the package's own directory) uploaded onto the one release. A release with no assets is still valid. |
| `githubRelease.repository` | `string` | parsed from the `origin` remote | Root-level only. `owner/repo` the release is created in. |
| `githubRelease.draft` | `boolean` | `false` | Root-level only. Create the release as an unpublished draft. |
| `githubRelease.prerelease` | `boolean` | whether the version is a semver prerelease | Root-level only. Mark the release as a prerelease. |
| `publish.skip` | `boolean` | `false` | Per-package cascaded - excludes this package from `publish` entirely (every target), regardless of `target`/`"private"`. `changelog` also skips it by default (its own `--include-skipped` overrides). `version` never consults this. |
| `run.<script>.concurrency` | `number` | CPU count | **Read off the repository root only** - one scheduler, one answer. `--parallel` wins when given. See [`RunService`](#runservice) below. |
| `run.<script>.topo` | `boolean` | `true` | Read both ways, meaning different things: the **root's** picks the sort (topological or alphabetical) for the whole list, a **package's** own decides whether *it* waits for its dependencies. `--topo`/`--no-topo` wins at both. **Which step it waits at** is a step's own `topo` - see [Step objects](#step-objects). |
| `run.<script>.bail` | `boolean` | `true` | **Unusual precedence:** package config > CLI flag > fallback (see below). |
| `run.<script>.progress` | `boolean` | `true` | **Read off the repository root only** - the panel is one shared instance per run. `--progress`/`--no-progress` wins when given. |
| `run.<script>.logLevel` | `LogLevel` | root's resolved log level | Per-package cascaded. |
| `run.<script>.changedSince` | `string` | none | **Read off the repository root only**, used only when CLI `--changed-since` isn't given. |
| `run.<script>.skip` | `boolean` | `false` | Per-package cascaded - opts a package out of running this script entirely. |
| `run.<script>.if` | `string` (small expression grammar) \| `RunConditionFn` | none (always runs) | Per-package cascaded. See [`RunService`'s conditional execution](#conditional-execution-if) and [Function steps](#function-steps). |
| `run.<script>.before` / `.exec` / `.after` | `RunStepValue \| RunStepValue[]` | none | Per-package cascaded. **`before`/`after` compose with the package's own `pre<script>`/`post<script>`; only `exec` replaces** - the config brackets the package's own, `config.before -> prebuild -> build -> postbuild -> config.after`. A `RunStepValue` is a shell command, **a function** ([Function steps](#function-steps)), or **an object** ([Step objects](#step-objects)); a list may mix them. A bare value in place of the whole `run.<script>` object is shorthand for `exec` - a string, a function or a list, never a single step object, which at that position is the options block. |
| `run.<script>.changed` | `boolean` | `false` | **Read off the repository root only**, used only when CLI `--changed` isn't given. |
| `run.<script>.override` | `boolean` | `false` | Per-package cascaded - when `true`, the config's script replaces the package's own definition even when it has one. |
| `extends` | `string \| string[]` | none | Root of each file only. Configs to inherit from - see [above](#inheriting-a-shared-config-extends). |
| `dependencies` | `string[]` | none | Extra in-repo edges not present in the package's real manifest, purely for rman's own dependency graph (topo-sort, `--deps`/`--dependents`, `run`'s scheduling). Each entry is a **package name or a repository-relative directory**, tried in that order - the path form is what makes the key usable outside npm. Declared through a selector (`"[pkg-a]": { dependencies: [...] }`) or in the package's own `.rmanrc`. A `Record<string, string>` was also accepted once and the ranges went nowhere; the key states an **edge**, which needs two ends and nothing else. |
| `vars` | `Record<string, unknown>` | `{}` | Declared at **any level** of the config and scoping its own subtree - `run.vars` covers every script, `run.build.vars` covers one. Merged per key over what the level above resolved to, and read as `${{ vars.x }}`. |
| `skip` | `boolean` | `false` | Per-package cascaded. "Leave this package alone", honoured by every command that *acts* - `run`/`build`/`test`, `exec`, `clean`, `publish`, `version`, `changelog`. Applied before `--deps`/`--dependents`, so an edge cannot drag a skipped package back in. `list` is the one command that ignores it: an inventory hiding part of the repository answers a different question. |

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

**The `node` built-in's keys need no extra import** - `clean`, `publish.npm.*` and
`packageManager` are augmented into `RmanConfig` by rman itself, so `defineConfig` from `'rman'`
types them. `RmanNodeConfig` is still exported as an alias for a config that wants its annotation to
say which keys it uses. A *third-party* plugin's keys arrive the same way, by `declare module
'rman'` - so its package's own entry point has to be in the program, which importing anything from
it (or its `defineConfig`, where it ships one) ensures.

```js
// .rmanrc.mjs
import { defineConfig } from 'rman';

export default defineConfig({
  packageManager: 'pnpm',
  '[*]': { clean: { include: 'build' } },
});
```

**A published plugin arrives through `extends`, not `plugins`.** Its package exports an rman
*config* (its platforms, commands, publish targets), and a config's way into a repository is
`extends`; `plugins` takes an instance or a **glob**, so a bare package name there matches no file.

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

**`config` is registered and empty.** `app.getService('config')` resolves and the key is in
`ServiceMap`, but `ConfigService` has no members yet - the reading, interpolating and cascading all
still live in `ConfigReader`, `ConfigInterpolator` and `Workspace`. It is a reserved slot, not an
API; nothing should be written against it until it has a shape.

### `VersionService`

Computes and applies version bumps across the repository, with `.rmanrc group`-based release
grouping (fixed or independent versioning), Conventional Commits-based severity auto-detection,
cross-group dependency-range propagation, and prerelease (`--preid`) support.

"Since the last release" is resolved by the shared [`ChangeHashService`](#changehashservice) - the very
same boundary `ChangelogService` measures from, so `version` and `changelog` never disagree
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

  /** The registered orchestrator. Throws when no loaded platform contributes one. */
  function getPlanner(app: RmanApplication): VersionPlanService;
}

/** Abstract - a technology supplies it (`Platform.versionPlanner`). */
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

- `group: true` (the default) - one implicit repo-wide group. Its members share one version line;
  how many of them move on a given bump is the cascade below, so add `version.cascade: group` for
  classic "fixed" / Lerna-style lockstep.
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
bumped by that severity. Which members actually *receive* the new version is the technology's
[`cascade`](#versionplanservice) answer, under the `node` built-in:

| Severity | Who gets bumped |
| --- | --- |
| `patch` | The changed member(s) and every transitive **in-group** dependent of one - a caret range would accept the patch, but a dependent's published artifact was built against the old code. |
| `minor` | The same: changed members plus their in-group dependents. |
| `major` | The **entire group**, changed or not. |

`.rmanrc "version.cascade"` widens that floor for a repository - `version.cascade: group` keeps a
group in **lockstep** on every bump, which is what a "one repo-wide version line" usually means.
Without it, a `fix:` in two of seventeen grouped packages releases those two and their dependents,
and the rest stay behind on the old number for good.

Across groups, a package depending on another group's bumped package always receives exactly the
scheme's **smallest** bump of its own (never the source's severity) - this can itself ripple into a
third group, and so on, carrying that group's own cascade for the smallest bump with it.

#### Grouping decides how release tags are named

`changelog.tagPattern` has **no fixed default**. It is derived from how many version lines the
repository has, the same way the root's own versioning scheme is (see
[The repository's own version](#the-repositorys-own-version-monorepo-root)):

| Version lines | Default pattern | Tags |
| --- | --- | --- |
| one | `v*` | `v1.2.3`, shared by every package |
| several | `{name}@*` | `pkg-a@1.2.3`, one per package |

**This is not a preference.** A pattern without `{name}` is resolved with `git describe --match` -
the nearest tag HEAD descends from, whichever package it belongs to - which is exactly right while
every package releases together and silently wrong the moment they do not. Measured on a two-line
repository: releasing `pkg-a` put `v1.1.0` on HEAD, and `pkg-b`, which had a committed but
unreleased `fix:` of its own sitting behind that tag, reported `no-change` and shipped nothing. Each
group member still gets its own tag at the group's shared version, so every package is findable by
name.

**Growing a second version line needs no migration.** While a package has no tag under its own name
yet, the boundary falls back to the repository-wide `v*` tag - the one that *was* correct, since
before the split every package genuinely shared it. So the first run after grouping reads the same
commits it would have read before, and writes a `{name}` tag that every run after it finds
directly. Declaring `changelog.tagPattern` yourself turns that fallback off: a repository that has
said what names its tags is not handed a boundary from a tag it never asked about.

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
  range only at publish time - see [`"workspace:"` ranges](#workspace-ranges).
- An **explicit** `"workspace:<range>"` (e.g. `"workspace:^1.0.0"`) *is* bumped, the same way a
  plain range would be: `"workspace:^1.0.0"` → `"workspace:^2.0.0"`.

#### Stamping the version where the package declares it

`applyPlan` also rewrites a bumped package's `org.opencontainers.image.version` Dockerfile label to
the new version and folds that file into the same commit as the bump (`stampVersionLabel`, in
[`src/utils/version-stamp.ts`](../packages/rman/src/utils/version-stamp.ts)). The label is by specification *the
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

A listed file that *does* exist and holds nothing rewritable is an **error**, raised before anything
is written - the two are not the same thing. A missing file means "not this package"; an existing one
with nothing to rewrite means the repository asked for something and did not get it, and silence
there ships a stale constant on every release from then on. Writing `{ file, optional: true }` waives
the refusal, and it is written for one case: a **shared config** naming one path for every package of
a technology is saying *stamp it where there is one*, and cannot know which of the repositories
extending it actually keeps a version constant there. A bare string still throws - the asker chooses,
the way `file.exists()` and `file.resolve()` already split the same question.

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

**Abstract - a technology supplies it**, through `Platform.versionPlanner`. `version` fails
naming that key when no loaded platform contributes one: there is no version plan that is
merely a diminished one, and a wrong boundary or cascade releases a plausible, untrue set of
packages.

Two roles, and they resolve differently:

| | |
| --- | --- |
| **Orchestrator** | `app.versionPlanner` - one slot, last registration wins. Drives groups, the commit→size reading, the cross-group ripple and the root's release identity: none of it belongs to a technology, and all of it is computed for the whole repository at once. |
| **Per package** | `detectBoundary` and `cascade`, asked of `pkg.platform.versionPlanner` (falling back to the orchestrator). |

That split is not cosmetic. Both used to come off the single slot, so in a polyglot repository a
Cargo package's boundary fell back to `npm view` and its cascade assumed npm's caret ranges -
whichever plugin registered last decided for every package. A group whose members disagree about
`cascade` takes the **widest** answer: too narrow releases too little, which is the invisible
failure; too wide releases a package that did not strictly need it.

The two abstract members are exactly the decisions no repository-in-general has an answer to:

- **`detectBoundary`** - since when is a package unreleased. Git tags answer it for any repository
  (`ChangeHashService.detect` is exported for that), but *which* registry stands in when a package
  has no tag yet is the ecosystem's business.
- **`cascade`** - how far into its group a bump reaches (`'changed' | 'dependents' | 'group'`),
  asked with a name from the scheme's own `bumpNames`. It is a statement about what a **published
  artifact** still needs, not about versions: an ecosystem pinning exact versions has to release
  every dependent for a patch, and one resolving from source may need no release at all.

```ts
class NodeVersionPlanService extends VersionPlanService {
  protected detectBoundary(git: GitHelper, pkg: Package): Promise<string | undefined> {
    return ChangeHashService.detect(git, pkg);
  }
  protected cascade(bump: string): VersionPlanService.Cascade {
    // patch -> 'dependents', minor -> 'dependents', major -> 'group'; anything else -> 'group'
    return CASCADE_BY_BUMP[bump] ?? 'group';
  }
}
```

**npm's patch answer is `'dependents'`, not `'changed'`**, although `^1.2.0` already resolves to
`1.2.1`: a dependent's *artifact* was built against the old code, and anything that bundles or
vendors it keeps shipping the pre-fix version until it is released again. Visible churn is
preferred to an invisible miss.

**`.rmanrc "version.cascade"` is the repository's floor under that answer** - `'changed'`,
`'dependents'` or `'group'`, per-package cascaded, the widest of a group's members winning.
`cascadeFor` takes the widest of the technologies' answers *and* the declared one, so a repository
can ask for a wider release than its ecosystem requires and never a narrower one. It exists for
the question `cascade` cannot answer - whether a repository wants **one number across its whole
product** - which is `version.cascade: group` (lockstep). Under npm, `dependents` equals the
default and `changed` narrows nothing. An explicit `rman version <v>` never consults it: every
eligible package moves already.

### `PublishTarget`

**Where a package's artifact ships, as a contribution.** The [`publish`](cli/publish.md) command is
rman's; a target is one answer to "is this version on the registry, and how do I push it", which is
the only part of publishing an ecosystem owns. rman's core registers `docker`; the `node` built-in
registers `npm`.

```ts
interface PublishTarget {
  name: string;                                    // what publish.target and --target call it
  describe?: string;                               // one line, for --target's help
  options?: Record<string, RmanConfig.CommandOption>; // merged into `publish`'s own flags
  claims?(pkg: Package): boolean;                  // is this package mine when it declares nothing?
  skipReason?(pkg: Package): string | undefined;   // why I would leave it alone, without the registry
  labelFor?(pkg: Package): string | undefined;     // what `rman list` shows instead of `name`
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

Contributed through the config key, in declaration order - a publish target is a contribution like
a command or a platform, not something a plugin registers by hand:

```js
import { defineConfig } from 'rman';

export default defineConfig({
  publishTargets: [cratesIoTarget],
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
- **`skipReason(pkg)` is why a target would leave a package it ships to alone**, from the config and
  manifest alone - no registry, no build. `skipReasonFor(pkg, target)` asks `.rmanrc "publish.skip"`
  first and then the target; it is what `rman list` leaves a target out by (`-` when none is left). A target implementing it
  should call the same function from its own `getPlan`, or the list and the plan can disagree - npm's
  does (`PublishService.skipReason`).
- **`labelFor(pkg)` is what `rman list` shows in place of `name`** for one package - npm's is the
  host of a `publishConfig.registry` other than npm's own (`npm.pkg.github.com`). A label, never an
  identity: `--target` and `publish.target` still take `name`.

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
--push`, using that package's own `publish.docker` config: `architectures` (default `["linux/amd64"]`),
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

Generates (and optionally writes) a Markdown changelog per package - or per release group - from
real commits, one section per commit type via best-effort Conventional Commits parsing.

```ts
namespace ChangelogService {
  interface Options extends PackageFilterOptions {
    from?: string;            // commit/hash for every package, or "auto"/omitted to detect per package
    fromRoot?: boolean;       // whole repository even when standing inside one package
    filePath?: string;        // relative to each package's own directory, default "CHANGELOG.md"
    includeSkipped?: boolean; // include a .rmanrc "publish.skip" package too - excluded by default
    version?: string;         // the version these entries are FOR - default: read back from git tags
    write?: boolean;          // set by generateToFile: start where the file's marker says, not at the tag
    rebuild?: boolean;        // with write: regenerate each file from the whole history
    startingAt?: string;      // overrides changelog.startingAt
    unreleased?: boolean;     // overrides changelog.unreleased
    commitHash?: boolean;     // overrides changelog.commitHash
    groupBy?: 'package' | 'group'; // overrides the root's changelog.groupBy
    progress?: Progress;      // where to report, for a caller drawing a panel
  }

  interface Progress {
    start(labels: string[]): void;
    step(label: string, phase: 'detect' | 'commits' | 'render'): void;
    commits?(label: string, done: number, total: number): void;
    done(label: string, wrote: boolean): void;
  }

  interface Entry {
    package: Package;         // whose directory holds the file - the root for a group of several
    label: string;            // the group's name, "<repo dir name> repository" for root, else its own name
    version: string;          // options.version, else resolved from git tags (not package.json)
    documentedUpTo: string;   // the last commit covered - written into the file as the next run's start
    sections: { title: string; lines: string[] }[];
    features: string[];       // derived from sections - see {{features}} below
    fixes: string[];
    other: string[];
    content: string;          // the fully rendered entry
    file: string;             // absolute - where it would be (or was) written
    filePath: string;         // `file` relative to `package`'s directory, for display
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
const since = await app.getService('changelog').getEntries({ from: 'a1b2c3d' });

// Actually prepend each entry into its own CHANGELOG.md:
const written = await app.getService('changelog').generateToFile({ fromRoot: true });
for (const entry of written) console.log('wrote', entry.file, 'for', entry.label);
```

**The service prints nothing**, a progress panel included - `version --changelog` drives it in the
middle of its own output. Pass `progress` to be told what it is doing; the slow phase is
`commits`, reported per commit through `commits(label, done, total)`. A label names a **file**,
which under `groupBy: 'group'` is a group rather than a package.

**`generateToFile` appends from the file's own marker, not from the release tag.** Each file
carries `<!-- rman:documented-up-to <sha> -->`; a run starts there, a file that does not exist yet
gets the whole history, and a file with no marker falls back to ordinary detection. A tag does not
move between two writes, so starting at it re-listed everything already written. `rebuild` ignores
the marker, empties each file it writes once, and regenerates it. A range that crosses release tags
is cut at each into one entry per release, newest first.

By default (`from` omitted, or `"auto"`), the boundary is auto-detected per package from its own
most recent release tag first - the same one `version` uses, so the two agree on "since when" -
falling back to the version its ecosystem's registry reports only when it has no tag at all yet,
and only to guess a tag name that must exist in git (via [`ChangeHashService`](#changehashservice)); a package that can't be resolved
either way (never tagged *and* never published) has no boundary at all, so its whole history
counts as unreleased - the same view `version` takes.

A commit touching a package's files is attributed to that package's changelog entry - unless it's
broad enough (touches at least 3 packages *and* more than half of all packages) to count as a
repo-wide maintenance change (a relicense, a doc pass across every package, ...), in which case
it's attributed to the root alone instead of being repeated verbatim across most of the repo.
Under `groupBy: 'group'` that diversion has nothing to do - a commit touching every member is the
group's by construction. A commit is matched against where each package **was then**, read from
its manifest's moves (`git log --follow`, trusting a rename only where most of the directory's
files went too), so a package moved under a new directory keeps the history before the move.

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
template text itself). The default is:

```
## {{title}} ({{date}})

{{commits}}
```

**`{{title}}`, not `{{package}} {{version}}`.** An entry a release tag closes is headed by that
**tag**, because assembling a heading from a label and a version states something untrue wherever a
tag covers more than one package - a repository root came out as `## panates-javascript repository
2.1.6` while the root package there was `panates-style` at `0.0.5`. An untagged segment is
`Unreleased — <label>`, and the label has to stay in it: `rman changelog` prints every package to
one stream, so consecutive bare `## Unreleased` blocks say nothing about which package each belongs
to.

Every placeholder:

| | |
| --- | --- |
| `{{title}}` | the entry's heading - its tag, or `Unreleased — <label>` |
| `{{date}}` | the **tag's committer date**, or today for an untagged segment |
| `{{commits}}` | the full grouped block, every section with its heading |
| `{{package}}` / `{{version}}` / `{{tag}}` | still bound, for a repository that wants to assemble its own heading |
| `{{features}}` / `{{fixes}}` / `{{other}}` | bullet lists alone, for a template with its own headings |

`{{features}}`/`{{fixes}}`/`{{other}}` are **derived** from the sections, so they keep meaning what
they meant - whatever `feat` and `fix` are listed under, and everything else together. Since
`changelog.titles` lets any commit type carry a heading, `Entry.sections` is the shape that does not
lose a repository's own; prefer it in code.

**`{{date}}` is the tag's date, not `new Date()`.** The version half of a heading is read back from
the package's latest tag, so taking the date from the clock made the two halves describe different
releases - measured, `v2.1.6 (2026-09-25)` for a tag cut days earlier - and made a regenerated file
differ from itself every day.

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
    fromRoot?: boolean; // ignore the current directory and run across the whole repository
  }

  interface ForEachOptions {
    parallel?: boolean | number;
    bail?: boolean;     // default true
    topo?: boolean;     // default FALSE - unlike run's
    progress?: boolean;
    logLevel?: LogLevel;
    label?: string;     // the panel's title and the word in the failure - the command's own name
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
  forEachPackage(packages: readonly Package[], fn: RunStepFn, options?: ForEachOptions): Promise<void>;
  parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { parallel?: boolean | number }): Promise<T[]>;
}

// Module-level in services/run.service.ts - not re-exported from 'rman':
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

// Only in packages touched but not pushed, serially, never bailing on a single failure:
await app.getService('run').runScript('test', { changed: true, parallel: false, bail: false });
```

`runScript` throws an `Error` with `.logged = true` (see [below](#the-logged-error-convention)) if
any package's steps failed - `await` it inside a `try`/`catch` if you want to keep going
programmatically instead of letting the process exit. "Any" is counted from the per-package
outcomes, not from whether the underlying task tree rejected: a package's own `bail` aborts that
tree, whose promise then settles while the packages already in flight keep running, so reading the
run off it used to resolve on a failed run - and inconsistently, depending on which siblings
happened to still be going.

**`forEachPackage` is what a command reaches for instead of a `for` loop over packages.** It runs
`fn` once per package under the same scheduler `run` uses - concurrency, bail, dependency order
when asked, the progress panel, and `console` routed to that package's row - and hands `fn`
exactly what a [function step](#function-steps) gets: `pkg`, `cwd`, a `runBin` already bound to the
package's directory and this run's log level, and a `logger`. A loop of `await runBin(...)` ignores
`--parallel`, draws no panel and has to re-implement `--bail` and the summary. Ordering is **off**
unless `topo: true`, since a sweep with an independent tool is the common case. An empty list
returns without failing - the caller knows why it is empty. A failed package throws the same
`logged` error `runScript` does.

```ts
const run = repository.app.getService('run');
await run.forEachPackage(packages, async function check({ runBin }) {
  await runBin('dpdm', ['-T', 'src/index.ts']);
}, { label: 'check', ...readParallelOptions(args) });
```

`parallel(tasks)` is the low-level half, for work that is not per package (sharding a file list):
the concurrency limit and nothing else - no rows, no names, no ordering. It settles the tasks
already in flight before rejecting, so no child process reports after the command has exited.

**A command aliasing `run <script>`** takes `runOptions` and `readRunOptions` - the same flags and
reader `build` and `test` use - so a preset adding `compile` or `docs` does not restate the six
flags. `parallelOptions`/`readParallelOptions` are the smaller set (`--parallel`, `--bail`,
`--progress`) for a `forEachPackage` command:

```ts
import { declareCommand, readRunOptions, runOptions } from 'rman';

export default declareCommand(app => ({
  command: 'docs' as const,
  describe: 'Build the documentation in every package',
  config: runOptions,
  configKeys: ['run.docs'],
  handler: args => app.getService('run').runScript('docs', { ...readRunOptions(args), commandName: 'docs' }),
}));
```

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
    before: [node ./generate.js, node ./validate.js] # runs BEFORE the package's own "prebuild"
    exec: tsc -b # used only if the package's own package.json has no "build" script
    after: node ./copy-assets.js # runs AFTER the package's own "postbuild"
    override: true # replace the package's own instead of bracketing it
  lint:
    topo: false # lint scripts are independent - alphabetical order, no dependency waiting
    bail: false
  test:
    skip: true # this package opts out of "test" entirely
```

**`before`/`after` compose with the package's own hooks; only `exec` replaces.** The two are not the
same kind of key: `exec` is one answer to one question, so a package declaring `"build"` and a config
declaring `exec` are the same build stated twice - while a hook is a *point*, and two hooks at one
point both belong. The config brackets the package's own:

```
config.before -> prebuild -> build -> postbuild -> config.after
```

Measured, and it was a silent loss: a root declaring `"[*]" run.build.before` lost it entirely for
any package that happened to have a `prebuild`, so adding an unrelated codegen hook to one package
cancelled a repo-wide `rman clean` with a stale build directory as the only symptom. `version` uses
the same function, so npm's `preversion` no longer replaces a repository's `version.before` either.

`override: true` is unchanged and is the way to say "ignore what the package says it does": the
config replaces rather than composes, per slot.

`getConfig(pkg, script)` reads exactly this resolved block for one package/script pair - useful if
you're building your own tooling on top of the same config convention.

**`RunService` does not ask every key of every package.** `concurrency`, `progress`, `changed` and
`changedSince` it reads off the **root package only** - one scheduler, one answer for the whole
batch - while `logLevel`, `skip`, `if`, `override` and the step slots are per package, and `topo`
and `bail` are read both ways and mean different things at each. The block above is unmarked, so it
reaches the root package as well as the members and every key lands; in a monorepo a `"[*]"`
block does not reach the root, and the scheduling keys in it would be silently ignored. See
[the table in `docs/cli/run.md`](cli/run.md#per-packagescript-configuration-rmanrc-runscript).

#### Conditional execution (`if`)

A small, GitHub-Actions-`if`-flavored boolean grammar - atoms (`changed`, `dirty`, `committed`,
each optionally `= <hash-or-{ENV}>`) combined with `and`/`or`/`not`/`(...)` (`and` binds tighter):

```yaml
run:
  build:
    if: changed # touched but not pushed
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
    fromRoot?: boolean;
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
    includeRoot?: boolean; // the root package is not a workspace member, so it is opt-in
  }

  interface Item {
    name: string;
    selector: string; // what addresses it - "[glob]" and --scope match this, not name
    version: string;
    platform: string; // the technology that claimed its directory; '' when none did
    depth: number; // how deep in the package tree it sits
    isRoot: boolean;
    location: string; // relative to the repository root
    private: boolean;
    status: Repository.PackageStatus;
    dependencies: string[]; // in-repo package names - enough to build a dependency graph
    groupKey: string; // the release group, as version --json spells it: default / named:<n> / solo:<pkg>
    group: string; // its name - the group's, "default", the package's for a solo one, "root"
    publishTargets: string[]; // where it actually ships: its own "publish.target", or what claims it
    skippedTargets: Record<string, string>; // the publishTargets publish would skip it for, and why
    targetLabels: Record<string, string>; // what the table shows instead of a target's name
    docker?: DockerPublishOptions; // present only when "docker" is one of publishTargets
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
from. `envinfo` merges *over* the defaults, so an augmentation can replace `Binaries` rather than
only append to it.

**The `node` built-in is the worked example**, and it is bundled rather than separate: its
`augmentSystemInfo()` adds `Options.packageManager`, wraps `getSystemInfo` so the report carries the
configured package manager's version under `Binaries` plus the `npmPackages` sections, and defaults
the value from `.rmanrc "packageManager"` read off `Options.repository`. It is applied when the
built-in is *contributed*, not at import time - so `rman info` in a Cargo repository that never
named `node` reports no npm tooling.

## Shared utilities

### `ChangeHashService`

Resolves the commit a package's changes should be measured "since" - the single boundary
`ChangelogService` **and** `VersionService` (so `changelog` and `version`) both call, rather than each
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

### `ProgressPanel`

The live panel `run`, `build`, `clean`, `ci` and `changelog` draw - exported so a plugin's
per-package command looks like the rest of rman. **Reach for
[`RunService.forEachPackage`](#runservice) first**: it builds and drives a panel for you, along
with concurrency, bail and console capture. Drive one by hand only for work that is not a run.

```ts
class ProgressPanel {
  constructor(title: string, enabled: boolean, stream?: NodeJS.WriteStream); // stream: stdout by default
  detail?: string;                       // shown at the right end of the header - the repository name
  readonly enabled: boolean;
  addItem(name: string, stepsTotal?: number): ProgressItem;
  start(statusRegion?: StatusRegion): void; // pass app.statusRegion
  passThrough(text: string): void;       // print above the panel without breaking it
  stop(): void;
  tally(): ProgressSummary;              // count once, without printing
  printSummary(): ProgressSummary;
}

function formatDuration(ms: number): string;
```

- **Pass `app.statusRegion` to `start`.** Every command already has a status line drawing on the
  terminal, and two regions redrawing at once land on each other's rows; the panel suspends the
  line while it draws and `stop()` hands it back. A panel that forgets reintroduces the flicker
  with nothing reporting it.
- **Set `currentStep`/`currentCommand` on the item**, not only `status`: the row shows the command
  it is running, and a row forgets its last captured line when either changes, so stale output
  never sits under a new command. A failed item stays listed below the running ones.
- Construct it with `enabled: !!process.stdout.isTTY && progress !== false` (or the stream you draw
  on) - off a TTY it draws nothing and `passThrough` writes straight through.

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

## The `node` built-in

**The `node` platform ships inside rman.** It was `rman-node`, a second package every Node
repository had to install before anything worked - which is the cost this removed.

**It needs no declaration at all.** rman lays its own `node` preset under every repository root
(`DEFAULT_PRESETS`), so a clone with no `.rmanrc` already has the `node` technology, `clean`, `ci`
and the `npm` publish target. A preset is an ordinary rman config - `platforms`, `commands`,
`publishTargets`, keys that already existed - so another technology arrives the same way:

```yaml
extends: ['rman:node', 'rman:cargo']   # a polyglot repository gets both
```

**The default preset is merged *last*, underneath whatever the config declared**, and that is the
whole safety of it: `platformFor` takes the first technology that recognizes a directory, so a root
holding both a `Cargo.toml` and a tooling `package.json` resolves to the one the repository asked
for. `presets: []` on `Repository.create`/`runCli`/`Workspace.create` is the opt-out for a caller
that brings an ecosystem of its own.

**`plugins: ['node']` is not one of the forms and is refused**, naming the fix. That key takes a
plugin instance or a glob naming modules that export one; a *name* is what `extends` resolves, and
the two are different statements - `extends` inherits everything a config declares, while `plugins`
names the technologies themselves. The keys that do exist:

```yaml
platform: node      # which technology claims *this directory*; it loads nothing on its own
platforms: [...]    # contributes technologies - an instance, or a glob naming modules exporting one
```

A declared `platform` that no loaded technology provides is an error naming the file, and the fix is
`platforms` or `extends`.

**This replaced detection**, which asked each built-in "is this directory yours?" without turning
anything on. What that bought was a repository not growing a technology's commands unasked; what it
cost was a catalogue module, a `Builtin` type, a per-directory memo, a symbol and a gate with three
conditions. The platform answers the same question now, from the ordinary registry, once loaded.
The cost, stated rather than hidden: a repository of another technology carries node's `clean` and
`ci` in `rman --help`, `rman info` reports npm's tooling, and every package's `rman config` shows
the preset's contribution keys. rman ships one preset, so none of that is visible today.

### What it contributes

| | |
| --- | --- |
| **Platform** | `manifestProvider` (`package.json`, `npm view` for `publishedVersion`, `stampVersion`), `getWorkspace` (the `workspaces` globs, asked of every directory the walk reaches), `getRunSteps` (`package.json#scripts`, including `pre`/`post` - which is also how npm's `preversion`/`version`/`postversion` reach `version`, with no second seam), `getBinPaths` (`node_modules/.bin`, walked up), `versionPlanner` (`detectBoundary` through `ChangeHashService.detect`; `cascade` is `dependents` for a patch or a minor and `group` for a major), `dependencyUpdater` (what [`deps`](cli/deps.md) asks: the registry, the package's own peer ranges, `engines.node` and its siblings' peers, and `npm install --dry-run` at the root as `verify`). |
| **Commands** | [`ci`](cli/ci.md) and [`clean`](cli/clean.md). |
| **Publish target** | `npm` - see [`PublishTarget`](#publishtarget). |
| **Config keys** | `packageManager`, `clean.*`, `publish.npm.*`. (`deps.*` is the core's command; `deps.types` takes npm's words here.) |
| **`SystemInfo`** | the npm half - see [`SystemInfo`](#systeminfo). |

**Which declarations become graph edges**: all four of `dependencies`, `devDependencies`,
`peerDependencies` and `optionalDependencies`, limited to names belonging to the repository - an
external dependency is not an edge. One exception: a peer marked `"optional": true` in
`peerDependenciesMeta` states no order, since the package works without it, and is left out. It
still counts where another field declares it too - `devDependencies` naming it is a real build-time
need whatever the peer block says. `optionalDependencies` is *not* read as optional here: an
optional peer says "works without it", while an optional dependency is one the package means to use
and may fail to install.

Its services are exported from `rman` itself: `PublishService`, `CiService`, `CleanService`,
`NodeVersionPlanService`, `NpmPublishTarget`, `NPM_TARGET`. A repository never constructs any of
them - it names the technology and they arrive.

**`RmanNodeConfig` is the authoring alias**, still exported, for a config package that wants the
name to say which keys it is using. It is `RmanConfig` with the same augmentation applied, so either
annotation types `clean` and `publish.npm` - the augmentation is part of rman's own program now
rather than something an import has to carry.

### `"workspace:"` ranges

The `"workspace:"` protocol is a statement about a `package.json` dependency field, so it belongs to
this built-in rather than to the core - which never read it:

```ts
interface ParsedWorkspaceRange {
  selector: '*' | '^' | '~' | 'explicit';
  range?: string; // only when selector === 'explicit'
}
```

| Declared | `selector` | Published as |
| --- | --- | --- |
| `workspace:*` | `'*'` | the dependency's exact current version, no operator |
| `workspace:^` / `workspace:~` | `'^'` / `'~'` | that operator + the version |
| `workspace:^1.0.0`, `workspace:1.0.0` | `'explicit'` | the range verbatim, prefix stripped |

The same substitution pnpm and yarn perform in their own `publish`, applied to the manifest
`publish` generates in the build directory.

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

## Package filtering (`scope`/`ignore`/`platform`/`deps`/`dependents`)

Every service above that takes `PackageFilterOptions` narrows its target package set the same way:

```ts
interface PackageFilterOptions {
  scope?: string | string[]; // only packages whose selector matches this glob, or "/" for the root
  ignore?: string | string[]; // exclude packages matching this glob (or "/"), applied after `scope`
  platform?: string | string[]; // only packages of these platforms - 'node', or 'node,cargo'
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
(`*`, `**`, `{a,b}`, ...) matched against each package's [`selector`](#package) - which is its name
wherever the technology names its packages, and whatever `.rmanrc "name"` assigned where it does
not.

**`platform` takes names rather than globs**, so the set of valid values is known - and a name no
package in the repository belongs to is an **error** listing the ones that are, the same call
`publish --target` makes against its registry. A glob would put a typo back to a silently empty
result. Comma-separated values are split and the comparison is case-insensitive.

**`"/"` (`ROOT_SELECTOR`) is the repository's own root package, and it is not a glob** - the same
`/` `.rmanrc`'s `"[/]"` block uses, for the reason stated there: *the root is never selected by
name.* In a monorepo a glob is never offered the root, so `scope: '*'` means the members and
`scope: '/'` means the root; `ignore: '/'` is every package but the root. In a **single-package
repository** a glob does reach the root, because there it is the one package - the same rule a
`"[*]"` config block follows, so `"[*]"` and `scope: '*'` always name one set. It is accepted everywhere `scope`/`ignore`
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
