<!-- verified against commit a8ce9fd - see ../cli-rman.md for the baseline convention -->

# `rman changelog`

```
rman changelog [options...]
```

Generates a changelog per package from unreleased commits, grouped into ✨ Features / 🐛 Bug Fixes
/ 🔧 Other Changes via best-effort [Conventional Commits](https://www.conventionalcommits.org/)
parsing. Prints to stdout by default; `--write` prepends into each package's own `CHANGELOG.md`
instead.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--from <hash>` | - | string | Generate the changelog since this commit/hash, applied the same way to every package. Overrides everything below. Default (also `"auto"` explicitly): with `--write`, [where the file left off](#--write-picks-up-where-the-file-left-off); otherwise auto-detect per package from its own most recent release tag - the same one `version` uses, so they never disagree; failing that (no tag yet), from the version its own ecosystem's registry reports; failing that too (never released at all), the package's whole history. |
| `--write` | - | boolean | Prepend the generated entry into each package's own changelog file instead of printing it. |
| `--file-path <path>` | - | string | With `--write`, the file to prepend into, relative to each package's own directory. Default `"CHANGELOG.md"`, or `.rmanrc "changelog.filePath"`. |
| `--from-root` | `-r` | boolean | Generate for the whole repository even when standing inside one package's own directory (which otherwise scopes it to just that package). No effect elsewhere. |
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
rman changelog --from-root                  # whole repo, even from inside one package's directory
rman changelog --scope pkg-a
rman changelog --scope /                    # the root package's own entry, and nothing else
```

`changelog` is one of the two commands whose candidate list holds the repository's own root package
(the other is [`clean`](clean.md)), so **`--scope /` means something here** - it selects the root's
entry, which is where commits under no package, and repo-wide ones, are attributed. See
[package filtering](../cli-rman.md#package-filtering); an ordinary glob never matches the root.

With `--write`, prints `updated <label> <filePath>` per package that had something to write,
instead of the entry's raw content. With nothing unreleased at all, prints `No unreleased
changes.`.

## `--write` picks up where the file left off

An append has to start where the last one stopped, or it is not a complete record of anything. So
`--write` takes its boundary from the **changelog file**, not from the package's last release tag:

| The file | Where the notes start |
| --- | --- |
| carries rman's marker | that commit |
| does not exist | the **whole history** - nothing has been documented yet |
| exists without a marker | ordinary tag detection, widened backwards to the file's own last commit |

rman records where it stopped in the file itself, as an HTML comment that renders as nothing:

```markdown
# Changelog

<!-- rman:documented-up-to 9f3c1ab... -->

## pkg-a 1.1.0 (2026-09-25)
...
---

## pkg-a 1.0.0 (2026-09-24)
...
```

There is **one** marker per file, rewritten on each write rather than accumulated.

## One entry per release, not one per run

Whatever range the boundary opens up is **cut at every release tag inside it**, newest at the top,
each entry headed with that release's own version and date and ruled off from the next with `---`.
A range holding no tag is one entry, which is every ordinary run: the boundary *is* the last
release, so nothing falls inside it.

Where this shows is the backfill. A first `--write` in a repository with years of releases reaches
back through all of them, and without the cut every commit in every release lands under one
heading - measured on a real repository, twelve releases rendered as a single `v2.1.6` entry. With
it:

```markdown
## @panates/tsconfig v2.1.6 (2026-04-30)
...
---

## @panates/tsconfig v2.1.1 (2026-04-05)
...
---

## @panates/tsconfig v2.0.11 (2026-03-25)
```

A release tag sits on the **release commit**, which comes after the work it describes - so that
commit closes its segment and is then dropped from the list like any other release marker. It heads
the entry without appearing in it.

The commits after the newest tag are the unreleased segment, headed by the package's latest released
version unless `--release-version` names the one being prepared.

**Both halves of this were measured as bugs.** Taking the boundary from the release *tag* meant it
did not move between two writes, so a second run re-listed every commit since that tag on top of
the entry that already held them: one commit appeared twice, under two headings carrying the same
version number. And with no changelog file at all, the tag boundary documented only the commits
*after* the last tag - everything before it was never written anywhere, and never would be.

Running `--write` twice with no commit in between now says `No unreleased changes.` and leaves the
file byte-identical.

## `{{date}}` is the release's date, not today's

The version in an entry heading is read back from the package's latest release tag, so the date
beside it is that tag's day. They used to come from different places - the version from the tag, the
date from the clock - so regenerating notes for an already-tagged release headed them with that
release's number and *today's* date: `## @panates/eslint-config v2.1.6 (2026-09-25)` for a v2.1.6
tagged days earlier. Two halves of one heading describing two different releases, and a file that
changed every time it was regenerated.

Today's date is still what `--release-version` gets, and that is the case it was written for: a
caller naming the version is describing a release that **does not exist yet** (`version --changelog`
writes the entry before it commits and tags), so there is no tag to read a date off.

A **print** run (no `--write`) ignores all of this deliberately: nothing is being appended, so
"the notes for this release" is the question, not "what is still undocumented". `--from` overrides
it either way.

**Not read from the entry headings.** `changelog.template` is the repository's, so the heading is a
shape rman did not choose and cannot reliably parse back. The file's own last-modifying commit was
the other candidate and cannot be the boundary: any unrelated edit - a typo, a hand-written note -
would move it forward and drop every commit in between, silently. It still serves as the *widening*
fallback for a file with no marker, which is the one run that has to guess.

## Configuration (`.rmanrc changelog.*`)

```yaml
changelog:
  ignoreTypes: [chore, ci] # commit types dropped entirely, not just folded into "Other Changes"
  tagPattern: 'v*' # rarely needed - the default is derived from how many version lines the
  #                  repository has: 'v*' with one, '{name}@*' with several
  filePath: CHANGELOG.md
  template: changelog.template.md # a PATH to a template file, relative to the repo root
```

A commit is attributed to every package its files fall under; one broad enough to touch at least 3
packages *and* more than half of all packages (a repo-wide doc pass, a relicense, ...) is
attributed to the root alone instead of being repeated in every package's own entry. See
[`ChangelogService`](../rman.md#changelogservice) for the full template placeholder reference
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
