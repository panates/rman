<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

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
| `"[selector]"` blocks | `"[/]"` for the root, `"[platform:node]"` for a technology, and `"[*]"` / any glob matching this package's **selector** (its name, unless its `.rmanrc "name"` says otherwise) - nested blocks included |
| `extends` | configs merged *underneath* the file naming them |
| `value` | a key deriving from what the layers below it resolved to |
| `${{ ... }}` | evaluated for **this** package - `pkg`, `repository`, `file`, `env`, ... |

```bash
$ cd packages/a && rman config
# .rmanrc
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

Remember that the **root is a package too**, and gets what any package gets from the levels above
it: every unmarked key, `"[/]"`, and a matching `"[platform:...]"` block. In a **monorepo** a glob -
`"[*]"` included - never reaches the root, so what `"[*]"` said is not in its output; in a
single-package repository the root *is* the one package, and `"[*]"` reaches it like `"[/]"` does.

## What to know about the output

- **The first line names the config file the directory declares** (`.rmanrc`, `.rmanrc.yml`,
  `.rmanrc.cjs`, ...) - the file to open first. It is omitted where the directory declares none,
  since the answer then lies a level above. It is a starting point, not the provenance: the printed
  config also holds the directories above, every `extends` base and each `"[selector]"` block. A
  failing `${{ }}` expression names the file its key came from.
- **The `#` lines are YAML comments**, so the whole thing is a loadable document - you can redirect
  it to a file. The document is syntax-coloured only when stdout is a terminal - keys, `${{ }}`
  expressions and literals each in their own colour - because an escape sequence inside a comment
  makes the document unloadable rather than merely ugly. For the same reason no status line is
  drawn around this command.
- **The contribution keys are left out** - `plugins`, `platforms`, `commands` and `publishTargets`.
  They are code (a technology, a command, a publish target), and every repository carries the
  default presets' entries, so printing them would bury the few keys the repository actually sets.
  Which technologies are loaded is [`rman info`](info.md)'s `Platforms` line, which one claimed each
  package [`rman list`](list.md)'s `Platform` column, and which commands exist `rman --help`.
- **A value written as a function prints as `[Function: name]`** - a step in a JS config, say -
  rather than breaking the YAML or, under `--json`, silently vanishing.
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
