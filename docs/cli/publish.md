<!-- verified against commit 0e33a0a - see ../cli-rman.md for the baseline convention -->

# `rman publish`

> Comes from **[`rman-node`](../cli-node.md)**, not from rman's core - name it in `.rmanrc`
> `plugins` (directly, or inherited through `extends`) or this command does not exist.

```
rman publish [options...]
```

Publishes every package to its configured **registry** - `npm` by default, or whatever each
package's own (cascaded) `.rmanrc "publish.target"` says (`"npm"`, `"docker"`, or both). Shows the
plan first, then asks for confirmation (unless `--yes` or `--dry-run`), then publishes sequentially,
in topological order (dependencies before dependents).

The npm side is opt-out (every non-private package is a candidate, unless it explicitly narrows its
own `publish.target` to exclude `"npm"`); the docker side is opt-in (only a package explicitly
listing it in `publish.target` is a candidate at all) - see
[Docker publishing](#docker-publishing-publishdocker) below.

`publish.target` is strictly about **where a package's artifact goes**. The repository's GitHub
Release is not one of these - it isn't a place anything ships to, it's the repository's record that
a version shipped - and it is not opt-in either: see [`rman github-release`](github-release.md).

Every target answers the same question against its own registry - *is this exact version already out
there?* - so no package is ever left without an answer:

| Target | "Already published?" | Opt-in? |
| --- | --- | --- |
| `npm` | `npm view <name> version` == the local `package.json` version | No (opt-out via `private`/`target`) |
| `docker` | `docker manifest inspect <image>:<version>` succeeds | Yes |

This is deliberately **not** the same question [`rman changed`](changed.md)/[`version`](version.md)
answer ("what commits landed since the last release, and how big a bump do they imply") - that one is
commit-driven, because a registry can only say *older/newer*, never *how much* or *why*. The two
are independent on purpose: a failed publish leaves the registry behind with no new commits to show
for it, and `publish` still has to notice.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Choices | Description |
| --- | --- | --- | --- | --- |
| `--yes` | `-y` | boolean | - | Skip the confirmation prompt and publish immediately. |
| `--dry-run` | - | boolean | - | Only show the plan - never publishes, regardless of `--yes`. |
| `--json` | `-j` | boolean | - | Print the plan as JSON (one row per package **and** target: `name`, `target`, `status`, `version`, `reason`) instead of text. |
| `--target <name>` | - | array | `npm`, `docker` | Restrict this run to just these target(s) (repeatable). Default: whatever each package is configured for. `--target docker` on a package that opts in without a `publish.docker` config errors clearly instead of being silently skipped. |
| `--ignore-dirty` | - | boolean | - | Exclude a package with uncommitted local changes instead of aborting the whole run. |
| `--package-manager <name>` | - | string | `npm`, `yarn`, `pnpm`, `bun` | Package manager to publish with. Default: `npm`, or `.rmanrc "packageManager"`. |
| `--access <level>` | - | string | `public`, `restricted` | `npm publish --access <level>` - required by the registry for a *new* scoped package. |
| `--tag <name>` | - | string | - | `npm publish --tag <name>` - the dist-tag this version is published under (default `latest`). |
| `--otp <code>` | - | string | - | `npm publish --otp <code>` - a 2FA one-time password, for registries that require it. |
| `--registry <url>` | - | string | - | Registry to check against **and** publish to (default: whatever `.npmrc` already configures). |
| `--userconfig <path>` | - | string | - | Path to a custom `.npmrc` for both the registry check and the actual publish. |
| `--contents <dir>` | - | string | - | Subdirectory to publish from, relative to each package's own directory - the lowest-precedence way to say it, after `publishConfig.directory` and `.rmanrc "publish.directory"`. |
| `--docker-namespace <ns>` | - | string | - | Prefixed onto a bare (no `/`) `publish.docker.image`. Default: the `DOCKERHUB_NAMESPACE` environment variable. |

## Examples

```bash
rman publish                              # show the plan, then ask for confirmation
```

```
publish    pkg-a 1.3.0 never published
up-to-date pkg-b 1.0.4
Publish these packages? (y/N)
```

```bash
rman publish --yes                        # publish immediately, no confirmation
rman publish --dry-run                    # only show the plan, never publish
rman publish --access public              # required for a brand-new scoped package
rman publish --tag next
rman publish --otp 123456
rman publish --registry https://registry.example.com --userconfig ./ci.npmrc
rman publish --package-manager pnpm
rman publish --scope '@myorg/*'
```

If stdout isn't a TTY and `--yes` wasn't passed, `rman` refuses to prompt: `Not a TTY - refusing to
prompt. Pass --yes to publish non-interactively.` (important for CI - always pass `--yes` there).
Any dirty package aborts the whole plan (`N package(s) have uncommitted local changes...`) unless
`--ignore-dirty` is given. With nothing to publish, prints `Nothing to publish.`.

`getPlan` is decoupled from [`version`](version.md) - it only ever compares the current
`package.json` version against the registry (via `npm view`, queried concurrently), so it works
equally well right after a version bump or standing alone days later.

### Asking "is there anything to release?" in CI

`--dry-run --json` answers exactly that, without publishing anything:

```bash
rman publish --dry-run --json | jq '[.[] | select(.status == "publish")] | length'
```

This is the right gate for a release pipeline - not [`rman changed`](changed.md), which answers the
*other* question ("does anything need a new version number?") and correctly reports nothing when a
version was bumped in an earlier run, or bumped locally and merged in, or when a previous publish
failed after the tag was already pushed.

## `"workspace:"` protocol at publish time

Just before running the actual publish command for a package, any `"workspace:"` dependency range
in its `package.json` is rewritten to a real, registry-consumable range (`workspace:*` → the
dependency's exact current version; `workspace:^`/`workspace:~` → `^`/`~` + that version; an
explicit `workspace:<range>` → the range verbatim, prefix stripped) - the same substitution
pnpm/yarn's own `publish` performs. The original file is restored immediately afterward, success or
failure, since `rman` publishes directly from the working tree rather than a staged tarball. See
[`PublishService`](../node.md#publishservice) for the full mechanics and test-verified examples.

## Docker publishing (`publish.docker`)

A package opts into building/pushing a Docker image by adding `"docker"` to its own (cascaded)
`.rmanrc "publish.target"`, plus a `"publish.docker"` block - required once `"docker"` is listed;
missing it is a clear `'error'` in the plan, not a silent skip:

```jsonc
// packages/my-app/.rmanrc - a docker-only app is typically also "private": true in package.json
{
  "publish": {
    "target": ["docker"],
    "docker": {
      "image": "my-app", // bare - prefixed with --docker-namespace/DOCKERHUB_NAMESPACE
      "platforms": ["linux/amd64", "linux/arm64"], // default ["linux/amd64"]
      "buildContexts": { "root": "../.." }, // docker buildx build --build-context root=<path>
      "buildArgs": { "GITHUB_TOKEN": "$GITHUB_TOKEN" } // "$NAME" expands from the environment
    }
  }
}
```

`publish.docker.image` already containing a `/` (e.g. `"someregistry.io/team/my-app"`) is used
verbatim, no namespace prefixing. Requires `DOCKERHUB_USERNAME`/`DOCKERHUB_PASSWORD` environment
variables to log in (once per run, before any package's build) and `docker buildx` on the machine.
Each `'publish'` entry builds and pushes `<image>:<version>` and `<image>:latest` via a single
`docker buildx build --push`; whether the tag already exists (`docker manifest inspect`) decides
`'publish'` vs `'up-to-date'`, the same idea `npm view` serves on the npm side. A
`publish.docker.readme` file (default `DOCKER_README.md`, relative to the package's own directory),
if present, updates the DockerHub repository's description afterward.

```bash
rman publish --target docker              # only the packages configured for the "docker" target
rman publish --target npm --target docker # both, explicitly (same as omitting --target)
rman publish --docker-namespace myorg
```

See [`DockerPublishService`](../rman.md#dockerpublishservice) for the full mechanics.

## The GitHub Release is not a target

A repository's GitHub Release used to be a third `publish.target`, and that was wrong twice over:
it isn't a registry a package ships to, and it isn't optional. It now has its own command, which
needs no configuration and no opt-in - see [`rman github-release`](github-release.md).

`"github"` as a `publish.target` value is therefore free for what it actually reads as: publishing
to **GitHub Packages** (`npm.pkg.github.com`). That works today through npm's own
`publishConfig.registry`, or `--registry`, rather than a target of its own.

## Publishing from a build directory (`publish.directory`)

When the publishable output is a subdirectory, say so once:

```yaml
"[*]":
  publish:
    directory: build
```

Most specific statement wins: a package's own `publishConfig.directory` (npm/pnpm's native
spelling), then this, then `--contents` for a single run.

**The manifest in that directory is generated by `publish`, not by your build.** There is nothing to
configure about it - it is the package's own `package.json` minus what a consumer of the tarball can
neither see nor use:

| Removed | Why |
| --- | --- |
| `devDependencies` | npm never installs a dependency's own - pure noise. |
| `scripts`, except `preinstall`/`install`/`postinstall` | Those three are the only ones a consumer's install runs. The rest never reach them (`prepare` runs for a *git* dependency, which builds from the repository, not from this tarball). |
| `private` | `publish` refuses a private package outright, so the flag can only be wrong in a manifest being published. |
| `publishConfig.directory` | It pointed *here*; kept, it would point one level deeper again. |

`"workspace:"` ranges are resolved in it too, and the file is removed again when the publish
finishes - it is a publish-time artifact, not a build output.

Generating it here rather than from a build script is what keeps it honest: a script writes it when
the *build* runs, so bumping the version afterwards (or building before a bump) publishes a manifest
that disagrees with the package - and the `"workspace:"` rewrite, which only ever touched the
package's own file, never reached the copy at all.

## Excluding a package entirely (`.rmanrc "publish.skip"`)

A package with `.rmanrc "publish": { "skip": true }` is never a candidate for any target - not
shown, not published - regardless of `target`/`"private"`. [`rman changelog`](changelog.md) also
skips it by default (its own `--include-skipped` overrides); [`rman version`](version.md) never
consults this at all - a package can still be meaningfully versioned without ever being published.

## Failure handling

If a package fails to publish, every still-pending dependent (transitively) is marked as failed and
skipped too - never publishes a package whose dependency range points at something that never
actually reached the registry. Unrelated packages elsewhere in the plan are unaffected.

## See also

- [`rman version`](version.md) - typically run right before `publish`.
- [`rman github-release`](github-release.md) - the repository's own release record, cut separately.
- [`PublishService`](../node.md#publishservice) / [`DockerPublishService`](../rman.md#dockerpublishservice) - the underlying services.
