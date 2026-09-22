<!--
docs-baseline
git-commit: PENDING
package-version: 2.0.0-beta.2
date: 2026-09-22

Verified against `packages/node/src/` as of the commit above. Before trusting/updating this file in
a later session, run:

  git diff PENDING..HEAD -- packages/node/src/

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
extends: 'rman-node'
```

**`extends`, not `plugins`.** This package's entry point exports an rman *config*, and `extends` is
how a config is inherited - `plugins: ['rman-node']` is refused, because that key takes a plugin or
a glob naming modules that export one, never a package name. The one line brings four kinds of
thing at once, and they are worth telling apart:

| | What it adds | The config key it arrives under |
| --- | --- | --- |
| **A technology** | what a package *is* (`package.json`), where packages are (`workspaces`), how a version is planned, what `pre<script>`/`post<script>` mean, `node_modules/.bin` on PATH | `plugins` |
| **Commands** | `ci`, `clean` | `commands` |
| **A publish target** | `npm` - its flags on `rman publish`, its registry check, and which packages are npm's by default | `publishTargets` |
| **Augmentations** | the npm half of `SystemInfo` (what `info` prints), and the `.rmanrc` keys below | not a key - `augment*()` at import, plus `declare module 'rman'` |

All three keys **append**, so inheriting this config never costs a repository the plugins, commands
or targets it declares itself.

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
- [Commands, and the `npm` publish target](#commands-and-the-npm-publish-target)

## Installation

```bash
npm install rman-node
```

ESM-only, requires **Node.js >= 20**, and takes `rman` itself as a peer. Everything below is
imported from the package root:

```ts
import { CiService, CleanService, NodeVersionPlanService, NPM_TARGET, NpmPublishTarget, PublishService } from 'rman-node';
import type { NodeConfigKeys, ParsedWorkspaceRange, RmanNodeConfig } from 'rman-node';
```

**That is the whole surface, and it is short on purpose.** The entry point exports what a *user*
needs; the plugin, the manifest reader, the workspace provider, the step source and the bin-path
walk are not among them, because nothing outside this package has anything to do with them by hand
- they arrive through the config. Its own specs reach them by their file paths rather than through
`index.ts`, which is what keeps this list from growing to serve the tests.

Pinned by [`docs-api.spec.ts`](../packages/node/test/docs-api.spec.ts), so a name removed from the
package fails to compile rather than going stale here.

## Config keys

Three `.rmanrc` keys only mean something because the repository is a Node one - and they reach
`RmanConfig` through **three different routes**, each chosen by who reads the key:

| Key | Level | Declared by | What it says |
| --- | --- | --- | --- |
| `packageManager` | root only | `NodeConfigKeys` | Which package manager `ci`/`publish` shell out to, and whose version `info` reports. `npm` \| `yarn` \| `pnpm` \| `bun`, default `npm`. **Here because no single command owns it** - `ci` and the `npm` target both read it. |
| `clean` | per package, cascaded | `clean.command.ts` | `include`/`exclude` globs beyond TypeScript's own output, and `skip`. A package declaring its own `clean` replaces the root's entirely for itself. A **command contribution**, like every built-in's own key. |
| `publish.npm.directory` | per package, cascaded | `NpmPublishTarget` | Where this package's publishable output lives, relative to its own directory. The target's own block, through the `PublishTargetConfigs` slot, beside the `docker` one rman itself declares. |

All three are typed where they are *read* - `CleanService` reaching `pkg.config.clean` needs no
cast. What differs is only who says so:

```ts
// packages/node/src/augmentation/rman.augmentation.ts
declare module 'rman' {
  /** The key no command owns. */
  interface RmanConfigKeys extends NodeConfigKeys {}

  /** `clean.*`, derived from the command's own option list - `skip` from `config`, `include`/
   *  `exclude` from `Extra`, since an option cannot say "a glob or a list of them". */
  namespace RmanConfig {
    interface CommandConfigs
      extends RmanConfig.CommandContribution<ReturnType<typeof cleanCommand>, CleanExtraKeys> {}
  }

