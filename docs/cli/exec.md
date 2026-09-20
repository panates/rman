<!-- verified against commit b6924c69810870582f615a81c97b587e4057910d - see ../cli-rman.md for the baseline convention -->

# `rman exec [command..]`

```
rman exec <command> [args...] [options...]
rman exec [options...] -- <command> [args...]
```

Runs an arbitrary shell command directly in each matching package's own directory - unlike
[`run`](run.md), it isn't tied to any `package.json` script and honors no `pre`/`post` npm
lifecycle convention. Package selection and scheduling otherwise match `run` exactly: dependency
order and per-package bail by default, the same live progress panel, and the same package-filter
options.

## Options

Accepts [package filtering](../cli-rman.md#package-filtering) and [branch guard](../cli-rman.md#branch-guard)
options, in addition to:

| Option | Alias | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--parallel <n>` | - | boolean \| number | CPU count | Max packages at once: omit/`true` for CPU count, a number for that many, `false` to run serially. Packages always run in dependency order unless `--no-topo`. |
| `--bail` | - | boolean | `true` | Stop on first failure. |
| `--topo` | - | boolean | `true` | Respect package dependency order: a package waits for its dependencies and is skipped if one fails. Set `false` to run in every matching package independently, alphabetically. |
| `--progress` | - | boolean | `true` | Show a live progress panel (auto-disabled when not a TTY). |
| `--changed` | `-c` | boolean | `false` | Only run in packages that have changed since the last publish. |
| `--changed-since <hash>` | - | string | - | Only run in packages that have changed since the given git commit/hash. |
| `--from-root` | `-r` | boolean | `false` | Run across the whole repository even when standing inside one package's own directory. No effect elsewhere. |

`--changed`/`--changed-since` conflict (pick one). `command` (the positional) doesn't need its own
flags escaped **unless** one of them happens to share a name with one of `exec`'s own options above
- in that case, put a bare `--` before your command so everything after it is treated as literal
arguments (yargs' own `populate--`/`unknown-options-as-args` parsing, configured specifically for
this command).

## Examples

```bash
rman exec rm -rf dist
rman exec -- eslint --fix                 # "--" needed here: --fix would otherwise confuse exec's own parser
rman exec --scope pkg-a -- ls -la
rman exec --topo=false pwd                # every package independently, alphabetical order
rman exec --parallel 2 -- npm audit
```

Running `rman exec` with no command at all (nothing after `exec`, and nothing after a `--`) throws
`No command given - e.g. "rman exec ls" or "rman exec -- eslint --bail"`.

## See also

- [`rman run <script>`](run.md) - the equivalent for an actual npm script, with pre/post hooks and
  `.rmanrc run.<script>.*` configuration.
- [`ExecService`](../rman.md#execservice) - the underlying service.
