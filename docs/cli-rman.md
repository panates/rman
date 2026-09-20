<!--
docs-baseline
git-commit: b6924c69810870582f615a81c97b587e4057910d
package-version: 1.0.3
date: 2026-09-13

Verified against `packages/rman/src/cli.ts` and every `packages/rman/src/commands/*.command.ts` as
of the commit above (and the matching specs for behavior examples). `rman-node`'s three commands
have their own index, [cli-node.md](cli-node.md). Before trusting/updating this file (or any page
under `docs/cli/`) in a later session, run:

  git diff b6924c69810870582f615a81c97b587e4057910d..HEAD -- packages/rman/src/cli.ts packages/rman/src/commands/

and update only the pages touched by what that diff actually shows - don't regenerate everything
unless the diff is broad enough to warrant it. Once verified again, bump `git-commit`/
`package-version`/`date` here and in every `docs/cli/*.md` page's own baseline comment.
-->

# rman CLI Reference

`rman` is a single binary with one subcommand per operation. This page is the index for the
commands **rman itself** ships; every command has its own detailed page under
[`docs/cli/`](cli/) with its full option list, defaults, and worked examples. For a fast-start
overview instead, see the [rman README](../packages/rman/README.md#commands). For the underlying programmatic API each
command calls, see [docs/rman.md](rman.md).

```bash
rman <command> [options...]
rman <command> --help   # full option list for that one command
```

## Commands

| Command | Page | Purpose |
| --- | --- | --- |
| `list` (`ls`) | [`docs/cli/list.md`](cli/list.md) | Lists packages in the repository. |
| `info` | [`docs/cli/info.md`](cli/info.md) | Prints local environment and repository information. |
| `run <script>` | [`docs/cli/run.md`](cli/run.md) | Runs an npm script in each package. |
| `build` | [`docs/cli/build.md`](cli/build.md) | Alias for `run build`. |
| `test` | [`docs/cli/test.md`](cli/test.md) | Alias for `run test`. |
| `exec [command..]` | [`docs/cli/exec.md`](cli/exec.md) | Runs an arbitrary shell command in each package. |
| `config` | [`docs/cli/config.md`](cli/config.md) | Prints the effective `.rmanrc` config for the current directory's package. |
| `changed` | [`docs/cli/changed.md`](cli/changed.md) | Shows which packages the next `version` run would bump. |
| `diff [package]` | [`docs/cli/diff.md`](cli/diff.md) | Shows the git diff since a package's (or the repo's) last release tag. |
| `changelog` | [`docs/cli/changelog.md`](cli/changelog.md) | Generates a changelog per package from unreleased commits. |
| `version [bump]` | [`docs/cli/version.md`](cli/version.md) | Bumps versions of changed packages (and their dependents). |
| `publish` | [`docs/cli/publish.md`](cli/publish.md) | Publishes every package whose version isn't on its registry yet. |
| `github-release` | [`docs/cli/github-release.md`](cli/github-release.md) | Creates the repository's GitHub Release for the version that just shipped. |
| `import <path>` | [`docs/cli/import.md`](cli/import.md) | Imports an external git repository as a new package, with history. |

**`ci` and `clean` are not in that list** - they come from [`rman-node`](cli-node.md), because each
is about npm or TypeScript rather than about repositories.

