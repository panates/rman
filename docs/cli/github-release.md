<!-- verified against commit 0e33a0a - see ../cli.md for the baseline convention -->

# `rman github-release`

```
rman github-release [options...]
```

Creates the repository's GitHub Release for the version that just shipped - **one** per run, named
after the repository's own release tag, with notes covering every package that shipped under it.
Shows the plan first, then asks for confirmation (unless `--yes` or `--dry-run`).

## Not a publish target, and not optional

A release is easy to mistake for a third [`publish`](publish.md) target, and it is neither half of
one:

- **It isn't a registry.** `publish.target` says where a *package's artifact* goes - npm, Docker
  Hub, GitHub Packages. A GitHub Release is the *repository's* record that a version shipped. Its
  tag covers the whole source tree, so a per-package release would have to invent a tag no package
  owns.
- **It isn't opt-in.** Every other "should this ship?" question in rman is a per-package decision
  with a real alternative. There is no useful repository that releases its code and wants no record
  of having done so - making it configurable would only mean some repos silently stop having one.

So there is nothing to declare: `github-release` works in any repository, with no `.rmanrc` at all.

## Options

Accepts [branch guard](../cli.md#branch-guard) options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--yes` | `-y` | boolean | Skip the confirmation prompt and create the release immediately. |
| `--dry-run` | - | boolean | Only show the plan - never creates anything, regardless of `--yes`. |
| `--json` | `-j` | boolean | Print the plan as JSON (`tag`, `repository`, `status`, `version`, `reason`) instead of text. |
| `--repository <owner/repo>` | - | string | Where the release is created. Default: `.rmanrc "githubRelease.repository"`, falling back to the `origin` remote's URL. |
| `--ignore-dirty` | - | boolean | Release anyway when the working tree has uncommitted changes, instead of aborting. |

There is no [package filtering](../cli.md#package-filtering) here - a release belongs to the
repository, so there is nothing for `--scope`/`--ignore` to narrow down.

```bash
rman github-release             # show the plan, then ask for confirmation
rman github-release --yes       # create it immediately, no confirmation (CI)
rman github-release --dry-run
rman github-release --repository panates/my-repo
```

## Which tag it releases

The release is identified by the repository's own version (the monorepo root's - see
[`rman version`](version.md#the-repositorys-own-version)): its release tag (`.rmanrc
"version.releaseTagPattern"`, default `release-*`) when that version is a calendar one, and
otherwise the tag of the single shared version. Whether a release already exists for that tag
decides `up-to-date` vs `release`, which makes a re-run harmless - including on a run that shipped
nothing at all.

Requires a `GITHUB_TOKEN` (or `GH_TOKEN`) environment variable. A lookup that fails for any reason
other than "no such release" (a bad token, a typo'd repository) is an `error`, never a silent "not
released yet".

Because both the tag and the notes' boundary are read from git, **the tags have to be present**: a
bump made locally and pushed with a plain `git push` leaves them behind (`rman version --push` sends
them), and a CI checkout has to fetch them. A missing release tag is an `error` - without it the
notes would silently cover the entire history instead of what actually shipped.

## Release notes

Notes come from [`changelog`](changelog.md) itself: one section per package, each bounded by the
**previous repository release** and headed with that package's own version - so a repo whose
packages sit on different version lines still reads correctly. A package with nothing in that range
contributes no section, which is also how one that didn't ship this time is left out, with no
ancestry arithmetic needed. The boundary is deliberately not the usual auto-detection, which would
resolve to the very tag being released and correctly find nothing new.

An existing release for the tag is updated rather than treated as a failure, so a re-run after a
partial failure converges.

## Configuration (`.rmanrc "githubRelease"`)

Entirely optional - every fact it needs already has a default source. Nothing here decides
*whether* a release is cut.

```jsonc
// .rmanrc at the repository root
{
  "githubRelease": {
    "repository": "panates/my-repo", // default: parsed from the "origin" remote
    "draft": false,
    "prerelease": false, // default: whether the released version is itself a semver prerelease
    "assets": ["dist/*.tar.gz"] // globs, relative to each package's own directory
  }
}
```

`assets` is the one key read **per package** (each package's own build output ends up on the same
release); the rest is root-level only.

## In CI

Run it unconditionally, after [`publish`](publish.md) - so a failed registry push doesn't leave a
release announcing code that never arrived. It needs no gate of its own: a tag that already has a
release is a no-op.

```yaml
- run: npx rman publish --yes
- run: npx rman github-release --yes
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## See also

- [`rman version`](version.md) - creates the tag this releases, and decides the repository's own release identity.
- [`rman publish`](publish.md) - the registry side, run right before this.
- [`GithubReleaseService`](../api.md#githubreleaseservice) - the underlying service.
