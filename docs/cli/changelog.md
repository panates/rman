<!-- verified against commit ec25859a35fa005aac2ca80faf8dee3a167e7ba9 - see ../cli.md for the baseline convention -->

# `rman changelog`

```
rman changelog [options...]
```

Generates a changelog per package from unreleased commits, grouped into ✨ Features / 🐛 Bug Fixes
/ 🔧 Other Changes via best-effort [Conventional Commits](https://www.conventionalcommits.org/)
parsing. Prints to stdout by default; `--write` prepends into each package's own `CHANGELOG.md`
instead.

## Options

Accepts [package filtering](../cli.md#package-filtering) options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--from <hash>` | - | string | Generate the changelog since this commit/hash, applied the same way to every package. Default (also `"npm"` explicitly): auto-detect per package from its own most recent release tag - the same one `version`/`changed` use, so they never disagree; failing that (no tag yet), from its currently-published npm version; failing that too (never released at all), the package's whole history. |
| `--write` | - | boolean | Prepend the generated entry into each package's own changelog file instead of printing it. |
| `--file-path <path>` | - | string | With `--write`, the file to prepend into, relative to each package's own directory. Default `"CHANGELOG.md"`, or `.rmanrc "changelog.filePath"`. |
| `--root` | `-r` | boolean | Generate for the whole repository even when standing inside one package's own directory (which otherwise scopes it to just that package). No effect elsewhere. |
| `--include-skipped` | - | boolean | Also generate for a package with `.rmanrc "publish.skip"` - excluded by default. |
| `--release-version <v>` | - | string | The version these notes are **for** - what the entry heading shows. Default: read back from each package's own latest release tag, which is only right once that release is tagged. Pass it when generating notes ahead of the bump (e.g. from `changed --json`), otherwise the heading shows the *previous* release. |

## Examples

```bash
rman changelog                              # auto-detects each package's own last release
```

```
Detecting each package's last release...
## pkg-a 1.3.0 (2026-09-12)

### ✨ Features

- add a new option

### 🐛 Bug Fixes

- correct a typo
```

```bash
rman changelog --from a1b2c3d               # since a specific commit, for every package
rman changelog --write                      # prepend into each package's own CHANGELOG.md
rman changelog --write --file-path docs/CHANGELOG.md
rman changelog --root                       # whole repo, even from inside one package's directory
rman changelog --scope pkg-a
```

With `--write`, prints `updated <label> <filePath>` per package that had something to write,
instead of the entry's raw content. With nothing unreleased at all, prints `No unreleased
changes.`.

## Configuration (`.rmanrc changelog.*`)

```yaml
changelog:
  ignoreTypes: [chore, ci] # commit types dropped entirely, not just folded into "Other Changes"
  tagPattern: 'v*' # or "{name}@*" for independent per-package tags
  filePath: CHANGELOG.md
  template: changelog.template.md # a PATH to a template file, relative to the repo root
```

A commit is attributed to every package its files fall under; one broad enough to touch at least 3
packages *and* more than half of all packages (a repo-wide doc pass, a relicense, ...) is
attributed to the root alone instead of being repeated in every package's own entry. See
[`ChangelogService`](../api.md#changelogservice) for the full template placeholder reference
(`{{package}}`/`{{version}}`/`{{date}}`/`{{commits}}`/`{{features}}`/`{{fixes}}`/`{{other}}`) and
grouping algorithm. A package with `.rmanrc "publish": { "skip": true }` gets no entry at all by
default, regardless of its own commits - see [`rman publish`'s own
note](publish.md#excluding-a-package-entirely-rmanrc-publishskip). Pass `--include-skipped` to
generate it anyway.

## See also

- [`rman version --changelog`](version.md) - folds the same changelog generation into a version
  bump's own commit, bounded by each package's *pre-bump* tag rather than this command's own
  auto-detection, and headed with the version being released rather than the previous one.
- [`rman diff`](diff.md) - the raw, ungrouped git diff instead.
