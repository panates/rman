<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman publish`

> **The command is rman's own.** *Where* a package ships is a [publish target](#publish-targets),
> which a plugin contributes - so the flags below are not a fixed list. rman brings `docker`;
> `npm` comes from the [`node` built-in](../rman.md#the-node-built-in).

```
rman publish [options...]
```

Publishes every package to its configured **registry** - whatever each package's own (cascaded)
`.rmanrc "publish.target"` says, or, when it says nothing, whichever installed targets claim it.
Shows the plan first, then asks for confirmation (unless `--yes` or `--dry-run`), then publishes
sequentially, in topological order (dependencies before dependents).

`publish.target` is strictly about **where a package's artifact goes**. The repository's GitHub
Release is not one of these - it isn't a place anything ships to, it's the repository's record that
a version shipped - and it is not opt-in either: see [`rman github-release`](github-release.md).

This is deliberately **not** the same question [`version`](version.md)
answer ("what commits landed since the last release, and how big a bump do they imply") - that one is
commit-driven, because a registry can only say *older/newer*, never *how much* or *why*. The two
are independent on purpose: a failed publish leaves the registry behind with no new commits to show
for it, and `publish` still has to notice.

## Publish targets

A target is one answer to *"is this exact version already out there, and how do I push it"*, and
that is the only part of publishing an ecosystem owns. Everything else the command does - the
candidates, the order, the plan, the confirmation, the JSON - is about a repository, so it lives in
rman.

Two ship today, and a repository can install more:

| Target | From | "Already published?" | Claims by default |
| --- | --- | --- | --- |
| `npm` | the [`node` built-in](../rman.md#the-node-built-in) | the local `package.json` version is among the registry's published `versions` | every package whose manifest that plugin read |
| `docker` | rman itself | `docker manifest inspect <image>:<version>` succeeds | nothing - opt-in, via `publish.target` |

Two consequences worth knowing:

- **`rman publish --help` differs per repository.** Each target adds its own flags, so the ones
  listed under "the `npm` target" below exist only where the `node` built-in is loaded - which is
  every repository unless a caller passes `presets: []`. A flag belonging
  to a target nobody installed is not a flag that does nothing - it is `Unknown argument`.
- **A `publish.target` naming a target nothing implements is an error**, and it names the ones the
  repository *does* have. There is no fixed list of valid names any more, so this replaces what used
  to be a type and a `choices` list.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Choices | Description |
| --- | --- | --- | --- | --- |
| `--yes` | `-y` | boolean | - | Skip the confirmation prompt and publish immediately. |
| `--dry-run` | - | boolean | - | Only show the plan - never publishes, regardless of `--yes`. |
| `--json` | `-j` | boolean | - | Print the plan as JSON (one row per package **and** target: `name`, `target`, `status`, `version`, `detail`, `reason`) instead of text. |
| `--target <name>` | - | array | *the installed targets* | Restrict this run to just these target(s) (repeatable). Default: whatever each package is configured for. A target named here that matches no package is an error rather than an empty run. |
| `--ignore-dirty` | - | boolean | - | Exclude a package with uncommitted local changes instead of aborting the whole run. |

### From the `docker` target (rman's own)

| Option | Type | Description |
| --- | --- | --- |
| `--docker-namespace <ns>` | string | Prefixed onto a bare (no `/`) `publish.docker.image`. Default: the `DOCKERHUB_NAMESPACE` environment variable. |

### From the `npm` target (the `node` built-in)

| Option | Type | Choices | Description |
| --- | --- | --- | --- |
| `--package-manager <name>` | string | `npm`, `yarn`, `pnpm`, `bun` | Package manager to publish with. Default: the package's `.rmanrc "packageManager.node"`, else `npm`. |
| `--access <level>` | string | `public`, `restricted` | `npm publish --access <level>` - required by the registry for a *new* scoped package. |
| `--tag <name>` | string | - | `npm publish --tag <name>` - the dist-tag this version is published under (default `latest`). |
| `--otp <code>` | string | - | `npm publish --otp <code>` - a 2FA one-time password, for registries that require it. |
| `--staged` | boolean | - | `npm stage publish` - hold each version in npm's staging queue instead of publishing it. `--no-staged` forces a direct publish over `.rmanrc "publish.npm.staged"`. See [Staged publishing](#staged-publishing). |
| `--registry <url>` | string | - | Registry to check against **and** publish to, for every package in this run. Overrides each package's own `publishConfig.registry`; with neither, npm resolves `.npmrc` itself. See [Publishing somewhere other than npmjs.org](#publishing-somewhere-other-than-npmjsorg). |
| `--userconfig <path>` | string | - | Path to a custom `.npmrc` for both the registry check and the actual publish. |
| `--contents <dir>` | string | - | Subdirectory to publish from, relative to each package's own directory - the lowest-precedence way to say it, after `publishConfig.directory` and `.rmanrc "publish.npm.directory"`. |

## Examples

```bash
rman publish                              # show the plan, then ask for confirmation
```

```
publish [npm] pkg-a 1.3.0 never published
up-to-date [npm] pkg-b 1.0.4
Publish these packages? (y/N)
```

```bash
rman publish --yes                        # publish immediately, no confirmation
rman publish --dry-run                    # only show the plan, never publish
rman publish --access public              # required for a brand-new scoped package
rman publish --tag beta                   # a prerelease goes under its own dist-tag, never latest
rman publish --otp 123456
rman publish --staged                      # queue for approval instead of going live
rman publish --registry https://registry.example.com --userconfig ./ci.npmrc
rman publish --package-manager pnpm
rman publish --scope '@myorg/*'
```

If stdout isn't a TTY and `--yes` wasn't passed, `rman` refuses to prompt: `Not a TTY - refusing to
prompt. Pass --yes to publish non-interactively.` (important for CI - always pass `--yes` there).
Any dirty package aborts the whole plan (`N package(s) have uncommitted local changes...`) unless
`--ignore-dirty` is given. With nothing to publish, prints `Nothing to publish.`.

A failure line - an aborted plan, a publish that did not go through - is written to **stderr**, so
under `--json` stdout stays one JSON document that `jq` or `JSON.parse` can read even when the run
exits non-zero.

A target's `getPlan` is decoupled from [`version`](version.md) - it only ever compares what is on
disk against what is on its own registry, so it works equally well right after a version bump or
standing alone days later.

### Prereleases go under their own dist-tag, without being asked

A version that names a prerelease line publishes to that line:

```
publish [npm] rman 2.0.0-beta.1 -> dist-tag "beta"  never published
```

`2.0.0-beta.1` → `beta`; the identifier is written in the version, so this is a reading rather
than a guess. An ordinary release carries no tag at all, which is how npm is told `latest`.

**Why it is not left to you to remember:** `npm publish` with no `--tag` writes **`latest`**, so a
beta published that way is what every plain `npm install <name>` resolves to from then on. npm is
content to point `latest` at a prerelease, and `npm dist-tag` can move it back only after everyone
who installed in between already has the beta. One forgotten flag, no clean undo.

**Derived is not silent.** The tag is decided in the *plan*, printed beside the package, and
carried in `--dry-run --json` as each entry's `detail`, so where a version is going is something
you confirm rather than infer. `applyPlan` then publishes under the tag the plan showed, instead of
working it out again.

`--tag` still overrides it - for a project that puts every preview on `next`, or to send a release
somewhere other than `latest`:

```bash
rman publish --tag next
```

**A prerelease line that is not a preview is listed, by identifier.** A package whose releases are
all `-rev.N` (see [`version.preid`](version.md#a-permanent-prerelease-line)) says so with
`.rmanrc "publish.npm.latestPrereleases": ["rev"]`: a version on a listed identifier publishes with
no tag, so to `latest`, and `--tag latest` is accepted for it. Every identifier it does not list is
still a preview - a `4.14.0-beta.0` of the same package goes to `beta`. Naming the identifier rather
than reading `version.preid` is deliberate: a repository can put its previews on a declared line
too, and those must not land on `latest`.

Two cases have no honest answer to derive, and are errors rather than guesses:

| | |
| --- | --- |
| `--tag latest` on a prerelease | the one thing deriving must never reach. Someone who typed it is likelier to have confused themselves than to mean it; a bare `npm publish --tag latest` is the escape hatch for genuinely meaning it. |
| a prerelease with no identifier (`2.0.0-1`) | its prerelease part is the number `1`, so a dist-tag called `1` would be invented rather than read. Pass `--tag <name>`. |

A **calendar version** (`2026.9.15-1430`) is not a preview, however semver reads its time part -
that is just how the time is spelled - so it publishes to `latest` like any other release.

A whole prerelease cycle, then:

```bash
rman version --preid beta     # 1.3.0 -> 2.0.0-beta.0, committed and tagged
```

```bash
rman publish                  # -> dist-tag "beta"; "latest" does not move
```

Repeat the pair for `beta.1`, `beta.2`, … Any bump graduates a prerelease to the release it was
previewing (`2.0.0-beta.3` → `2.0.0` for `major`, `minor` *or* `patch`), after which the same
`rman publish` puts it on `latest`, because the version no longer names a prerelease line:

```bash
rman version major && rman publish
```

**The plan stays correct across the cycle**, because the npm target asks whether *this version* is
among the registry's published `versions` - not what `latest` points at, which by design does not
move while betas are going out. Asking `latest` would have kept proposing an already-published beta
until npm answered `403`.

One thing the tooling cannot check for you: a **consumer's** dependency range. `>=2.0.0` does not
match `2.0.0-beta.0` - semver excludes prereleases from a range that names none - so a package
meant to be installed alongside the beta needs `>=2.0.0-0`. Ranges *inside* the repository are
rewritten by [`version`](version.md) itself and need no attention.

### Asking "is there anything to release?" in CI

`--dry-run --json` answers exactly that, without publishing anything:

```bash
rman publish --dry-run --json | jq '[.[] | select(.status == "publish")] | length'
```

This is the right gate for a release pipeline - not [`rman version --json`](version.md#--json-the-plan-for-a-script), which answers the
*other* question ("does anything need a new version number?") and correctly reports nothing when a
version was bumped in an earlier run, or bumped locally and merged in, or when a previous publish
failed after the tag was already pushed.

## Publishing somewhere other than npmjs.org

GitHub Packages, a company registry, anything else - stated in any of the three ways npm already
understands, and **`publish` asks the same registry it publishes to**:

| where it is stated | scope |
| --- | --- |
| `.npmrc` - `@owner:registry=https://npm.pkg.github.com` | every package under that scope, and the usual GitHub Packages setup |
| `package.json` - `publishConfig.registry` | that one package |
| `--registry <url>` | every package in this run |