  /** The publish target's block, through the slot rman's `publish` command exports for *any*
   *  target - so a target contributes its config keys the same way it contributes its flags. */
  interface PublishTargetConfigs {
    npm?: RmanNodeConfig.NpmPublishOptions;
  }
}
```

Every one of these keys is a **value**, so each may be written as a function instead - `clean.include`,
`clean.exclude`, `packageManager`, `publish.npm.directory`. A reader still gets the value, because
`pkg.config` is the resolved view; see
[two views of one config](rman.md#two-views-of-one-config).

**All three live in that one block, and that is forced rather than chosen.** A *second*
`declare module 'rman'` anywhere in this package silently disables the first - measured twice now,
the second time while moving `clean`: it left `SystemInfo.PackageManager` unresolved at four call
sites in a different file, with nothing pointing at the cause. rman's own commands declare their
contributions beside themselves because they augment a **module path**, which has no such limit; a
plugin augments a *package name* and gets one block.

`RmanNodeConfig` is the name a **config author** annotates with, and its `defineConfig` is the
import that carries that augmentation - explicit, rather than a side effect someone has to remember:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman-node';

export default defineConfig({
  extends: 'rman-node',
  packageManager: 'pnpm',
  '[*]': { clean: { include: 'build' }, publish: { npm: { directory: 'build' } } },
});
```

