# Output: run log, reporters, status line, `rman config`

Design decisions moved out of `CLAUDE.md`. Covers `LogSink`, `PlainReporter` / `PanelReporter`, `StatusRegion`, `ProgressPanel`, `rman config` printing.

## The run log: global `--json` and `--log-file`

[`core/classes/log-sink.ts`](../../packages/rman/src/core/classes/log-sink.ts), built per invocation in `cli.ts`'s
`interceptStatusLines` and held on `RmanApplication.logSink`. `--json` makes stdout JSON Lines
events (`start`/`output`/`end`/`summary`/`message`) and nothing else; `--log-file` writes the same
log to a file, JSON under `--json` and text otherwise.

- **Global, not per command - the user's call, and the reason is the subject.** It decides the
  *console's format*, which is a property of the invocation; a per-command `--json` would be a
  second place to state it for every command that grows a log.
- **A log is not an answer, and the six commands with their own `--json` keep theirs**
  (`list`, `version`, `publish`, `config`, `info`, `github-release`, detected as `ownsJson` from
  `'json' in meta.config` and carried through `toYargsCommand` like `printsDocument`). The shared
  release workflow `jq`s `rman publish --dry-run --json` and `rman list --json`; their stdout must
  stay one document. **The `!spec.ownsJson` guard is not reachable today** - none of those writes
  to the log - so `cli-log.spec.ts` pins the contract and its control stays green (measured).
- **Only `RunService.schedule` writes events**, so `run`/`build`/`test` and any `forEachPackage`
  command. Everything else given either flag warns on stderr (`warnUnhonoured`), detected from
  `sink.used` rather than listed. Warn, not refuse: a log option must not be the reason a release
  step fails. Not under `--config`, which runs nothing on purpose.
- **Under `--json` there is no screen reporter at all** (`RunService.reportersFor`), so nothing
  but the sink's events reaches stdout. The panel is constructed disabled, and the recap is counted
  once with `panel.tally()` and then reported - a screen reporter prints it from that same tally,
  so the summary event and the prose recap cannot disagree.

## Reporters: an event is produced once, and rendered by each

[`core/classes/log-sink.ts`](../../packages/rman/src/core/classes/log-sink.ts) (`Reporter`, `LogSink`),
[`core/classes/run-reporters.ts`](../../packages/rman/src/core/classes/run-reporters.ts) (`PlainReporter`,
`PanelReporter`). `RunService.schedule` builds `start`/`output`/`end`/`summary` events and hands each
to every reporter the run has: the screen (the panel's rows, or plain lines, or nothing under
`--json`) and `LogSink` (`--json` stdout and `--log-file`).

- **It replaced four branches at the place a line was produced** - panel row, plain screen,
  `--json`, file - and the package prefix is what showed the cost: one more thing to do with a line
  meant touching each branch. A new destination is a reporter now, never another branch.
- **winston and consola were weighed and not taken**, on the user's question. Both offer the shape;
  both would mean translating these typed events into a log record and back, while the set of
  destinations is closed. winston also writes files asynchronously, which loses the last lines of an
  interrupted run - the ones that say why. pino writes from a worker thread, which loses ordering.
  The panel and spinner are not logs in any of them, so that reporter would be ours either way.