Precedence is npm's own, verified against it: `--registry` wins over `publishConfig.registry`, and
with neither given nothing is passed at all, so npm resolves `.npmrc` itself.

**Mixed registries in one repository are the point of the middle row.** A monorepo publishing some
packages to npmjs.org and others to GitHub Packages states it per package, and one `rman publish`
sends each where it belongs - `--registry` cannot express that, since it is one value for the run.

```json
// packages/internal-lib/package.json
{ "name": "@myorg/internal-lib", "publishConfig": { "registry": "https://npm.pkg.github.com" } }
```

**Authentication is not rman's**, and does not travel with any of this. The registry a package goes
to still needs its own credential in `.npmrc` - `//npm.pkg.github.com/:_authToken=...` for GitHub
Packages - or `--userconfig <path>` pointing at a file that has it. npm Trusted Publishing (OIDC)
covers npmjs.org only.

**A note on the check.** `publish` asks the registry whether a version is already there
(the question [`rman publish` exists to answer](#publish-targets)), and `npm view` - unlike
`npm publish` - does **not**
read `publishConfig.registry`; rman passes it explicitly for exactly that reason. Without it the
lookup went to npmjs.org for a package that lives elsewhere, came back empty, and the plan read
`never published` on **every** run: the first publish succeeded and the second was rejected by the
registry for republishing a version.

## Staged publishing

`--staged`, or `.rmanrc "publish.npm.staged": true`, runs **`npm stage publish`** instead of
`npm publish`. The version goes into npm's staging queue rather than onto the registry, and stays
there until a maintainer approves it:

| step | who | command |
| --- | --- | --- |
| stage | CI, with any token, no 2FA | `rman publish --staged` |
| review | a maintainer | `npm stage list`, `npm stage view <id>`, `npm stage download <id>` |
| decide | a maintainer, **with 2FA** | `npm stage approve <id>` / `npm stage reject <id>` |

The point is where the 2FA challenge lives: a stolen automation token can stage a version, and
cannot approve one. It also gives a human a look at the tarball before anyone can install it.

rman drives the first step and nothing else. `list`/`view`/`approve`/`reject` belong at a terminal
with a 2FA prompt, which is the whole reason staging exists - wrapping them would put the approval
back in the automation that staging is protecting you from.

**The plan says so**, so a run that leaves nothing live is something the reader confirms rather than
discovers:

```
publish [npm] pkg-a 1.0.0 staged for approval never published
```

It is carried in `detail`, so `--dry-run --json` shows it too.

**Requires npm ≥ 11.15.0 and Node ≥ 22.14.0** on whatever runs the publish. rman checks neither -
the version that matters is the runner's, and npm's own `Unknown command: "stage"` says it better
than a guess made elsewhere would.

**Known limitation: a staged version is invisible to the plan's own question.** `publish` asks the
registry whether a version is published, and a pending one is not - `npm view` does not report the
queue. So a second run before an approval proposes the same package again; whether npm accepts a
duplicate stage is npm's answer, not rman's.

**npm Trusted Publishing:** `npm stage publish` is always permitted for a trusted publisher. Direct
`npm publish` is the one that needs **Allow `npm publish`** ticked on the package's trusted-publisher
connection - so a repository that leaves it unticked has to pass `--staged`, and one that publishes
directly has to tick it.

## `"workspace:"` protocol at publish time

Just before running the actual publish command for a package published **in place** (from its own
directory), any `"workspace:"` dependency range in its `package.json` is rewritten to a real, registry-consumable range (`workspace:*` → the
dependency's exact current version; `workspace:^`/`workspace:~` → `^`/`~` + that version; an
explicit `workspace:<range>` → the range verbatim, prefix stripped) - the same substitution
pnpm/yarn's own `publish` performs. The original file is restored immediately afterward, success or
failure, since `rman` publishes directly from the working tree rather than a staged tarball. A
package published from a [build directory](#publishing-from-a-build-directory-publishnpmdirectory)
gets the same substitution in the manifest `publish` generates there, and its own `package.json` is
never touched. See
[`PublishService`](../rman.md#the-node-built-in) for the full mechanics.

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
      "architectures": ["linux/amd64", "linux/arm64"], // default ["linux/amd64"]
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

**None of this needs a plugin.** The `docker` target is rman's own, which is the point of the
target seam: any language's project can push an image, so a Cargo or Go repository reaches all of
the above by naming `"docker"` in `publish.target` and nothing else.

## The GitHub Release is not a target

A repository's GitHub Release used to be a third `publish.target`, and that was wrong twice over:
it isn't a registry a package ships to, and it isn't optional. It now has its own command, which
needs no configuration and no opt-in - see [`rman github-release`](github-release.md).

`"github"` as a `publish.target` value is therefore free for what it actually reads as: publishing
to **GitHub Packages** (`npm.pkg.github.com`). That works today through npm's own
`publishConfig.registry`, or `--registry`, rather than a target of its own.

## Publishing from a build directory (`publish.npm.directory`)

> The `npm` target's, in every detail below - a build directory, a generated manifest and
> `"workspace:"` ranges are npm's ideas - see [`"workspace:"` ranges](../rman.md#workspace-ranges).

When the publishable output is a subdirectory, say so once:

```yaml
"[*]":
  publish:
    npm:
      directory: build
```

The key used to be a bare `publish.directory`, and that spelling is **refused, not ignored**: the
plan reports an error for the package naming `publish.npm.directory`. Ignored, it would silently fall
back to the package's own directory and push the source tree to npm.

Most specific statement wins: a package's own `publishConfig.directory` (npm/pnpm's native
spelling), then this, then `--contents` for a single run.

**The manifest in that directory is generated by `publish`, not by your build.** There is nothing to
configure about it - it is the package's own `package.json` minus what a consumer of the tarball can
neither see nor use:

| Removed | Why |
| --- | --- |
| `devDependencies` | npm never installs a dependency's own - pure noise. |
| `scripts`, except `preinstall`/`install`/`postinstall` | Those three are the only ones a consumer's install runs. The rest never reach them (`prepare` runs for a *git* dependency, which builds from the repository, not from this tarball). |
| `private` | **Only when the package declares a `publishConfig`.** A package set up to be published that is also `private` is guarding its source tree against a stray `npm publish`; one with no `publishConfig` means it, and keeps the flag. |
| `publishConfig.directory` | It pointed *here*; kept, it would point one level deeper again. |

`"workspace:"` ranges are resolved in it too, and when the publish finishes the file is put back as
the build left it - it is a publish-time artifact, not a build output.

**Whether a package is private is decided from the manifest that will be published** - the one
above, which `publish` writes over whatever the build left in the directory; a `package.json` your
build writes there decides nothing. In place, it is the package's own:

- **The build directory is missing, or holds nothing but a `package.json`** - nothing has been
  built: the plan reports an error for that package (`build the package first`).
- **`private: true` in the source with no `publishConfig`** - skipped without looking for a build,
  since it stays private in anything derived from it.
- **`private: true` in the source *with* a `publishConfig`, publishing from a build directory** -
  published: the flag guards the source tree, and the generated manifest does not carry it.
- **`private: true`, publishing in place** - skipped, whatever `publishConfig` says: npm refuses it.

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

If a package fails to publish, every still-pending package whose **consumers need it** is marked as
failed and skipped too, transitively - never publishes a package whose dependency range points at
something that never actually reached the registry. "Need" means a `dependencies` entry or a peer
not marked optional; a package that lists the failed one only in `devDependencies` (removed from
what is published), as an optional peer, or in `optionalDependencies` is published anyway.
Unrelated packages elsewhere in the plan are unaffected.

**Targets run one after another, and `docker` runs last** (`PublishTarget.publishesLast`). An image
is built from what the other targets publish - a `Dockerfile` running `npm install` asks the registry
for the versions this same run is about to push - so building it first fails with `ETARGET No
matching version found` on a version that goes up a minute later.

**The run ends with a recap** of how many packages went up and every failure again, with its reason
- a target prints as it goes, so on a long release the failed line is otherwise far above the end of
the log:

```
publish 12 published, 1 failed
  failed [docker] syncbridge-app 0.14.13
         docker build exited with code 1:
           npm error code ETARGET
           npm error notarget No matching version found for @syncbridge/common@^0.13.9.
           ERROR: failed to build: failed to solve: exit code: 1
```

A failed image build's reason carries the build's own error lines (once each - BuildKit prints a
failing step twice), not only its exit code. The closing error line names the failed packages too,
`"publish" failed for [docker] syncbridge-app`, since in CI stdout and stderr are separate pipes and
it can land anywhere among the lines above it.

**In GitHub Actions the same outcome goes to the job's summary page** as a table - result, target,
package, version, and the reason or the dist-tag - whenever `GITHUB_STEP_SUMMARY` is set. Nothing is
written outside Actions, and a summary that cannot be written does not fail the publish.

## See also

- [`rman version`](version.md) - typically run right before `publish`.
- [`rman github-release`](github-release.md) - the repository's own release record, cut separately.
- [`PublishService`](../rman.md#the-node-built-in) / [`DockerPublishService`](../rman.md#dockerpublishservice) - the underlying services.