**`publish` is, and its flags still are not fixed.** The command is rman's; *where a package ships*
is a **publish target**, which a plugin contributes. rman itself brings `docker` - any language's
project can push an image - and `rman-node` brings `npm`. Each target adds its own flags to
`rman publish`, so `rman publish --help` lists exactly the ones the targets this repository
installed actually understand. See [Publish targets](cli/publish.md#publish-targets).

## Where a command comes from

**The command set is not fixed, and `rman --help` in one repository is not `rman --help` in
another.** Three sources, and it is worth knowing which one you are looking at before reporting that
a command "doesn't exist":

| Source | Declared by | Scope |
| --- | --- | --- |
| **Built in** | nothing - always there | every repository |
| **A plugin** | `.rmanrc "plugins"` | every repository naming that package |
| **The repository's own** | a module in `.rman/*.mjs` | this repository only |

### A plugin

A plugin is an ordinary package that contributes commands (and more - see
[docs/node.md](node.md) for what else). Name it and its commands appear:

```yaml
# .rmanrc.yml
plugins: ['rman-node']
```

Without it, `rman clean` is `Unknown argument: clean`. A plugin that cannot be *loaded* is an error
rather than a skip: silently losing `rman publish` is worse than not starting.

**A plugin package exports an `.rmanrc` config, not a single plugin** - its entry point ends with
`export default defineConfig({ plugins: [ ... ] })`, and rman reads that config's own `plugins`.
That is what keeps a package free to carry a second plugin later without changing what every
repository importing it receives. Only `plugins` is read out of it; a config's other keys reach a
repository through `extends`, the key that means "merge this underneath mine". A module exporting
the plugin object itself is refused, with a message saying where to put it - accepting both shapes
would mean telling them apart at runtime, and `name` is a key either may have.

**An entry may also be the plugin object itself**, which is how a JS config declares one without a
package:

```js
// .rmanrc.mjs
import { defineConfig, definePlugin } from 'rman';

export default defineConfig({
  plugins: [
    'rman-node',
    definePlugin({ name: 'mine', commands: [/* ... */] }),
  ],
});
```

**`plugins` always appends - there is no `+plugins` to write.** Every other key lets a closer layer
overrule the value; a plugin *adds* commands and seams, and a repository naming one never means
"and drop the ones my shared config brought". That used to be a replacement, and the way you found
out was `Unknown argument: publish`. An entry already in the list is not repeated, and a plugin
named by two layers is registered once.

**A plugin can arrive through `extends`, and that is the point of the combination.** `extends` names
configs merged underneath the file naming them, so a shared config package can carry the whole
toolchain - the plugin *and* the settings for it - and a repository writes one line:

```json
// .rmanrc - nothing else
{ "extends": "@myorg/rman-config" }
```

```json
// node_modules/@myorg/rman-config/index.json
{ "plugins": ["rman-node"], "[*]": { "clean": { "include": "build" } } }
```

Measured end to end: with only that `extends`, `rman clean --dry-run` runs and `rman list` finds the
workspace packages - so an inherited `plugins` brings the commands **and** the seams (the manifest
reader, the workspace provider) with it. `plugins` is read off the root's config once, before the
packages are known, which is why it is a root-level key and why a `plugins` entry in a package's own
`.rmanrc` is never read.

### The repository's own (`.rman/*.mjs`)

A module in `.rman/` becomes `rman <its file name>`, built with `defineCommand` - for one
repository-level operation with logic of its own. Full reference:
[docs/cli/custom-commands.md](cli/custom-commands.md).

```js
// .rman/hello.mjs
import { defineCommand } from 'rman';

export default defineCommand({
  describe: 'a repository-owned command',
  handler: ctx => ctx.logger.info(`hello from ${ctx.repository.rootPackage.name}`),
});
```

A broken module **warns and is skipped** - it affects only itself, and the message names the file
and the reason (`Skipped ".rman/hello.mjs": Cannot find package 'rman'...` when `rman` is not
installed where the module can resolve it).

### Precedence when two sources use one name

| Clash | What happens |
| --- | --- |
| `.rman/*.mjs` vs a **plugin's** command | the repository wins, silently - it is the more specific statement, the same way its own `.rmanrc` overrides an `extends` base |
| `.rman/*.mjs` vs a **built-in** | refused outright: `".rman/version.mjs" would shadow rman's built-in "version" command.` Rename the file, or give it its own name with `command: '<name>'` |
| a **plugin** vs a **built-in** | refused outright, same check |

So a repository can replace a plugin's `clean` with its own and never be told - which is the
intended escape hatch, not an oversight. Nothing can replace a built-in.

## Global options

These apply to every command, before the command name:

| Option | Alias | Description |
| --- | --- | --- |
| `--help` | `-h` | Shows help - `--help` for the whole CLI, `<command> --help` for one command's full option list. |
| `--version` | `-v` | Prints the installed `rman` version. |
| `--log-level <level>` | - | Default verbosity of the per-step log for `run`/`build`/`test`/`ci` (`silent`\|`error`\|`info`\|`verbose`). Default `info`, or `.rmanrc "logLevel"`. Per-package overridable via `.rmanrc run.<script>.logLevel`. Only affects the *classic* one-line-per-step log - it has no effect on the live progress panel's own output. |
| `--config` | - | Print what this command would run with, and **run nothing**. See below. |

### `--config`: what would this command run with?

Any command, `--config` anywhere in the line. Nothing is executed:

```bash
$ rman build --config --parallel 2
# build --config: nothing was run.
command: build
options:
  parallel: 2
packages: [pkg-a]
# .rmanrc, the keys build reads: run.build
  pkg-a:
    run.build:
      exec: tsc -b tsconfig-build.json
      after: node ../../support/postbuild.cjs
  root: {}
# "root" is the root - listed because repo-wide keys are read there.
```

Three sections, answering the three ways a run surprises someone:

- **`options`** is the parsed argv - what *this invocation* asked for. Most of rman's defaults are
  not CLI defaults (`bail`, `topo`, `progress` are resolved per package from
  `.rmanrc run.<script>.*`), so an option missing here means "not stated on the command line", and
  the `.rmanrc` section is where its value comes from.
- **`packages`** is the set the command would act on, computed the way the command computes it -
  after `--scope`/`--ignore`/`--deps`/`--dependents` and `.rmanrc "skip"`. A config that is perfect
  for a package the command never reaches explains nothing.
- **`.rmanrc`** is narrowed to the keys that command reads (`run.build` above), and is the whole
  effective config for a command that declares none. The **root package is always listed**, because
  a repo-wide key (`packageManager`, `allowBranch`, `version.*`, `githubRelease.*`) is read there.

It reaches **every** command - built-in, a plugin's, and a repository's own `.rman/*.mjs` - because
it is applied once where commands are registered rather than declared per command. A command names
its own keys with `configKeys` (see
[custom-commands.md](cli/custom-commands.md#declaring-what-config-the-command-reads)).

For the effective config of a package without reference to any command, use
[`rman config`](cli/config.md).

Shell completion is also available (`program.completion()` under the hood, from yargs) -
`rman completion` prints a script to `source` for your shell.

A misspelled command name (e.g. `rman versoin`) gets a `Did you mean version?` suggestion
(`program.recommendCommands()`, from yargs).

## Command scope: repository root vs. current package

Several commands (`run`/`build`/`test`, `exec`, `changelog`, `diff`, `config`, and `rman-node`'s
`clean`)
automatically scope themselves to *just the package you're standing in* when your shell's current
directory is inside one package's own directory (rather than the repository root) - pass
`--root`/`-r` to force the whole repository anyway. This has no effect when you're already at the
repository root, or your current directory isn't inside any known package (e.g. a plain
single-package repo).

`version`, `publish`, `list` and `changed` already work across the whole repository, so they
deliberately have **no** `--root`: a flag that does nothing reads as a promise.

## Shared option groups

Three groups are shared verbatim (same flags, same behavior) rather than being redefined per
command - a plugin's own commands use the same ones, which is why `clean` and `publish` accept them
too.

### `skip`

`.rmanrc "skip": true` on a package means "leave this one alone", and every command that *acts* on
packages honours it - `run`/`build`/`test`, `exec`, `version`, `changelog`, plus `clean` and
`publish`. `list` deliberately ignores it: it reports on the repository rather than acting on it,
and an inventory hiding part of it answers a different question than the one asked. A skipped
package is dropped **before** `--deps`/`--dependents`, so a dependency edge cannot drag it back in.

### Package filtering

`list`, `run`/`build`/`test`, `exec`, `version`, `changelog` - and a plugin's commands - all accept:

| Option | Description |
| --- | --- |
| `--scope <glob>` | Only include packages whose name matches this glob (repeatable). |
| `--ignore <glob>` | Exclude packages whose name matches this glob (repeatable) - applied after `--scope`. |
| `--deps` | Also include every package the matched set depends on (transitively). |
| `--dependents` | Also include every package that depends on the matched set (transitively). |

```bash
rman run build --scope '@myorg/*' --ignore '*-internal'
rman test --scope core-lib --dependents   # core-lib plus everything that could be affected by it
```

Full semantics (glob syntax, how `--deps`/`--dependents` combine): see
[docs/rman.md#package-filtering-scopeignoredepsdependents](rman.md#package-filtering-scopeignoredepsdependents).

### Branch guard

Every command that mutates state or runs scripts - `run`/`build`/`test`, `exec`, `version`, and
`rman-node`'s `ci`/`clean`/`publish` - additionally accepts:

| Option | Description |
| --- | --- |
| `--allow-branch <glob>` | Refuse to run unless the current branch matches this glob (repeatable). Default: `.rmanrc "allowBranch"`, or no restriction. |
| `--ignore-branch <glob>` | Refuse to run if the current branch matches this glob (repeatable). Default: `.rmanrc "ignoreBranch"`, or no restriction. |

```bash
rman version --allow-branch main    # refuse to version anywhere but main
rman publish --ignore-branch 'feature/*'
```

An explicit CLI `--allow-branch`/`--ignore-branch` **replaces** the equivalent root `.rmanrc` key
entirely (they never combine, the same precedence `packageManager` uses). With neither set
anywhere, every branch is allowed. A detached `HEAD`, or a directory that isn't a git repository at
all, is never blocked. Read-only/non-branch-sensitive commands (`list`, `changed`, `diff`, `info`,
`changelog`, `import`) deliberately do **not** have this guard.

## Exit codes and the `logged` convention

Every command exits `1` on failure, `0` on success. Internally, a failure that's already printed
its own colored error message sets an internal `.logged` marker so the top-level handler doesn't
print a second, redundant generic error - this is invisible from the CLI itself (you'll never see
a doubled error), but worth knowing if you're piping `rman`'s output or wrapping it in your own
tooling and only ever see *one* error line per failure.

## Configuration

Every command above reads its cascaded `.rmanrc`/`.rmanrc.yml` config the same way - see
[docs/rman.md#configuration-rmanrc--rmanrcyml](rman.md#configuration-rmanrc--rmanrcyml) for the complete
key reference, merge order, and cascade rules.