- **A plain run leads every line with its package** (`pkg ┆ line`). Packages run at once and a
  step's status line comes only after its output, so unlabelled, an error read as the package
  printed just above it - reported on opra, `@opra/api-ui`'s TS2307 under `@opra/openapi ┆ after
  success`. The log's `output` event carries the package as a field instead.
- **A reporter writes a step's lines to the stream, never through `console`**: a function step's
  `console` is captured and arrives as `output` events synchronously, inside that step's async
  context, so a `console.log` from the reporter would be captured again. Step lines and the recap are
  written outside any step and keep using `console`.
- **`childEnv` is the reporter's to say**: the plain screen asks for `FORCE_COLOR` where our stdout
  is a terminal; the panel does not, since a row's width is measured and escape codes would count as
  text.
- **A nested `rman` in a step is not told**, so its own status line and recap arrive as `output`
  events. Measured in opra (`before: rman check`): correct, and visible in the log.
- **Measured in opra under `script`**: 444 lines, every one parses, no escape codes, and the file is
  byte-identical to stdout.

## The status line around every command

[`utils/status-region.ts`](../../packages/rman/src/utils/status-region.ts), installed by
`cli.ts`'s `interceptStatusLines`. A spinner, the command's name, the repository and a clock
counting up while it runs; a `✔`/`✖` line with the elapsed time when it ends.

- **The complaint it answers is "did it even run".** `rman lint` on a clean repository is silent for
  several seconds - eslint says nothing when it has nothing to say - and a static start line answers
  "did it start" without answering "is it still going".
- **One interception point, not a line per command**, which is the rule `--config` already follows:
  every command reaches yargs through `program.command`, so wrapping that one method is what makes
  it universal. A line each command remembers to write is the same failure one step removed.
- **`printsDocument` is the opt-out, declared on the command** - `config`, `list`, `info`, `diff`,
  `changelog`. Their stdout *is* the answer, and for `config` a line above it makes the YAML
  unloadable. Declared rather than listed in `cli.ts`, which is the rule `builtInNames` follows: a
  central list is a second place to state a fact the command owns, and it could not reach a
  *contributed* command at all.
  - **The field has to be carried through `toYargsCommand`**, beside `configKeys`. Measured by
    leaving it out: `config` declared `printsDocument: true` and still printed a status line above
    its own document, because `cli.ts` reads the *registration* and the flag never got there. Pinned
    by the one spec that turns red when that line is reverted.
- **`--json` and `--config` are checked, not declared**: any command may grow a `--json`, and a
  consumer doing `rman version --json | jq` must never receive prose.
- **On stderr, and `LiveRegion` took a `stream` parameter for it.** A command's answer goes to
  stdout, so `rman changelog > NOTES.md` has to leave the notes alone in the file - cursor-movement
  codes in there are worse than noise. `ProgressPanel`'s region keeps stdout, unchanged.
- **The command's own writes are moved above the spinner** (`StatusRegion.guardWrites`): while the
  line is live, every `process.stdout`/`process.stderr` write erases it, writes, and draws it again
  below. Measured with `script`: `rman deps` printed its plan with `console.log`, the final erase
  moved up one row from *below* the plan, and its last line - the one dependency it was reporting -
  was gone, leaving a "not updated" heading with nothing under it; `version --show` lost "Nothing to
  version." the same way. A rule that every command route its output through `passThrough` is one
  each new command would have to remember, so the region does it.
  - **Left alone while suspended** - the panel that took over writes to stdout itself - and **a
    write ending mid-line holds the next frame back**, or the frame's `\r` + erase would wipe it.
  - **A child process is not covered**, because its writes never pass through this process's
    streams. That is what the next bullet is about.
- **A live region forces `runBin` to pipe**, and that is not a preference. The region redraws by
  moving the cursor up N rows; a child writing straight to the terminal scrolls the screen, so the
  next redraw erases what the child just printed. So output goes through `passThrough` - erase,
  write, redraw below - which is the arrangement `RunService` already makes for the progress panel.
  `FORCE_COLOR=1` goes with it, or eslint sees a pipe and drops the colour it had.
  - **It is added *onto* a base environment and must never be written as one.** `BinPath.env`'s
    `env` option is the environment to *derive from* - it stands in for `process.env` rather than
    extending it - so `{ FORCE_COLOR: '1', ...options.env }` handed over with no `options.env` left
    the child holding that single variable and a PATH of nothing but the contributed directories.
    Shipped in 2.3.0 and it broke every `runBin` call made while a region is live, which is all of
    them. Measured on `panates/sqb`: `rman test` still *found* npm - the node walk ends at the
    running interpreter's own directory, where npm sits - and npm then died `spawn sh ENOENT`,
    because `/bin` was not on the PATH it was given.
  - **Why it took a repository to find it.** A binary run straight out of `node_modules/.bin`
    survives a PATH like that: its `#!/usr/bin/env node` shebang is resolved by absolute path and
    `node` is the one entry the walk does append. eslint, prettier and tsc all pass. What fails is a
    child that spawns a *shell* - `npm run` being the one every repository types - so the preset's
    `lint`, `check` and `format` were green while `test` was not. **A spec covering a `runBin` env
    has to run something that spawns `sh` itself**, which is what `run-bin.spec.ts` does.
