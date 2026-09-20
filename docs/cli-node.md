<!--
docs-baseline
git-commit: 0ec1e88
package-version: 1.0.12
date: 2026-09-17

Verified against `packages/node/src/commands/*.command.ts` as of the commit above. Before trusting/
updating this file (or `docs/cli/{publish,ci,clean}.md`) in a later session, run:

  git diff 0ec1e88..HEAD -- packages/node/src/commands/

and update only the pages touched by what that diff actually shows. Once verified again, bump
`git-commit`/`package-version`/`date` here and in each page's own baseline comment.
-->

# `rman-node` CLI Reference

Two commands that exist only in a repository naming this plugin, plus the flags it adds to rman's
own `publish`. None of it is rman's, because each part is about **npm** or **TypeScript** rather
than about repositories - see [docs/node.md](node.md) for the reasoning and for the programmatic
API.

```yaml
# .rmanrc.yml
plugins: ['rman-node']
```

Without that line, `rman clean` is `Unknown argument: clean`. The line may also be **inherited**
through `extends`, so a shared config package can deliver the whole toolchain at once - see
[Where a command comes from](cli-rman.md#where-a-command-comes-from).

## Commands

| Command | Page | Purpose |
| --- | --- | --- |
| `ci` | [`docs/cli/ci.md`](cli/ci.md) | Deletes `node_modules`/lockfiles everywhere, then reinstalls from scratch. |
| `clean` | [`docs/cli/clean.md`](cli/clean.md) | Removes compiled TypeScript output and whatever `.rmanrc "clean"` configures. |

The pages live under `docs/cli/` with every other command's, on purpose: someone looking up
`rman clean` does not know, and should not need to know, which package provides it.

## The `npm` publish target

**`publish` is rman's command, not this plugin's** - which packages are candidates, dependency
order, `--dry-run`, the plan a CI gate reads, all of that is about a repository. What this plugin
contributes is one **publish target**: the answer to "is this version on the npm registry, and how
do I push it".

Installing the plugin therefore adds these flags to `rman publish`, and nothing else about the
command changes:

`--package-manager`, `--access`, `--tag`, `--otp`, `--registry`, `--userconfig`, `--contents`.

It also decides **which packages are npm's by default**: a package with no `publish.target` of its
own ships to npm when `rman-node` is what read its manifest. Nothing else could say so - which is
why rman's own hardcoded `['npm']` default was wrong for a package in any other ecosystem.

See [`docs/cli/publish.md`](cli/publish.md) for the command, and
[Publish targets](cli/publish.md#publish-targets) for the seam.

## Shared options

Nothing is redefined here. Both commands take rman's own option groups, identically - `skip`,
package filtering (`--scope`/`--ignore`/`--deps`/`--dependents`), the branch guard
(`--allow-branch`/`--ignore-branch`), and `--log-level`. `clean` additionally scopes itself to the
package you are standing in, with `--root`/`-r` to override. See
[cli-rman.md#shared-option-groups](cli-rman.md#shared-option-groups).

That is what `RmanPlugin` is for: a plugin's command is meant to look like a built-in rather than
like a script someone bolted on, so the filter, the guard and the progress panel are all exported
from `rman` for it to reuse.

## Config keys

| Key | Level | |
| --- | --- | --- |
| `packageManager` | root only | Which package manager `ci`/`publish` shell out to. `npm` \| `yarn` \| `pnpm` \| `bun`, default `npm`. An explicit `--package-manager` wins over it. |
| `clean` | per package | `include`/`exclude` globs beyond TypeScript's own output, plus `skip`. |
| `publish.npm.directory` | per package | Where this package's publishable output lives, relative to its own directory. The `npm` target's own block, named after the target like the core's `publish.docker`. |

Full descriptions: [docs/node.md#config-keys](node.md#config-keys). The remaining `publish` keys
(`target`, `skip`, `docker`) are rman's own - where a package ships and whether it ships at all are
questions every ecosystem has, and Docker publishing is nobody's.

## Not here

**`rman info`** is a *core* command even though it reports npm's tooling: the plugin augments it in
place rather than replacing it, so `.rmanrc "packageManager"`'s version and the `npmPackages`
sections appear in a report the core assembles. Its page is
[`docs/cli/info.md`](cli/info.md).
