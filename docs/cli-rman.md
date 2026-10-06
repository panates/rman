<!--
docs-baseline
git-commit: f20556f
package-version: 2.0.0-beta.4
date: 2026-09-28

Verified against `packages/rman/src/cli.ts`, every `packages/rman/src/commands/*.command.ts` and
the `node` built-in's own commands as of the commit above (and the matching specs for behavior
examples). There is no second index: `rman-node` was folded into rman, so every command a
repository can run is listed here. Before trusting/updating this file (or any page under
`docs/cli/`) in a later session, run:

  git diff f20556f..HEAD -- packages/rman/src/cli.ts packages/rman/src/commands/ packages/rman/src/builtins/

and update only the pages touched by what that diff actually shows - don't regenerate everything
unless the diff is broad enough to warrant it. Once verified again, bump `git-commit`/
`package-version`/`date` above.

The `docs/cli/*.md` pages carry no baseline of their own - this block covers them, since they are
verified from the same diff. (It used to say to bump theirs too; none has ever had one.)
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
| `diff [package]` | [`docs/cli/diff.md`](cli/diff.md) | Shows the git diff since a package's (or the repo's) last release tag. |
| `changelog` | [`docs/cli/changelog.md`](cli/changelog.md) | Generates a changelog per package from unreleased commits. |
| `version [bump]` | [`docs/cli/version.md`](cli/version.md) | Bumps versions of changed packages (and their dependents). |
| `publish` | [`docs/cli/publish.md`](cli/publish.md) | Publishes every package whose version isn't on its registry yet. |
| `deps [names..]` | [`docs/cli/deps.md`](cli/deps.md) | Lists the dependencies that have a newer version; `-u` upgrades them. |
| `github-release` | [`docs/cli/github-release.md`](cli/github-release.md) | Creates the repository's GitHub Release for the version that just shipped. |
| `import <path>` | [`docs/cli/import.md`](cli/import.md) | Imports an external git repository as a new package, with history. |

