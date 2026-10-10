<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

# `rman clean`

> Comes from the **[`node` built-in](../rman.md#the-node-built-in)**, not from rman's core. Its preset
> is laid under every repository by default, so the command is there without being named; a caller
> passing `presets: []` gets a bare core without it. It acts on **node packages only** - in a
> polyglot repository the packages of other technologies are left alone, with no `--platform` needed.

```
rman clean [options]
```

Removes compiled TypeScript output and whatever else `.rmanrc "clean"` configures, across every
package (root included). The built-in replacement for `ts-cleanup`, plus a small glob-based
`include`/`exclude` mechanism of its own. Never touches `node_modules` - that's [`ci`](ci.md)'s job.

For every package not opted out via its own (cascaded) `clean.skip: true`:

- deletes compiled `.js`/`.js.map`/`.d.ts` output **anywhere in the package**, except
  `node_modules` and its build directory (the resolved `publish.npm.directory`, `build` when unset):
  - under `src`/`test`, where everything is TypeScript, a `.js`/`.js.map` goes even when its `.ts`
    was since renamed or deleted - unless a `.d.ts` with no `.ts` declares the `.js`, which makes
    it a plain-JS module with a hand-written declaration (a generated data file, say);
  - anywhere else, a file goes **only when a matching `.ts`/`.tsx` sits beside it** - that is what
    tells `tsc` output from a hand-written `index.js`, `*.config.js` or `scripts/*.js`, which are
    left alone. A compiled file there whose source is gone is left alone too, since nothing on disk
    says it was generated;
  - a `.d.ts` always needs its `.ts`/`.tsx` beside it, `src` included - one without is a
    hand-written declaration;
  - a file `clean.exclude` matches is left alone, whatever these rules say about it;
  - directories left empty are pruned under `src`/`test` only;
- deletes any `*.tsbuildinfo` incremental-build cache file anywhere in it (skips `node_modules`);
- deletes anything matching its own `clean.include` glob(s), minus `clean.exclude`.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--progress` | - | boolean | `true` | Show a live progress panel (auto-disabled when not a TTY). |
| `--dry-run` | - | boolean | `false` | Report what would be removed without actually removing anything. |
| `--from-root` | `-r` | boolean | `false` | Clean the whole repository even when standing inside one package's own directory (which otherwise scopes cleaning to just that package). No effect elsewhere. |

## Examples

```bash
rman clean
rman clean --dry-run                 # preview what would be removed, nothing is deleted
rman clean --from-root               # whole repo, even from inside one package's directory
rman clean --scope pkg-a
rman clean --ignore /                # every member, skipping the root's own sweep
```

```
rm         pkg-a  src/index.js
rm         pkg-a  src/index.d.ts
rm         pkg-a  tsconfig.tsbuildinfo
clean      pkg-b
```

`clean` is one of the two commands whose candidate list holds the repository's own root package (the
other is [`changelog`](changelog.md)), so **`--scope /` / `--ignore /` mean something here** - see
[package filtering](../cli-rman.md#package-filtering). Worth knowing which is which: the root's
target is not "the root directory's own output" but a sweep that recurses through every package
directory, so `--scope /` is the *widest* selection, not the narrowest. An ordinary glob never
matches the root, so `--scope '*'` is the members alone.

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
- [`CleanService`](../rman.md#the-node-built-in) - the underlying service.