`.mjs`, not `.ts`: rman loads `.rmanrc.cjs`/`.mjs`/`.js` and no TypeScript form. The `.rmanrc` and
`.rmanrc.yml` forms carry no type at all - see
[rman.md#editor-support-types](rman.md#editor-support-types) for why there is no JSON Schema.

## Services

> The three below are still `namespace`s taking a `repository`, unlike rman's own services, which
> are classes reached through `app.getService(...)`. They are this package's, so the shape is this
> package's to change.

### `PublishService`

Computes and applies `npm publish` (or the equivalent for yarn/pnpm/bun) across every non-private
package whose local version isn't already on the registry.

**Reached through `NpmPublishTarget`, not directly, when `rman publish` runs** - this is the
implementation behind the `npm` [publish target](rman.md#publishtarget), and stays callable on its
own. See [Commands, and the `npm` publish target](#commands-and-the-npm-publish-target).

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

`getPlan` is deliberately decoupled from `VersionService` - it only ever asks whether the *current*
`package.json` version is on the registry (one `npm view <name> version versions --json` per
package, run concurrently), so it works equally well right after a version bump or standing alone in
a release pipeline that bumped days earlier. A `private: true` package, or one with `.rmanrc
"publish.skip"`, is always `'skip'`ped; a dirty package is `'error'` (aborts the plan) unless
`ignoreDirty` downgrades it to `'skip'`.

**The question is whether *this version* is published, not what `latest` points at**, and the two
part company as soon as a prerelease goes out under its own dist-tag: `latest` stays on the old
stable however many betas follow. `entry.registryVersion` still reports `latest`, because that is
what a reader wants to see; the status comes from the published `versions`.

**A prerelease publishes under its own identifier.** `2.0.0-beta.1` gets `beta`, recorded as the
entry's `distTag` and printed beside the package, and `applyPlan` publishes under the tag the plan
showed rather than working it out again. `npm publish` with no `--tag` writes `latest`, so a beta
published that way is what every plain `npm install <name>` resolves to from then on, and `npm
dist-tag` can only move it back after the people who installed in between already have it - one
forgotten flag with no clean undo, which is why it is not left to the caller.

`--tag` overrides the derived one. Two cases are errors instead, having nothing honest to derive:
an explicit `--tag latest` on a prerelease (the one thing deriving must not reach), and a
prerelease with no identifier to name - `2.0.0-1`, whose prerelease part is the number `1`. A
calendar version is not a preview, however semver reads its time part.

The identifier comes from `VersionScheme.prereleaseId`, beside `isPrerelease` - both questions are
the scheme's, so a repository numbering its versions some other way answers them its own way.

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
"publish.npm.directory"` (one `"[*]"` line for a repository instead of a copy in every `package.json`),
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

A plugin **is** one technology in rman 2.0 - the seams below are its own members rather than
separately registered providers, which is why they are not exported: there is nothing to register.

| `Plugin` member | What it answers |
| --- | --- |
| `name` | `'node'` - what `Package.provider` reports, and the key the registry de-duplicates by. |
| `manifestProvider` | What a package's name, version and dependencies are; `publishedVersion` (`npm view`) and `stampVersion`. Grouped rather than flattened, because nine members about one file read better as a named group. |
| `getWorkspace` | Which directories are packages - `workspaces` in the root `package.json`. |
| `getRunSteps` | A script a package declares in `package.json#scripts`, including the `pre<script>`/`<script>`/`post<script>` shape - which is also how npm's `preversion`/`version`/`postversion` reach `version`'s own lifecycle, with no second seam. A *query*, not a hook, which is why it is `get…` rather than `on…`. |
| `getBinPaths` | `node_modules/.bin`, walked up the directory chain, so a repository's pinned `eslint`/`tsc` is what a `run` step actually executes. |
| `versionPlanner` | Where a boundary comes from when a package has no release tag, and how far a bump cascades. `VersionPlanService` is abstract, so `version`/`changed` have nothing to ask without this. |

**They only mean anything together**, which is what the single type says: `getRunSteps` reads
`pkg.manifest.raw.scripts`, so contributing it without `manifestProvider` leaves it parsing whatever
another technology produced. The coupling was always real - `TechStack` and `RmanPlugin` were two
types until 2.0, with six independently registered seams, and declaring one without the others
type-checked.

```ts
// node-plugin.ts
export class NodePlugin implements Plugin {
  name = 'node';
  manifestProvider = new NodeManifestProvider();
  versionPlanner = new NodeVersionPlanService();
  getWorkspace(root: string) { /* reads `workspaces` */ }
  getRunSteps(pkg: Package, script: string) { /* reads package.json#scripts */ }
  getBinPaths(cwd: string) { /* node_modules/.bin, walked up */ }
}

// index.ts - what the entry point actually default-exports
export default defineConfig({
  plugins: [new NodePlugin()],
  commands: [ciCommand, cleanCommand],
  publishTargets: [new NpmPublishTarget()],
});
```

**The default export is an `.rmanrc` config, not the plugin**, and a repository inherits it with
`extends`. As a config it is the same kind of thing as the file that names it, and free to grow a
second plugin or another command without changing shape - which a package exporting exactly one
plugin could not do. `init` is still a `Plugin` member for anything the seams do not name; this
plugin needs none, because commands and targets are config keys.

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

## Commands, and the `npm` publish target

Two commands: [`ci`](cli/ci.md) and [`clean`](cli/clean.md), whose CLI reference lives with every
other command's.

**`publish` is not one of them.** The command is the core's
([`docs/cli/publish.md`](cli/publish.md)); what this package contributes is one
[publish target](rman.md#publishtarget) named `npm` - `NpmPublishTarget`, a thin adapter over
[`PublishService`](#publishservice):

- **its own flags** on `rman publish`: `--package-manager`, `--access`, `--tag`, `--otp`,
  `--registry`, `--userconfig`, `--contents`;
- **`claims`**: a package with no `publish.target` of its own ships to npm when this plugin is what
  read its manifest (`pkg.provider === 'node'`). Nothing else can state that, which is why the
  core's old hardcoded `['npm']` default reported npm for a Cargo package.

Docker publishing was always the core's - an image is any language's to publish - but until targets
became contributions, the only command that drove it was this plugin's, so a non-Node repository had
to install this package to reach a feature the core implemented. That is what the move fixed.
