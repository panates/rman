<!-- verified against commit a36b6e5acf4c433f9c819753ea0ba707d39a4b9c - see ../cli.md for the baseline convention -->

# `rman publish`

```
rman publish [options...]
```

Publishes every non-private package whose local version isn't already on the registry. Shows the
plan first, then asks for confirmation (unless `--yes` or `--dry-run`), then publishes
sequentially, in topological order (dependencies before dependents).

## Options

Accepts [package filtering](../cli.md#package-filtering) and [branch guard](../cli.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Choices | Description |
| --- | --- | --- | --- | --- |
| `--yes` | `-y` | boolean | - | Skip the confirmation prompt and publish immediately. |
| `--dry-run` | - | boolean | - | Only show the plan - never publishes, regardless of `--yes`. |
| `--ignore-dirty` | - | boolean | - | Exclude a package with uncommitted local changes instead of aborting the whole run. |
| `--package-manager <name>` | - | string | `npm`, `yarn`, `pnpm`, `bun` | Package manager to publish with. Default: `npm`, or `.rmanrc "packageManager"`. |
| `--access <level>` | - | string | `public`, `restricted` | `npm publish --access <level>` - required by the registry for a *new* scoped package. |
| `--tag <name>` | - | string | - | `npm publish --tag <name>` - the dist-tag this version is published under (default `latest`). |
| `--otp <code>` | - | string | - | `npm publish --otp <code>` - a 2FA one-time password, for registries that require it. |
| `--registry <url>` | - | string | - | Registry to check against **and** publish to (default: whatever `.npmrc` already configures). |
| `--userconfig <path>` | - | string | - | Path to a custom `.npmrc` for both the registry check and the actual publish. |
| `--contents <dir>` | - | string | - | Subdirectory to publish from, relative to each package's own directory - only consulted when a package has no `publishConfig.directory` of its own (that always wins when present). |

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

## `"workspace:"` protocol at publish time

Just before running the actual publish command for a package, any `"workspace:"` dependency range
in its `package.json` is rewritten to a real, registry-consumable range (`workspace:*` → the
dependency's exact current version; `workspace:^`/`workspace:~` → `^`/`~` + that version; an
explicit `workspace:<range>` → the range verbatim, prefix stripped) - the same substitution
pnpm/yarn's own `publish` performs. The original file is restored immediately afterward, success or
failure, since `rman` publishes directly from the working tree rather than a staged tarball. See
[`PublishService`](../api.md#publishservice) for the full mechanics and test-verified examples.

## Failure handling

If a package fails to publish, every still-pending dependent (transitively) is marked as failed and
skipped too - never publishes a package whose dependency range points at something that never
actually reached the registry. Unrelated packages elsewhere in the plan are unaffected.

## See also

- [`rman version`](version.md) - typically run right before `publish`.
- [`PublishService`](../api.md#publishservice) - the underlying service.
