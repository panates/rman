<!-- verified against commit 8430603 (2.14.0) - see ../cli-rman.md for the baseline convention -->

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
| `--progress` | - | boolean | `true` | Show a live progress panel (auto-disabled when stdout is not a TTY). Each row names the command being run. With the panel off, each package gets an `exec <pkg> <command>` line and a result line, and the command inherits the terminal. |
| `--changed` | `-c` | boolean | `false` | Only run in packages you have touched but not pushed - uncommitted, or committed and not yet on the upstream branch. |
| `--changed-since <hash>` | - | string | - | Only run in packages that have changed since the given git commit/hash. |
| `--from-root` | `-r` | boolean | `false` | Run across the whole repository even when standing inside one package's own directory. No effect elsewhere. |

`--changed`/`--changed-since` conflict (pick one). `exec` honours `.rmanrc "skip"`, and - like
`run` - refuses a dependency cycle (`Dependency cycle: a -> b -> a`) before running anything, unless
`--no-topo` is given - see [`run`](run.md#options).

`exec` does not run through `run`'s scheduler, so the global
[`--json` and `--log-file`](../cli-rman.md#the-run-log---json-and---log-file) write nothing for it -
it says so on stderr and runs as usual.

`command` (the positional) doesn't need its own
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
