<!--
docs-baseline
git-commit: 0ec1e88
package-version: 1.0.12
date: 2026-09-17

Verified against `packages/node/src/` as of the commit above. Before trusting/updating this file in
a later session, run:

  git diff 0ec1e88..HEAD -- packages/node/src/

and update only the sections touched by what that diff actually shows. Once verified again, bump
`git-commit`/`package-version`/`date` above to the new HEAD.

Note: the sections moved here out of the old `docs/rman.md` came from a baseline of `0e33a0a`. The
signatures were re-read from source during the move; the prose around them was not re-verified line
by line.
-->

# `rman-node` API Reference

Node.js support for rman, as a plugin. rman's core is about **repositories** - packages, versions,
changelogs, releases, branches. This package is about **npm**, which is a different thing that
happens to be true of most repositories rman has been used on.

```yaml
# .rmanrc.yml
plugins: ['rman-node']
```

Naming it does three kinds of thing at once, and they are worth telling apart:

| | What it adds | Where it plugs in |
| --- | --- | --- |
| **Commands** | `publish`, `ci`, `clean` | `RmanPlugin.commands` |
| **Seams** | what a package *is* (`package.json`), where packages are (`workspaces`), how a version is planned, what `pre<script>`/`post<script>` mean, `node_modules/.bin` on PATH | `manifest`, `workspace`, `versionPlanner`, `runSteps`, `binPaths` |
| **Augmentations** | the npm half of `SystemInfo` (what `info` prints), and the `.rmanrc` keys below | `augment*()` + `declare module 'rman'` |

Without this package, `rman clean` is `Unknown argument: clean`, and a repository has **no manifest
reader at all** - which is the point: another ecosystem supplies its own through the same seams,
rather than working around npm's.

## Table of contents

