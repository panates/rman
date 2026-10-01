<!-- verified against commit 11dd8d1 - see ../cli-rman.md for the baseline convention -->

# A repository's own commands (`.rman/*.mjs`)

A module in `.rman/` at the repository root becomes an `rman` command, named after its file:

```js
// .rman/deploy.mjs
import { defineCommand, PublishService } from 'rman';

export default defineCommand({
  describe: 'Ships what was just published to the staging cluster',
  builder: y => y.option('stage', { choices: ['dev', 'prod'], demandOption: true }),
  async handler({ repository, package: pkg }, args) {
    const plan = await PublishService.getPlan(repository);
    for (const entry of plan.filter(e => e.status === 'publish')) {
      console.log(`${entry.package.name} -> ${args.stage}`);
    }
  },
});
```

```bash
rman deploy --stage prod
rman --help            # listed alongside the built-ins, under its own describe
```

## Where rman looks (`.rmanrc "commands"`)

`.rman/*.{js,mjs,cjs}` is the **default value** of a config key rather than a directory rman
knows about, so a repository that keeps its commands elsewhere names them:

```yaml
commands: ['tools/commands/*.mjs']
```

- **A relative glob is anchored to the file that declared it**, not to the repository root - which
  is what lets a shared config ship commands of its own (`commands: './commands/*.js'` inside a
  published package means that package's directory). Note that `plugins` does *not* behave this
  way: a relative path there resolves against the repository root whatever file declared it.
- **It always appends**, like `plugins`: naming a directory of your own never means "and stop
  loading the ones my shared config ships". A closer layer therefore cannot *un*-say one.
- **Declared at any level.** A package's own `.rmanrc` may contribute commands; they are still
  repository-wide, because there is one command list.
- **Declaring it anywhere replaces the `.rman/` default**, since the key appends across layers
  rather than onto a built-in fallback. Name `.rman/*.mjs` yourself if you want both.
- **`.ts` is not loadable.** rman imports these in its own process with no loader registered, so a
  TypeScript repository compiles them first or writes them as `.mjs`.

## Two forms

A module exports either the `defineCommand({ ... })` object above, or the **declarative** factory
a plugin would use - options as data rather than a hand-written `builder`, so the flag list cannot
drift from what the handler reads:

```js
// tools/commands/deploy.mjs
export default app => ({
  describe: 'Ships what was just published to the staging cluster',
  config: { stage: { target: 'cli', choices: ['dev', 'prod'], demandOption: true } },
  handler: async args => console.log(`${app.repository.rootPackage.name} -> ${args.stage}`),
});
```

The factory is handed the `RmanApplication`, and runs once the repository exists. Either form takes
its name from the file when its metadata declares no `command`.

## When this, and when `run.<script>`

They overlap, and the line between them is worth keeping:

| | |
| --- | --- |
| A shell step across every package, in dependency order | [`.rmanrc "run.<script>"`](run.md) |
| A *tool* run in every package, with no script to name it | a command, using `context.forEachPackage` |
| One repository-level operation with logic of its own - branching, its own CLI options, rman's services | `.rman/*.mjs` |

Writing a loop over every package here means reimplementing `run`'s scheduling, topological order,
`bail` and progress panel - and losing them. Reach for this when the work is *one* thing that needs
real code, not when it is the same shell command repeated.

You can get most of the way with neither: `run: { deploy: "node .rman/deploy.mjs" }` already gives
you `rman run deploy`. What a command module adds is `rman deploy` itself, a place in `--help`, its
own options, and a `Repository` handed to you instead of constructed.

## The module

| | |
| --- | --- |
| `describe` | **Required** - without it `rman --help` has nothing to list the command by. |
| `handler(context, args)` | **Required.** `args` is the parsed argv; `context` is below. A *declared* command (the other form) takes the same two the other way round - `handler(args, context)`, because every one already written was `handler(args)` and appending a parameter breaks none. |
| `builder` | Optional [yargs](https://yargs.js.org) builder, for the command's own options. |
| `command` | Optional yargs command string, for positionals (`'deploy <stage>'`). Defaults to the file's own name. |
| `configKeys` | Optional - which `.rmanrc` keys `--config` should show for this command. See below. |

`context` is an object rather than loose parameters, so later additions don't break commands
already written against it:

| | |
| --- | --- |
| `context.repository` | the `Repository` - every package, the root, its config |
| `context.package` | the package whose directory rman was invoked *from*, or `undefined` at the repository root (and in a single-package repository, which is always "at the root") |
| `context.runBin(bin, argv, opts?)` | the repository's locally installed binaries, already carrying **this run's** `cwd` (the repository root) and log level |
| `context.logger` | at this run's resolved level, for the command's own narration |
| `context.forEachPackage(packages, fn, opts?)` | runs `fn` once per package under the scheduler `run` uses - see below |
| `context.parallel(tasks, opts?)` | `Promise.all` under the repository's concurrency rule, for work that is not per package |

`context.package` is the same `Repository.currentPackage` the built-in commands scope themselves by.
A command that only makes sense inside a package should say so itself rather than assume.

`runBin` and `logger` are **handed over rather than imported**, and that is the point of a context
existing beside the application: importing `runBin` straight from `'rman'` gets a helper that knows
neither the directory nor the log level, so `--log-level silent` would quietly not apply to the one
part of the command that produces output.

Everything else comes from `import { ... } from 'rman'` - `VersionService`, `PublishService`,
`ChangelogService`, and the rest of the [programmatic API](../rman.md).

### Doing something in every package

**Do not write the loop.** `for (const pkg of packages) await runBin(...)` ignores `--parallel`
outright, draws no progress panel, and leaves the command re-implementing `--bail` and a summary
line beside rman's own. `context.forEachPackage` is the scheduler `rman run` uses, offered to a
command that is not running a script:

```js
await context.forEachPackage(
  checkable,
  async ({ pkg, runBin }) => {
    await runBin('dpdm', ['--exit-code', 'circular:1', 'circular', './src/index.ts']);
  },
  { label: 'check', ...readParallelOptions(args) },
);
```

`fn` is handed exactly what a [function step](../rman.md#function-steps) gets - `pkg`, `cwd`, a
`runBin` **already bound to that package's directory** and this run's log level, and a `logger`. It
fails by throwing, as a step does; `forEachPackage` throws once at the end if any package failed,
with the panel's recap and the failing output already printed.

| option | default | |
| --- | --- | --- |
| `parallel` | CPU count | `true`/omitted = CPU count, a number = that many, `false` = serially |
| `bail` | `true` | stop the batch at the first failure |
| `topo` | **`false`** | wait for a package's dependencies before running it |
| `progress` | `true` | the live panel; auto-disabled when stdout is not a TTY |
| `label` | `each` | the panel's title and the word in the failure - the command's own name reads best |

**`topo` defaults to `false` here, unlike `run`'s.** A command sweeping packages with a tool that
reads each one's own sources is the common case, and a wait nobody asked for costs the whole point
of the call.

**Measured, on `panates/opra`:** `rman check` as a sequential loop took **8.6s** over nineteen
packages; through the scheduler at CPU concurrency it takes **1.7s**.

Declare the flags with the shared `parallelOptions` group (`--parallel`, `--bail`, `--progress`) and
read them back with `readParallelOptions`, the same way `packageFilterOptions` is spread - restating
them is how `--parallel` comes to accept a number on one command and not on another. The `.rmanrc`
key for the unset case is the **command's own** (`check.concurrency`), not `run.<script>`.

`context.parallel(tasks)` is the lower-level half, for work that is not per package - sharding a
file list, say. It buys the concurrency limit and nothing else: a bare list of functions carries no
name, so there is no panel row to label, nothing to name in a failure, and no dependency to order
by. Reach for it second.

`.js`, `.mjs` and `.cjs` load, the same forms a `.rmanrc.cjs`/`.mjs`/`.js` config already accepts.
A `.ts` command would need a loader registered inside rman's own process - a separate question from
this one.

### Declaring what config the command reads

**`rman <your command> --config` works without you doing anything** - the flag is applied where
commands are registered, so it reaches yours too and your handler is not called. By default it
prints the whole effective config, which is the honest answer when nothing has said which part
matters. `configKeys` narrows it:

```js
export default defineCommand({
  describe: 'Ships what was just published to the staging cluster',
  /** Dotted paths, or a function of the parsed argv when the answer depends on it -
   *  `run <script>` uses `args => ['run.' + args.script]`. */
  configKeys: ['vars.cluster', 'publish.target'],
  async handler({ repository }, args) {
    /* ... */
  },
});
```

Declared here rather than in a list inside rman, so it cannot drift out of step with the code that
does the reading.

## When something is wrong

- **A module that can't be loaded** - a syntax error, no default export, a missing `describe` or
  `handler` - is reported and skipped:

  ```
  Skipped ".rman/deploy.mjs": "describe" is missing - `rman --help` has nothing to list the command by without it
  ```

  Skipped, not fatal: one unparseable file has no business taking `rman publish` down with it. The
  warning names the file and the reason, because "my command isn't there" is otherwise a long
  afternoon.

- **A module that would shadow a built-in** is an error, and rman stops:

  ```
  ".rman/publish.mjs" would shadow rman's built-in "publish" command.
    Rename the file, or give it its own name with `command: '<name>'`.
  ```

  Unlike a broken module, the file here is fine - the *name* is the mistake, and there is no reading
  of `rman publish` that is safe to guess at. Preferring either one silently would leave whoever
  typed it unable to tell which ran.

A repository with no `.rman` directory loads nothing and scans nothing, so this costs it nothing -
which matters, because every `rman` invocation would otherwise pay for it.

## See also

- [`rman run`](run.md) - the other way to add a named operation, for shell steps across packages.
- [`docs/rman.md`](../rman.md) - the services a command module imports.