- **Only one region draws at a time, and `suspend`/`resume` is what enforces it.** `LiveRegion`'s
  doc has claimed this since it grew a `stream` parameter and nothing held it: every command gets a
  status region, and `run`/`build`/`exec`/`clean`/`ci`/`changelog` additionally start a
  `ProgressPanel`, so two regions redrew on one terminal. Each moves the cursor up by **its own**
  line count, so interleaved every redraw lands on the other's rows - on screen the bottom lines
  swap places several times a second. Reported on `rman ci`; `rman build` had it too, by a second
  route (`runBin`'s pass-through went to the status region while the panel was drawing).
  - `ProgressPanel.start(statusRegion)` takes the terminal and `stop()` hands it back. **Every
    panel site passes `app.statusRegion`** - five of them, and a new one that forgets reintroduces
    the flicker with nothing reporting it.
  - **A disabled panel hands the terminal to nobody, and the status line is silenced anyway.** This
    said the opposite - "a disabled panel owns nothing, and suspending the status line would remove
    the one thing such a run still shows" - and that held only while children inherited the
    terminal. With no panel, `run` now pipes every child and prints its lines itself (below), and a
    spinner redrawing in place moves the cursor up over whatever was printed since. Under
    `--no-progress` the CLI never draws the line at all; `schedule` silences a live one for the run
    in the other cases (config `progress: false`, or stdout redirected while stderr is a TTY).

- **With no panel, a child runs without a terminal** (`pipe` + `onLine`, printed by `PlainReporter`
  to the stream it came from, led by its package). A child that finds a TTY draws its own live output, and a build is mostly
  other CLIs - the shared preset's `run.build` is `rman check`, `rman lint`, `rman clean`, `tsc`.
  Reported as `rman build --no-progress` printing progress and losing its logs; under a real
  terminal one short build had **149 spinner frames and 154 cursor-ups, 0 and 0 after**.
  - **No TTY rather than telling children about `--no-progress`.** An environment variable was
    built first and dropped: it reaches nested rman and nothing else, while `npm`, a test runner's
    reporter or `docker build` would go on drawing. No TTY is the convention every well-behaved CLI
    already honours - nested rman included, whose panel reads `process.stdout.isTTY`.
  - **`FORCE_COLOR` brings the colour back and nothing else** (`colorsPrintedOutput`: our stdout is
    a terminal, `NO_COLOR` unset). Tools gate their live output on `isTTY`, which stays false.
  - **`runBin`'s `onLine` buffers per stream now**, as `exec`'s always did. It split each `data`
    chunk on its own, so a line arriving in two pieces became two lines - harmless while the only
    reader was a panel row's last line, wrong once every line is printed.
  - The cost, stated: a child cannot prompt. Nothing in a run step should.
  - **Measuring it needs a pseudo-terminal** (`script -q out.txt <cmd>` on macOS) - without one
    nothing draws either way. And count escape codes with `grep -E`: BSD grep's basic regex has no
    `\|`, and a `\|` pattern reported zero colour codes in output holding 1800.
  - **`live` stays `true` while suspended, deliberately.** It answers "does something own this
    terminal", which is what `runBin` reads to decide to pipe a child rather than let it scroll the
    screen; the answer to *which* region is `takeover`, which `passThrough` forwards to. Making
    `live` false instead would have let every `runBin` child inherit the terminal and scroll over
    the panel - the failure the piping exists to prevent.
  - **The panel's header carries the suspended line's content** (`ProgressPanel.detail`, set to
    `repository.name` at all five sites). Suppressing the status line without moving its content
    took the command and the repository off the screen, which was reported immediately. The badge
    already names the command, so what moved is the repository - **at the right end of the header,
    not between the badge and the bar**: there it would push every column right by the length of a
    repository name, so the bar, the counts and the clock would sit somewhere different in each
    repository. The tail is empty space in every terminal the panel fits in.
  - **`TerminalRegion` is `passThrough` and nothing else.** `StatusRegion.live` and
    `ProgressPanel.enabled` are the same question under two names, and `ProgressPanel.live` is the
    `LiveRegion` itself - putting `live` in the contract would force a rename for no gain.
- **The region lives on `RmanApplication.statusRegion`**, not in a module-level singleton. `runBin`
  and `exec` are handed an `app` already - the same seam `BinPath` uses - so nothing reaches for
  ambient state and one spec's application cannot affect another's. That is what the removed root
  hooks were about.
- **The spinner's interval is `unref`'d**, or a command that finishes its work waits out the frame
  before the process can exit.
- **Not drawn when stderr is not a TTY**, where the escape codes mean nothing - but the result line
  still prints, which is the half a CI log wants. `cli.spec.ts` therefore sees **one** line, not
  two; the live half is `status-region.spec.ts`, which builds the region with `enabled` forced on.

## `rman config` - the resolved config, for the directory you are standing in

[`src/commands/config.command.ts`](../../packages/rman/src/commands/config.command.ts). Prints
`Package.config` for `Repository.currentPackage` (the root package otherwise, and with `--root`),
which is the *resolved* object - directory cascade, `"[selector]"` blocks, `extends` and
`${{ }}` all already applied. It computes nothing of its own; the value it prints is the one every
command reads, which is the point of having it.

- **YAML by default, `--json` for piping.** The header and notes are `#` comments so the YAML form
  is a loadable document.
- **Colour only when `process.stdout.isTTY`, and that is correctness rather than taste.** An escape
  sequence inside a `#` comment makes the document *unloadable*: `rman config > rmanrc.yml` wrote a
  file js-yaml refuses with "the stream contains non-printable characters" (measured - `ansi-colors`
  does not disable itself for a pipe here). Its spec strips colour rather than assuming there is
  none, because mocha run from a terminal *has* a TTY and would otherwise fail only on a developer's
  machine.
- **It must say when a value is printed raw.** `version.before`/`.exec`/`.after` are in
  `DEFERRED_PATHS`, so `${{ pkg.targetVersion }}` is still an expression here - printed among
  resolved values with no note, it reads as interpolation being broken.
- **The contribution keys are left out** - `plugins`, `platforms`, `commands`, `publishTargets`
  (`CODE_SUBTREES`), through `withoutContributions` in
  [`utils/printable-config.ts`](../../packages/rman/src/utils/printable-config.ts). They are code, and
  this command answers what a repository is *configured* to do. It stopped being a detail the day
  presets went under every root: measured on this repository, `rman config` printed the npm target's
  entire option table, a platform's manifest provider and `commands: ['[Function]', '[Function]']`
  above the two keys the `.rmanrc` actually sets - forty lines of metadata over three of config.
  - **Silently, and that was argued the other way first.** A note announcing the omission looked
    like the sibling of the deferred-paths one below, and is not: that note explains a *visible*
    oddity, this announced an absence the reader was not looking for. What settled it was measuring
    the condition meant to make it rare - presets go under every root, so every config carries all
    four and the line printed **every time**, which makes it a banner rather than a report. At this
    repository's root it was one line of three. A reader asking which technologies are loaded is
    asking `rman info`; one asking whether their command registered is asking `rman --help`.
  - **`--config` does the same**, in its "in full" branch only - its narrowed branch already picks
    the keys the command reads. The two printers cannot disagree about what the config is.
  - **Distinct from `printableConfig`, which makes a value serializable rather than deciding what is
    worth showing.** A step written as a function still prints as `[Function: copyDocs]`; that one
    *is* a setting. Both live in the same module because both callers are printers.
  - **It imports `CODE_SUBTREES` rather than listing those four names again.** Two lists that can
    disagree is the failure this tree had already: `presetNames()` held a hardcoded `['node']`
    beside a resolver that looked somewhere else, and the error message named the preset it had just
    failed to find.
- **The first line is the config file the directory declares** (`ConfigReader.findConfigSource`,
  public for this caller), because the reader's next question is which file to open. Omitted where
  the directory declares none - naming one that is not there sends them to create a file when the
  answer is a level above.
  - **It is the package's *own* file and the printed config is more than it**: the directory chain
    above, every `extends` base and each `"[selector]"` block are all in there. The per-key answer
    is `ORIGINS`, which a failing expression's message already names; this line is a starting point,
    not the provenance.
  - **Find the header, don't index it.** Three cases asserted `lines[0]` and all three broke on a
    change that was about something else; `config.command.spec.ts` has a `headerOf(lines)` helper.
- **Syntax colour, on a terminal only** ([`utils/color-yaml.ts`](../../packages/rman/src/utils/color-yaml.ts),
  shared with `--config`). Key in cyan, `${{ }}` in magenta, literals in yellow, list markers and
  `[Function]` in grey - and a plain string value left alone, because it is the content and
  colouring it competes with the key for attention.
  - **`${{ }}` in magenta earns its place**: `version.before`/`.exec`/`.after` are printed raw, so
    an unresolved expression among resolved values is *correct* here, and the colour is what keeps
    it from reading as interpolation being broken.
  - **A line-based highlighter, with one piece of state: an open block scalar.** `lineWidth: 100`
    makes js-yaml fold a long string into `key: >-` plus deeper-indented prose, and a continuation
    line holding `(default: ...)` would otherwise have half a sentence coloured as a key, with a
    `#` in one read as a comment. Everything else is per line; a value's own colon is not a problem
    because js-yaml quotes any scalar holding one and the key pattern stops at the first.
- Distinct from [`rman config`](../../docs/cli/config.md), and keep them distinct: that prints one
  package's whole config with no command involved; this answers "what would *this command* do".
