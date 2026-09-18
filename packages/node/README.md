# rman-node

Node.js support for [rman](https://github.com/panates/rman).

rman's core is about repositories - packages, versions, changelogs, releases, branches. Anything
that only means something because the repository happens to be a Node one lives here, so the core
stays usable by a repository in any language.

Full API reference: **[docs/node.md](https://github.com/panates/rman/blob/main/docs/node.md)**.

## Install

```bash
npm i -D rman-node
```

```yaml
# .rmanrc.yml
plugins: ['rman-node']
```

A plugin that cannot be loaded is an error, not a skip: silently losing `rman publish` is worse
than not starting.

## Commands

These three commands do not exist without this package - `rman clean` is `Unknown argument: clean`
in a repository that names no plugin.

### `rman publish`

Publishes every package to its configured registry - `npm` by default, or whatever each package's
own `.rmanrc "publish.target"` says (`"npm"`, `"docker"`, or both). Each target decides for itself
whether the current version is already out there: `npm view` on the npm side, `docker manifest
inspect` on the docker side.

```bash
rman publish                              # show the plan, then ask for confirmation
rman publish --yes                        # publish immediately, no confirmation
rman publish --dry-run                    # only show the plan, never publish
rman publish --access public              # required for a new scoped package
rman publish --tag next
rman publish --otp 123456
rman publish --registry https://registry.example.com --userconfig ./ci.npmrc
rman publish --package-manager pnpm
rman publish --target docker              # only the packages configured for the "docker" target
```

A `"workspace:*"`/`"workspace:^"`/`"workspace:~"` dependency range is automatically rewritten to a
real, registry-consumable range immediately before each package's publish, and restored right
after - see [docs/node.md#publishservice](https://github.com/panates/rman/blob/main/docs/node.md#publishservice).

A package opts into building/pushing a Docker image via `.rmanrc "publish.target": ["docker"]` plus
a `"publish.docker"` block (`image`, `platforms`, `buildContexts`, `buildArgs`, ...) - see
[docs/cli/publish.md](https://github.com/panates/rman/blob/main/docs/cli/publish.md#docker-publishing-publishdocker).

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

Every one of its built-in behaviours is a **TypeScript** fact, which is why it is here and not in
the core: nothing in it would fire for a Cargo or Go repository, and both ship a `clean` of their
own. A `.d.ts` with no matching `.ts` beside it is left alone - that is a hand-written declaration,
not build output.

## Config keys

Three `.rmanrc` keys come from this package, and they reach rman's own `RmanConfig` type by
declaration merging - so `pkg.config.clean` is typed where it is read, with no cast:

| Key | Level | |
| --- | --- | --- |
| `packageManager` | root only | Which package manager `ci`/`publish` shell out to, and whose version `info` reports. Default `npm`. |
| `clean` | per package | `include`/`exclude` globs beyond TypeScript's own output, plus `skip`. |
| `publish.directory` | per package | Where this package's publishable output lives, relative to its own directory. |

`RmanNodeConfig` is the name a config author annotates with, and importing its `defineConfig` is
what carries the augmentation:

```js
// .rmanrc.mjs
import { defineConfig } from 'rman-node';

export default defineConfig({
  plugins: ['rman-node'],
  packageManager: 'pnpm',
  '[*]': { clean: { include: 'build' }, publish: { directory: 'build' } },
});
```

The JSON and YAML forms of the config carry no type - rman ships no JSON Schema, because a schema
cannot describe keys a plugin contributes. See
[docs/rman.md#editor-support-types](https://github.com/panates/rman/blob/main/docs/rman.md#editor-support-types).

## Seams and augmentations

Beyond the commands, this package answers the questions rman's core deliberately has no answer to:
what a package *is* (`package.json`), which directories are packages (`workspaces`), how a version
is planned, what `pre<script>`/`post<script>` mean, and that `node_modules/.bin` belongs on a child
process's PATH. Without it a repository has **no manifest reader at all** - which is the point:
another ecosystem supplies its own through the same seams rather than working around npm's.

Some core behaviour is neutral by default and this package turns it on, because installing it is
itself the statement that the repository is a Node one.

**`SystemInfo`** (`rman info`): the core service asks about a package manager only when told to - a
repository in another language reporting "npm: Not Found" is a wrong answer, not a missing feature.
This package makes npm the default and adds its own version to the report:

```
# without the plugin          # with it
 Binaries:                     Binaries:
    Node : 24.15.0                Node       : 24.15.0
                                  npm        : 11.12.1
                               npmPackages:
                                  rman-node : ...
                                  rman       : ...
```

`.rmanrc "packageManager"` still decides *which* one; the augmentation only decides that there is
one at all.

## Not here

**Docker publishing stayed in the core** - any language's project can publish an image. What is
still wrong is that `publish` is what *drives* it, so a non-Node repository has to install this
plugin to reach `publish --target docker`. Fixing that means making a publish target something a
plugin contributes to a core `publish`.

## Licence

MIT
