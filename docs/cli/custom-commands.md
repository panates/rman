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

## When this, and when `run.<script>`

They overlap, and the line between them is worth keeping:

| | |
| --- | --- |
| A shell step across every package, in dependency order | [`.rmanrc "run.<script>"`](run.md) |
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
| `handler(context, args)` | **Required.** `args` is the parsed argv; `context` is below. |
| `builder` | Optional [yargs](https://yargs.js.org) builder, for the command's own options. |
| `command` | Optional yargs command string, for positionals (`'deploy <stage>'`). Defaults to the file's own name. |
| `configKeys` | Optional - which `.rmanrc` keys `--config` should show for this command. See below. |

`context` is an object rather than loose parameters, so later additions don't break commands
already written against it:

| | |
| --- | --- |
| `context.repository` | the `Repository` - every package, the root, its config |
| `context.package` | the package whose directory rman was invoked *from*, or `undefined` at the repository root (and in a single-package repository, which is always "at the root") |

`context.package` is the same `Repository.currentPackage` the built-in commands scope themselves by.
A command that only makes sense inside a package should say so itself rather than assume.

Everything else comes from `import { ... } from 'rman'` - `VersionService`, `PublishService`,
`ChangelogService`, and the rest of the [programmatic API](../rman.md).

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