- [Installation](#installation)
- [Config keys](#config-keys)
- [Services](#services)
  - [`PublishService`](#publishservice)
  - [`CiService`](#ciservice)
  - [`CleanService`](#cleanservice)
- [`SystemInfo`: the npm half](#systeminfo-the-npm-half)
- [Seams this plugin fills](#seams-this-plugin-fills)
- [`"workspace:"` ranges](#workspace-ranges)

## Installation

```bash
npm install rman-node
```

ESM-only, requires **Node.js >= 20**, and takes `rman` itself as a peer. Everything below is
imported from the package root:

```ts
import {
  defineConfig,
  nodePlugin,
  PublishService,
  CiService,
  CleanService,
  NodeVersionPlanService,
  nodeVersionPlanner,
  packageJsonManifest,
  npmWorkspace,
  packageJsonSteps,
  npmBinPaths,
  DEPENDENCY_KEYS,
  parseWorkspaceRange,
  resolveWorkspaceRange,
} from 'rman-node';
import type { RmanNodeConfig, NodeConfigKeys, ParsedWorkspaceRange } from 'rman-node';
```

## Config keys

Three `.rmanrc` keys only mean something because the repository is a Node one, so they are declared
here rather than in rman's core:

| Key | Level | What it says |
| --- | --- | --- |
| `packageManager` | root only | Which package manager `ci`/`publish` shell out to, and whose version `info` reports. `npm` \| `yarn` \| `pnpm` \| `bun`, default `npm`. |
| `clean` | per package, cascaded | `include`/`exclude` globs beyond TypeScript's own output, and `skip`. A package declaring its own `clean` replaces the root's entirely for itself. |
| `publish.directory` | per package, cascaded | Where this package's publishable output lives, relative to its own directory. Added to the core's `publish` block. |

**They reach `RmanConfig` by declaration merging**, so `pkg.config.clean` is typed at the place it is
*read* without a cast:

```ts
// packages/node/src/augmentation/rman.augmentation.ts
declare module 'rman' {
  interface RmanConfigKeys extends NodeConfigKeys {}
}
```

`RmanNodeConfig` is the name a **config author** annotates with, and its `defineConfig` is the
import that carries that augmentation - explicit, rather than a side effect someone has to remember:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman-node';

export default defineConfig({
  plugins: ['rman-node'],
  packageManager: 'pnpm',
  '[ws:*]': { clean: { include: 'build' }, publish: { directory: 'build' } },
});
```

`.mjs`, not `.ts`: rman loads `.rmanrc.cjs`/`.mjs`/`.js` and no TypeScript form. The `.rmanrc` and
`.rmanrc.yml` forms carry no type at all - see
[rman.md#editor-support-types](rman.md#editor-support-types) for why there is no JSON Schema.

## Services

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
    contents?: string; // subdirectory to publish from - lowest precedence, see below
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
import { PublishService } from 'rman-node';

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
registry-consumable range - see [`"workspace:"` ranges](#workspace-ranges). The original file is
restored immediately afterward, success or failure (via a `finally`), since `rman` publishes
directly from the working tree rather than a staged tarball.

```ts
// packages/b/package.json before publish: { "dependencies": { "pkg-a": "workspace:*" } }
await PublishService.applyPlan(repository, plan);
// -> "npm publish" for pkg-b saw {"pkg-a": "1.2.3"} (pkg-a's real current version)
// -> packages/b/package.json is back to "workspace:*" once applyPlan returns
```

#### Where it publishes from, and the manifest it finds there

Most specific first: the package's own `publishConfig.directory`, then `.rmanrc
"publish.directory"` (one `"[ws:*]"` line for a repository instead of a copy in every `package.json`),
then `ApplyOptions.contents` for a single run. Absent all three, the package's own directory.

When that resolves to a **subdirectory**, `applyPlan` writes the `package.json` `npm publish` will
read there, derived from the package's own, and removes it again afterwards - it is a publish-time
artifact, not a build output. There is nothing to configure about the derivation, because each field
has one right answer:

| Removed from the copy | Why |
| --- | --- |
| `devDependencies` | npm never installs a dependency's own. |
| `scripts`, except `preinstall`/`install`/`postinstall` | Those three are the only ones a consumer's install runs; dropping them would silently break every package that builds a native module. The rest never reach a consumer (`prepare` runs for a *git* dependency, which builds from the repository, not from this tarball). |
| `private` | `publish` refuses a private package outright, so the flag can only be wrong in a manifest being published. |
| `publishConfig.directory` | It pointed *here*; kept, it would point one level deeper again. |

`"workspace:"` ranges are resolved in it too. Publishing the package directory itself instead, that
same resolution happens in place on its own `package.json`, restored verbatim afterwards.

Generating it here rather than from a build script is what keeps it honest: a script writes it when
the *build* runs, so bumping the version afterwards publishes a manifest that disagrees with the
package - and the `"workspace:"` rewrite, which only ever touched the package's own file, never
reached the copy npm actually reads.

### `CiService`

A from-scratch, reproducible install: deletes `node_modules` and any known lockfile in every
package (root included) - or runs the package's own `"ci"` script instead, if it defines one -
then installs once at the root.

```ts
namespace CiService {
  type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

  interface Options extends PackageFilterOptions {
    packageManager?: PackageManager;
    progress?: boolean; // default true, auto-disabled when stdout isn't a TTY
    logLevel?: LogLevel;
  }

  function resolvePackageManager(repository: Repository, cliValue?: PackageManager): PackageManager;
  function wipe(dirname: string): Promise<string[]>; // returns what was actually removed
  function reinstall(repository: Repository, options?: Options): Promise<void>;
}
```

```ts
import { CiService } from 'rman-node';

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
    root?: boolean; // whole repository, even from inside one package's directory
    logLevel?: LogLevel;
  }

  function clean(repository: Repository, options?: Options): Promise<void>;
}
```

```ts
import { CleanService } from 'rman-node';

// Preview only, nothing removed:
await CleanService.clean(repository, { dryRun: true });

// Actually remove, whole repository even from inside one package's own directory:
await CleanService.clean(repository, { root: true });
```

```json
// A package's own .rmanrc:
{ "clean": { "include": ["dist", "*.tmp"], "exclude": ["dist/keep-me.json"], "skip": false } }
```

A `.d.ts` with **no** matching `.ts`/`.tsx` beside it is left alone - that is a hand-written
declaration, not build output.

## `SystemInfo`: the npm half

`SystemInfo` itself is the core's (see [rman.md#systeminfo](rman.md#systeminfo)), and it reports
only what is true of any repository. `augmentSystemInfo()` adds this ecosystem's part in place:

```ts
declare module 'rman' {
  namespace SystemInfo {
    type PackageManager = CiService.PackageManager;
    interface Options {
      packageManager?: PackageManager;
    }
  }
}
```

It wraps `getSystemInfo` so the report also carries the configured package manager's version under
`Binaries`, plus the `npmPackages` sections. The value defaults to `.rmanrc "packageManager"` - read
off `Options.repository`, which exists on the core's interface for exactly this - and then to `npm`,
this package being installed being itself the statement that the repository is a Node one.

Applied when the plugin module loads, not from inside a command, so a **core** command (`info`) sees
it too.

## Seams this plugin fills

| Export | Seam | What it answers |
| --- | --- | --- |
| `packageJsonManifest` | `ManifestProvider` | What a package's name, version and dependencies are; `publishedVersion` (`npm view`) and `stampVersion`. Its `name` is `'node'`, which is what `Package.provider` reports. |
| `npmWorkspace` | `Workspace.Provider` | Which directories are packages - `workspaces` in the root `package.json`. |
| `packageJsonSteps` | `RunService.StepSource` | A script a package declares in `package.json#scripts`, including the `pre<script>`/`<script>`/`post<script>` shape - which is also how npm's `preversion`/`version`/`postversion` reach `version`'s own lifecycle, with no second seam. |
| `nodeVersionPlanner` / `NodeVersionPlanService` | `VersionPlanService` | Where a boundary comes from when a package has no release tag, and how far a bump cascades. `VersionPlanService` is abstract, so `version`/`changed` have nothing to ask without this. |
| `npmBinPaths` | `BinPath.Provider` | `node_modules/.bin`, walked up the directory chain, so a repository's pinned `eslint`/`tsc` is what a `run` step actually executes. |

`DEPENDENCY_KEYS` is the list those readers use: `dependencies`, `devDependencies`,
`peerDependencies`, `optionalDependencies`.

Each has a matching `augment*()` that registers it. They are also declared on `nodePlugin`, so a
repository naming this package in `plugins` needs no import side effect:

```ts
export const nodePlugin = definePlugin({
  name: 'rman-node',
  commands: [publishCommand.command, ciCommand.command, cleanCommand.command],
  runSteps: packageJsonSteps,
  workspace: npmWorkspace,
  manifest: packageJsonManifest,
  versionPlanner: nodeVersionPlanner,
  binPaths: npmBinPaths,
});

/** What the entry point actually default-exports. */
export default defineConfig({ plugins: [nodePlugin] });
```

**The default export is an `.rmanrc` config, not the plugin** - which is what a package naming
itself in `plugins` hands over. Exposing exactly one plugin was the shape of the plugin this package
happens to contain today; adding a second would have changed what every repository importing it
receives. As a config it is the same kind of thing as the file that names it. Only its `plugins` are
read - config keys reach a repository through `extends`. `nodePlugin` is exported by name for code
registering it directly.

**One caveat about the `workspace` seam, and it is a real limitation:** `Workspace.resolve` takes the
first provider that answers, so in a polyglot repository the ecosystem listed first in `plugins`
decides which directories are packages at all. Per-package *identity* is polyglot
(`Package.provider`); per-repository *discovery* is not yet.

## `"workspace:"` ranges

The `"workspace:"` protocol is a statement about a `package.json` dependency field, so it lives here
rather than in the core - which never read it:

```ts
interface ParsedWorkspaceRange {
  selector: '*' | '^' | '~' | 'explicit';
  range?: string; // only when selector === 'explicit'
}

function parseWorkspaceRange(value: unknown): ParsedWorkspaceRange | undefined;
function resolveWorkspaceRange(parsed: ParsedWorkspaceRange, version: string): string;
```

| Declared | `selector` | Published as |
| --- | --- | --- |
| `workspace:*` | `'*'` | the dependency's exact current version, no operator |
| `workspace:^` / `workspace:~` | `'^'` / `'~'` | that operator + the version |
| `workspace:^1.0.0`, `workspace:1.0.0` | `'explicit'` | the range verbatim, prefix stripped |

`parseWorkspaceRange` returns `undefined` when the value is not a workspace range at all - a plain
semver range, or not a string.

The same substitution pnpm and yarn perform in their own `publish`.

## Commands

Their CLI reference lives with the others: [`publish`](cli/publish.md), [`ci`](cli/ci.md),
[`clean`](cli/clean.md). Docker publishing is **not** here - an image is any language's to publish,
so `publish --target docker` and `DockerPublishService` are the core's
([rman.md#dockerpublishservice](rman.md#dockerpublishservice)). What is still wrong is that this
plugin owns the `publish` *command* that drives it, so a non-Node repository has to install this
package to reach Docker publishing. Fixing that means making a publish target something a plugin
contributes to a core `publish`.
