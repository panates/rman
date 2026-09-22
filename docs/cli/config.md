<!-- verified against commit 0ec1e88 - see ../cli-rman.md for the baseline convention -->

# `rman config`

```
rman config [options]
```

Prints the **effective** `.rmanrc` config for the package of the current directory - what rman
actually sees there, after every layer has been applied. That is the whole point: a value in this
output may come from four places at once, and no single file shows it.

```bash
rman config                  # the package you are standing in
rman config --from-root      # the repository root's own config instead
rman config --json           # machine-readable
rman config --json | jq .version
```

## What it resolves

Everything that makes a config hard to read back by hand:

| | |
| --- | --- |
| directory cascade | a parent directory's `.rmanrc`, then the package's own, closest winning |
| `"[selector]"` blocks | `"[*]"` and any glob that matches this package's **name** |
| `extends` | configs merged *underneath* the file naming them |
| `value` | a key deriving from what the layers below it resolved to |
| `${{ ... }}` | evaluated for **this** package - `pkg`, `repository`, `file`, `env`, ... |

```bash
$ cd packages/a && rman config
# pkg-a (packages/a)
vars:
  registry: https://example.test
run:
  build:
    before:
      - echo base          # from the extended config
      - echo per-package   # from [...value, ...], added rather than replacing
    exec: tsc -b tsconfig-build.json   # the package's own, beating "[*]"
clean:
  include:
    - build
group: a-line
```

## Options

| Option | Alias | Description |
| --- | --- | --- |
| `--from-root` | `-r` | Print the repository root's config instead of the current package's. No effect when already at the root. |
| `--json` | - | Print JSON instead of YAML. **Nothing else on stdout**, so it can be piped. |

## Which package it is about

The same rule `run`/`exec`/`changelog` use: standing inside a package's own directory, that package;
anywhere else - the repository root, or a directory holding no package (an intermediate
`packages/`) - the root package. `--from-root` forces the root from inside a package.

Remember that the **root is a package too**, and that a `"[*]"` block is about the *others*: at the
root you see `allowBranch`, `version.*` and the plugins' root-level keys, and *not* what `"[*]"`
said.

## Two things to know about the output

- **The `#` lines are YAML comments**, so the whole thing is a loadable document - you can redirect
  it to a file. They are coloured only when stdout is a terminal, because an escape sequence inside
  a comment makes the document unloadable rather than merely ugly.
- **`version.before`/`.exec`/`.after` are printed raw**, and the output says so when they are
  present. `${{ pkg.targetVersion }}` cannot be evaluated before `version` has computed a plan, so
  the repository deliberately leaves those three unevaluated at load - see
  [`version`](version.md#hooks-and-the-version-being-written). Every other expression is already
  resolved.

## `rman config` or `<command> --config`?

Two questions, and they are not the same one:

| | |
| --- | --- |
| `rman config` | **What is this package's config?** One package - the one you are standing in - and all of it. No command involved. |
| `rman build --config` | **What would this command run with?** Its parsed options, the packages it would act on after `--scope`/`skip`, and the `.rmanrc` keys *it* reads. |

Reach for the second when a command behaved unexpectedly, and the first when you want to read a
package's config as such. See
[cli-rman.md#--config-what-would-this-command-run-with](../cli-rman.md#--config-what-would-this-command-run-with).

## See also

- [`docs/rman.md#configuration-rmanrc--rmanrcyml`](../rman.md#configuration-rmanrc--rmanrcyml) - the
  complete key reference, the cascade rules, and what an expression can read.
- [`docs/cli/run.md`](run.md) - the `run.<script>` keys this most often gets used to debug.
