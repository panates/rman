<!--
docs-baseline
git-commit: b6924c69810870582f615a81c97b587e4057910d
package-version: 1.0.3
date: 2026-09-13

Verified against `src/cli.ts` and every `src/commands/*.command.ts` as of the commit above (and
`test/cli.spec.ts` / `test/commands/*.command.spec.ts` for behavior examples). Before trusting/
updating this file (or any page under `docs/cli/`) in a later session, run:

  git diff b6924c69810870582f615a81c97b587e4057910d..HEAD -- src/cli.ts src/commands/

and update only the pages touched by what that diff actually shows - don't regenerate everything
unless the diff is broad enough to warrant it. Once verified again, bump `git-commit`/
`package-version`/`date` here and in every `docs/cli/*.md` page's own baseline comment.
-->

# rman CLI Reference

`rman` is a single binary with one subcommand per operation. This page is the index; every command
has its own detailed page under [`docs/cli/`](cli/) with its full option list, defaults, and
worked examples. For a fast-start overview instead, see the [README](../README.md#commands). For
the underlying programmatic API each command calls, see [docs/api.md](api.md).

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
| `ci` | [`docs/cli/ci.md`](cli/ci.md) | Deletes `node_modules`/lockfiles everywhere, then reinstalls from scratch. |
| `clean` | [`docs/cli/clean.md`](cli/clean.md) | Removes compiled TypeScript output and configured extra files/dirs. |
| `changed` | [`docs/cli/changed.md`](cli/changed.md) | Shows which packages the next `version` run would bump. |
| `diff [package]` | [`docs/cli/diff.md`](cli/diff.md) | Shows the git diff since a package's (or the repo's) last release tag. |
| `changelog` | [`docs/cli/changelog.md`](cli/changelog.md) | Generates a changelog per package from unreleased commits. |
| `version [bump]` | [`docs/cli/version.md`](cli/version.md) | Bumps versions of changed packages (and their dependents). |
| `publish` | [`docs/cli/publish.md`](cli/publish.md) | Publishes every package to its configured target(s) - npm and/or Docker. |
| `import <path>` | [`docs/cli/import.md`](cli/import.md) | Imports an external git repository as a new package, with history. |

## Global options

These apply to every command, before the command name:

| Option | Alias | Description |
| --- | --- | --- |
| `--help` | `-h` | Shows help - `--help` for the whole CLI, `<command> --help` for one command's full option list. |
| `--version` | `-v` | Prints the installed `rman` version. |
| `--log-level <level>` | - | Default verbosity of the per-step log for `run`/`build`/`test`/`ci` (`silent`\|`error`\|`info`\|`verbose`). Default `info`, or `.rmanrc "logLevel"`. Per-package overridable via `.rmanrc run.<script>.logLevel`. Only affects the *classic* one-line-per-step log - it has no effect on the live progress panel's own output. |

Shell completion is also available (`program.completion()` under the hood, from yargs) -
`rman completion` prints a script to `source` for your shell.

A misspelled command name (e.g. `rman versoin`) gets a `Did you mean version?` suggestion
(`program.recommendCommands()`, from yargs).

## Command scope: repository root vs. current package

Several commands (`run`/`build`/`test`, `exec`, `clean`, `changelog`) automatically scope
themselves to *just the package you're standing in* when your shell's current directory is inside
one package's own directory (rather than the repository root) - pass `--root`/`-r` to force the
whole repository anyway. This has no effect when you're already at the repository root, or your
current directory isn't inside any known package (e.g. a plain single-package repo).

## Shared option groups

Two option groups are shared verbatim (same flags, same behavior) across every command that needs
them, rather than being redefined per command:

### Package filtering

`list`, `run`/`build`/`test`, `exec`, `ci`, `clean`, `version`, `publish`, `changelog` all accept:

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
[docs/api.md#package-filtering-scopeignoredepsdependents](api.md#package-filtering-scopeignoredepsdependents).

### Branch guard

Every command that mutates state or runs scripts - `run`/`build`/`test`, `exec`, `ci`, `clean`,
`version`, `publish` - additionally accepts:

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
[docs/api.md#configuration-rmanrc-rmanrcyml](api.md#configuration-rmanrc-rmanrcyml) for the complete
key reference, merge order, and cascade rules.
