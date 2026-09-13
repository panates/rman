<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli.md for the baseline convention -->

# `rman changed`

```
rman changed [options...]
```

Shows which packages the next [`rman version`](version.md) run would bump, without changing
anything at all - literally `VersionService.getPlan` filtered down to `status === 'bump'` entries.
Useful in CI to decide whether a release is even needed before running `version` for real.

## Options

Accepts [package filtering](../cli.md#package-filtering) options, in addition to:

| Option | Alias | Type | Description |
| --- | --- | --- | --- |
| `--json` | `-j` | boolean | Print output as JSON instead of colored text lines. |

## Examples

```bash
rman changed
```

```
changed pkg-a (default) 1.2.0 -> 1.3.0
changed pkg-b (default) 1.0.4 -> 1.1.0
```

```bash
rman changed --json
```

```json
[
  { "name": "pkg-a", "group": "default", "from": "1.2.0", "to": "1.3.0", "reason": "changed since v1.2.0" },
  { "name": "pkg-b", "group": "default", "from": "1.0.4", "to": "1.1.0", "reason": "in-group dependent of a minor change" }
]
```

With nothing to bump, prints `Nothing has changed.` (or `[]` with `--json`) and exits successfully.

## See also

- [`rman version`](version.md) - the command this previews; same grouping/severity-detection
  algorithm, see that page (and [`VersionService`](../api.md#versionservice)) for the full details.
- [`rman diff`](diff.md) - the actual commit-level diff, rather than a version-bump summary.