**`ci` and `clean` are listed apart** - they come from the
[`node` built-in](rman.md#the-node-built-in), because each is about npm or TypeScript rather than
about repositories. It ships *inside* rman **and is laid under every repository by default**, so
they are there in a clone with no `.rmanrc` at all:

| `ci` | [`docs/cli/ci.md`](cli/ci.md) | Wipes `node_modules` and lockfiles, then reinstalls from scratch. |
| `clean` | [`docs/cli/clean.md`](cli/clean.md) | Removes compiled TypeScript output and whatever `.rmanrc "clean"` lists. |

They are still a *contribution* rather than core, which is the thing to hold onto: a repository of
another technology carries them without them meaning anything to it, and that cost is the price of
the default. Measured in a directory holding nothing but a `.git` and an empty `.rmanrc`:
`rman --help` lists `clean`, `ci` and `publish`.

**`publish` is, and its flags still are not fixed.** The command is rman's; *where a package ships*
is a **publish target**, which a plugin contributes. rman itself brings `docker` - any language's
project can push an image - and the `node` built-in brings `npm`. Each target adds its own flags to
`rman publish`, so `rman publish --help` lists exactly the ones the targets this repository
installed actually understand. See [Publish targets](cli/publish.md#publish-targets).

## Where a command comes from

**The command set is not fixed, and `rman --help` in one repository is not `rman --help` in
another.** Three sources, and it is worth knowing which one you are looking at before reporting that
a command "doesn't exist":

| Source | Declared by | Scope |
| --- | --- | --- |
| **Built in** | nothing - always there | every repository |
| **A platform** | `.rmanrc "plugins"` or `"platform"` | every repository naming that technology |
| **The repository's own** | a module matching `.rmanrc "commands"`, which defaults to `.rman/*.mjs` | this repository only |

`commands` takes a glob or a list of them, always appends, and anchors a relative glob to the file
that declared it - so a shared config can ship commands without wrapping them in a plugin. See
[custom-commands.md](cli/custom-commands.md#where-rman-looks-rmanrc-commands).

### A plugin

A plugin is an ordinary package that contributes commands - and more: a technology, its publish
targets, its config keys. A **published** one exports an rman *config*, so the repository inherits
it:

```yaml
# .rmanrc.yml
extends: 'rman-cargo'
```

`extends`, not `plugins` - `plugins` takes the technologies themselves, not a package name, and
writing one there is refused naming this as the fix.

**A built-in needs neither**, because rman lays its own `node` preset under every repository root.
`clean` and `ci` are there in a clone with no `.rmanrc` at all, and so is the `npm` publish target.
`extends: 'rman:node'` is the explicit spelling, and only matters for saying it *again* beside
another technology:

```yaml
extends: ['rman:node', 'rman:cargo']
```

`plugins: ['node']` is **not** that spelling and is refused - see above. The key that names a
technology for a *directory* is `platform:`, and it loads nothing on its own:

```yaml
platform: node      # which technology claims this directory, overriding the manifest question
```

A plugin that cannot be *loaded* is an error rather than a skip: silently losing a command the
repository is built around is worse than not starting.

**A package declares a command the way a built-in does** - `declareCommand(app => ({ ... }))`, with
its options as data rather than a hand-written `builder`, and puts it in its config's `commands`:

```js
import { declareCommand, defineConfig, packageFilterOptions } from 'rman';

const deploy = declareCommand(app => ({
  command: 'deploy [stage]',
  describe: 'Ships the current versions',
  config: { ...packageFilterOptions, wait: { target: 'cli', describe: 'block until healthy', type: 'boolean' } },
  configKeys: ['publish'],
  handler: async args => { /* app.repository is available here */ },
}));

export default defineConfig({ commands: [deploy] });
```

**No plugin is involved, and that is the change 2.0 made.** A plugin is one *technology* - a
manifest reader, a workspace provider, a version planner - and a command is not one, so a package
that only ships commands declares them and needs nothing else. The registration step this replaces
(`ctx.addCommand`, on a `PluginContext`) is gone.

`declareCommand`, not the `registerCommand` rman's own commands use: that one pushes onto a registry
every run walks, so a package using it would give its commands to repositories that never named it.
The factory is called once the repository exists - `app.repository` throws while the config is being
read, since plugins are what find the packages.

**A package's entry point exports an `.rmanrc` config**, and a repository inherits it with
`extends`:

```yaml
extends: 'rman-cargo' # its platforms, commands and publish targets all arrive
```

`plugins: ['rman-cargo']` is **refused**, naming the fix: that key takes a plugin or a glob naming
modules that export one, never a package name. The two are different statements - `extends` inherits
everything the package declares, while `plugins` names the technologies themselves.

**An entry may be the plugin object itself**, which is how a JS config declares one without
publishing a package:

```js
// .rmanrc.mjs
import { defineConfig, definePlatform, definePlugin } from 'rman';

export default defineConfig({
  // a *technology* is `platforms`, and `manifestProvider` is what makes it one
  platforms: [definePlatform({ name: 'cargo', manifestProvider: cargoManifest })],
  // a *plugin* is a name and something to do at a stage
  plugins: [definePlugin({ name: 'audit', afterInitRepository({ repository }) { /* ... */ } })],
});
```

**or a glob**, which is what a YAML config has instead: `plugins: './plugins/*.js'`, anchored to the
file that declared it, each match exporting one as its default. A glob matching nothing is an error -
a plugin that does not load is not a plugin.

**`plugins` always appends.** Every other key lets a closer layer
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

```js
// node_modules/@myorg/rman-config/index.js - a JS config, so it can hold the instance itself
import { defineConfig } from 'rman';
import { CargoPlatform } from './cargo-platform.js';

export default defineConfig({
  platforms: [new CargoPlatform()],
  '[*]': { clean: { include: 'build' } },
});
```

A shared config holds the technology **itself**, not a package name - `platforms` and `plugins` both
take an instance or a glob naming modules that export one, which is why the package above is a JS
config rather than JSON. (`{ "plugins": ["rman-node"] }` is the shape this used to show, and it is
refused: a name is `extends`'s job.)

Measured end to end: with only that `extends`, `rman clean --dry-run` runs and `rman list` finds the
workspace packages - so an inherited config brings the commands **and** the seams (the manifest
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
| `.rman/*.mjs` vs a **plugin's** command | the repository wins - it is the more specific statement, the same way its own `.rmanrc` overrides an `extends` base. Said out loud at `--log-level verbose`, naming both files |
| `.rman/*.mjs` vs a **built-in** | refused outright: `".rman/version.mjs" would shadow rman's built-in "version" command.` Rename the file, or give it its own name with `command: '<name>'` |
| a **plugin** vs a **built-in** | refused outright, same check |

So a repository can replace a contributed `clean` with its own - the intended escape hatch, not an
oversight. Nothing can replace a built-in.

**Only one of the two is registered, and the note is why that is not a new trap.** Both used to be,
which cost the help output: measured, `rman --help` listed `deploy` twice, once with each
description, and nothing said which would run. Deduplicating *silently* would have been worse than
either - one row and no note leaves "my plugin's command does nothing" with no thread to pull - so
the loser is named at `verbose`. Not a warning: an override is a correct thing to do, and a
repository doing it on purpose should not be nagged on every invocation. The note reads
`--log-level` straight off argv, because commands are registered before parsing.

## Global options

These apply to every command, before the command name:

| Option | Alias | Description |
| --- | --- | --- |
| `--help` | `-h` | Shows help - `--help` for the whole CLI, `<command> --help` for one command's full option list. |
| `--version` | `-v` | Prints the installed `rman` version. |
| `--log-level <level>` | - | Default verbosity of the per-step log for `run`/`build`/`test`/`ci` (`silent`\|`error`\|`info`\|`verbose`). Default `info`, or `.rmanrc "logLevel"`. Per-package overridable via `.rmanrc run.<script>.logLevel`. Only affects the *classic* one-line-per-step log - it has no effect on the live progress panel's own output. |
| `--config` | - | Print what this command would run with, and **run nothing**. See below. |
| `--json` | - | Write the run's log to stdout as JSON Lines and nothing else - no panel, no status line, no prose. A command with its own JSON result (`list`, `version`, `publish`, `config`, `info`, `github-release`) prints that result instead, unchanged. See below. |
| `--log-file <path>` | - | Also write the run's log to this file - JSON Lines under `--json`, text otherwise. Relative to where rman was invoked. See below. |

### The run log: `--json` and `--log-file`

A run's log is one event per step start, per line a step printed, per step end, and one summary:

```bash
$ rman build --json
{"time":"…","event":"start","package":"pkg-a","step":"exec","command":"tsc -b"}
{"time":"…","event":"output","package":"pkg-a","stream":"stdout","line":"…"}
{"time":"…","event":"end","package":"pkg-a","step":"exec","status":"success","ms":874}
{"time":"…","event":"summary","succeeded":1,"failed":0,"skipped":0,"ms":912}
```

| `event` | Fields |
| --- | --- |
| `start` | `package`, `step` (`before`/`exec`/`after`, or a command's own step name), `command` |
| `output` | `package`, `stream` (`stdout`/`stderr`), `line` |
| `end` | `package`, `step`, `status` (`success`/`failed`), `ms`, and `error` on a failure |
| `summary` | `succeeded`, `failed`, `skipped`, `ms` |
| `message` | `level` (`info`/`error`), `message` - e.g. "nothing to run" |

Without `--json`, `--log-file` writes the same events as text, and the screen is unchanged:

```
2026-10-05T07:09:30.771Z [pkg-a] ▶ exec | tsc -b
2026-10-05T07:09:31.063Z [pkg-a] src/index.ts(3,1): error TS2304: …
2026-10-05T07:09:31.383Z [pkg-a] ✖ exec failed (612 ms)
2026-10-05T07:09:31.384Z 0 succeeded, 1 failed (640 ms)
```

- **Escape codes are removed** from every line, in both forms.
- **The file is replaced** on each run, and created only once something is written.
- **Which commands write a log**: those whose steps run through rman's scheduler - `run`, `build`,
  `test`, and a command using `forEachPackage`. Any other command given `--json` or `--log-file`
  says so on stderr and runs as usual.
- **A step that runs another `rman`** logs that child's own output as `output` lines; the child is
  not told about `--json`.

### The status line

Every command that does work runs under a live line on **stderr**, so a command that prints nothing
is still visibly running:

```
⠹ lint  my-repo  2.4s
✔ lint  3.6s
```

The spinner and the clock are redrawn in place, and the result line replaces them - with `✖` and the
elapsed time when the command fails, so a run that stops is never mistaken for one that hung.

Four cases are silent, and each is about not corrupting something:

- **A command whose output *is* its answer** - `config`, `list`, `info`, `diff`, `changelog`.
  `rman config` writes a loadable YAML document, and a line above it would make it unparseable.
- **`--json`**, so `rman version --json | jq` never receives prose and `rman build --json` writes
  nothing but events.
- **`--config`**, for the same reason.
- **`--log-level silent`**.

**stderr rather than stdout**, so `rman changelog > NOTES.md` leaves the notes alone in the file. And
**nothing is drawn when stderr is not a TTY** (CI, a pipe): the escape codes would be noise there,
while the result line still says how the run went and how long it took.

A command's own output is routed through the line rather than around it - while one is live,
`runBin` pipes the child instead of handing it the terminal, since a write underneath the block
would be erased by the next redraw. Colour survives that (`FORCE_COLOR`), so eslint's output looks
the same as it did.

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

Several commands (`run`/`build`/`test`, `exec`, `changelog`, `diff`, `config` and `clean`)
automatically scope themselves to *just the package you're standing in* when your shell's current
directory is inside one package's own directory (rather than the repository root) - pass
`--from-root`/`-r` to force the whole repository anyway. This has no effect when you're already
at the repository root, or your current directory isn't inside any known package (e.g. a plain
single-package repo).

`version`, `publish` and `list` already work across the whole repository, so they
deliberately have **no** `--from-root`: a flag that does nothing reads as a promise.

> **It was `--root`/`-r` through 1.x.** The name said the opposite of what the flag does - every
> reader spells it *ignore where I am standing*, i.e. the whole repository, while `--root` reads as
> "the root alone". `-r` is unchanged; the old long spelling is gone rather than aliased, so
> `rman run build --root` now fails with `Unknown argument: root`.
>
> There is deliberately no `--root-only` beside it. It would do nothing on `run`/`build`/`test` (the
> repository's package list holds the members only, and the root contributes just its `pre`/`post`
> bookends), mean the same thing as `--from-root` on `diff`, already be what `--from-root` does on
> `config`, and on `clean` it would be actively misleading - the root's own sweep recurses through
> every package directory, so a "root only" clean deletes *more* than a package-scoped one. Where
> the root genuinely is a candidate, [`--scope /`](#package-filtering) says so.

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

`list`, `run`/`build`/`test`, `exec`, `version`, `changelog`, `clean`, `ci`, `publish` - and a
plugin's commands - all accept:

| Option | Description |
| --- | --- |
| `--scope <glob>` | Only include packages whose **selector** matches this glob, or **`/`** for the repository's own root package (repeatable). |
| `--ignore <glob>` | Exclude packages matching this glob (or `/`) - applied after `--scope`. |
| `--platform <names>` | Only include packages of these platforms - `--platform=node,cargo`, or repeated. |
| `--deps` | Also include every package the matched set depends on (transitively). |
| `--dependents` | Also include every package that depends on the matched set (transitively). |

```bash
rman run build --scope '@myorg/*' --ignore '*-internal'
rman test --scope core-lib --dependents   # core-lib plus everything that could be affected by it
rman changelog --scope /                  # the root package's own entry, and nothing else
rman clean --ignore /                     # every member, skipping the root's own sweep
rman run build --platform node            # in a polyglot repository, the npm half of it
```

**`--scope` matches the *selector*, not the package name**, and they coincide wherever the
technology names its packages - which is every Node repository. A package having a name at all is an
ecosystem's promise rather than rman's, so a repository whose technology offers none assigns one
with `.rmanrc "name"`. See [`Package`](rman.md#package).

**`--platform` takes names, not globs**, and that is why a name no package here belongs to is an
**error** listing the ones that are - the value set is known, so a typo is something rman can see
rather than a silently empty result. Comma-separated values are split (a platform name is a short
identifier and cannot be ambiguous, where a scope glob is arbitrary text), and the comparison is
case-insensitive.

**`--scope /` is the root package, and it is not a glob.** The same `/` `.rmanrc`'s `"[/]"` block
uses, for the reason stated there: *a monorepo's root is never selected by name.* So a glob is never
offered a monorepo's root - `--scope '*'` means the members, `--scope /` means the root - which is
what stops `--scope '@myorg/*'` from quietly picking up a repository whose root package is called
`@myorg/monorepo`. That mattered most for `clean`, where the root's own sweep recurses through every
package directory.

**In a single-package repository a glob does reach the root**, because there it is the one package -
the repository's package list is just the root, so `--scope '*'` selecting nothing would be an empty
answer in a repository with exactly one thing to select. `--scope /` still selects it. This mirrors
`"[*]"` in a `.rmanrc` exactly, and deliberately: the two are one set.

It selects nothing where the root is not a candidate to begin with, which is most commands in a
monorepo: the repository's package list holds the workspace members only, so `list`, `run` and `exec`
have no root row to select, while `clean` and `changelog` put it in their candidate list on purpose.

Full semantics (glob syntax, how `--deps`/`--dependents` combine): see
[docs/rman.md#package-filtering-scopeignoreplatformdepsdependents](rman.md#package-filtering-scopeignoreplatformdepsdependents).

### Branch guard

Every command that mutates state or runs scripts - `run`/`build`/`test`, `exec`, `version`,
`publish`, `github-release`, `ci` and `clean` - additionally accepts:

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
all, is never blocked. Read-only/non-branch-sensitive commands (`list`, `diff`, `info`, `config`,
`changelog`, `import`) deliberately do **not** have this guard - `changelog` among them because it
only ever reads history and writes a file the repository already asked for.

## Exit codes and the `logged` convention

Every command exits `1` on failure, `0` on success. Internally, a failure that has already printed
its own coloured error sets a `.logged` marker so the top-level handler does not print a second,
generic one.

**An error *without* that marker is printed more than once, and this is a known defect rather than
a design.** yargs' own `.fail()` writes it and `runCli`'s catch writes it again, on different
streams. Measured on `rman version banana`: once on stdout and twice on stderr, three lines for one
mistake. Worth knowing if you pipe rman's output or wrap it - do not take a doubled message as
evidence that something new is wrong, and do not deduplicate by counting lines.

**A setup failure used to exit `0`**, which is worse than a doubled message and is fixed: `runCli`'s
top-level catch printed and swallowed, so `rman info` in a directory with no manifest reported
failure on stdout and success to the shell. It rethrows now and the entry point exits 1. Any new
throw path before `parseAsync` inherits that.

**`--version` and `--help` survive a repository that will not load**, deliberately: `rman -v` is
what you reach for when something is wrong, and a broken `.rmanrc` took it away.

- `-v`/`--version` is answered from argv **before the repository is touched** (measured: a config
  naming a plugin that cannot resolve still prints the version and exits 0).
- `-h`/`--help` genuinely needs the repository, since every command's registration closes over it
  and a plugin's commands *are* the repository's - so it degrades to the global options and says
  why the rest is missing, on **stderr**, leaving `rman --help | less` as just help.
- **Nothing else degrades.** An ordinary command in a broken repository still prints the reason and
  exits 1, or a broken repository would look like a working one.

## Configuration

Every command above reads its cascaded `.rmanrc`/`.rmanrc.yml` config the same way - see
[docs/rman.md#configuration-rmanrc--rmanrcyml](rman.md#configuration-rmanrc--rmanrcyml) for the complete
key reference, merge order, and cascade rules.
