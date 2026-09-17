<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli-rman.md for the baseline convention -->

# `rman clean`

> Comes from **[`rman-node`](../cli-node.md)**, not from rman's core - name it in `.rmanrc`
> `plugins` (directly, or inherited through `extends`) or this command does not exist.

```
rman clean [options]
```

Removes compiled TypeScript output and whatever else `.rmanrc "clean"` configures, across every
package (root included). The built-in replacement for `ts-cleanup`, plus a small glob-based
`include`/`exclude` mechanism of its own. Never touches `node_modules` - that's [`ci`](ci.md)'s job.

For every package not opted out via its own (cascaded) `clean.skip: true`:

- deletes compiled `.js`/`.js.map`/`.d.ts` files sitting next to their `.ts` source under `src`/
  `test` (a `.d.ts` with no matching `.ts`/`.tsx` is left alone - presumably hand-written);
- deletes any `*.tsbuildinfo` incremental-build cache file anywhere in it (skips `node_modules`);
- deletes anything matching its own `clean.include` glob(s), minus `clean.exclude`.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--progress` | - | boolean | `true` | Show a live progress panel (auto-disabled when not a TTY). |
| `--dry-run` | - | boolean | `false` | Report what would be removed without actually removing anything. |
| `--root` | `-r` | boolean | `false` | Clean the whole repository even when standing inside one package's own directory (which otherwise scopes cleaning to just that package). No effect elsewhere. |

## Examples

```bash
rman clean
rman clean --dry-run                 # preview what would be removed, nothing is deleted
rman clean --root                    # whole repo, even from inside one package's directory
rman clean --scope pkg-a
```

```
rm         pkg-a  src/index.js
rm         pkg-a  src/index.d.ts
rm         pkg-a  tsconfig.tsbuildinfo
clean      pkg-b
```

## Configuration (`.rmanrc clean.*`)

```json
// A package's own .rmanrc
{
  "clean": {
    "include": ["dist", "*.tmp"],
    "exclude": ["dist/keep-me.json"],
    "skip": false
  }
}
```

`include`/`exclude` are resolved relative to *that package's own* directory - a root-level pattern
like `packages/*/build` naturally spans every package in one pass, while a package's own override
only ever reaches that one package (it replaces the root's value for that key, rather than merging
with it). `exclude` protects at two levels: a pattern matching a whole `include` result directly
drops that entire result before anything inside it is touched; a finer pattern instead protects just
the matching files *inside* an otherwise-deleted directory, leaving the rest of it gone.

## See also

- [`rman ci`](ci.md) - removes `node_modules`/lockfiles instead (the complementary concern).
- [`CleanService`](../node.md#cleanservice) - the underlying service.
