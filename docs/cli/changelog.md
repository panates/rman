<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

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
| `--from <hash>` | - | string | Generate the changelog since this commit/hash, applied the same way to every package. Default (also `"npm"` explicitly): auto-detect per package from its currently-published npm version, falling back to commits not yet pushed to the current branch's upstream for a package that can't be resolved this way. |
| `--write` | - | boolean | Prepend the generated entry into each package's own changelog file instead of printing it. |
| `--file-path <path>` | - | string | With `--write`, the file to prepend into, relative to each package's own directory. Default `"CHANGELOG.md"`, or `.rmanrc "changelog.filePath"`. |
| `--root` | `-r` | boolean | Generate for the whole repository even when standing inside one package's own directory (which otherwise scopes it to just that package). No effect elsewhere. |

## Examples

```bash
rman changelog                              # auto-detects each package's last published npm version
```

```
Checking published npm versions...
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
grouping algorithm.

## See also

- [`rman version --changelog`](version.md) - folds the same changelog generation into a version
  bump's own commit, bounded by each package's *pre-bump* tag rather than this command's own
  npm-registry auto-detection.
- [`rman diff`](diff.md) - the raw, ungrouped git diff instead.
