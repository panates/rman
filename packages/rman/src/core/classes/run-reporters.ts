import colors from 'ansi-colors';
import { colorsPrintedOutput } from '../../utils/run-bin.js';
import type { LogEvent, Reporter, ReportOrigin } from './log-sink.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';
import type { ProgressPanel } from './progress-panel.js';

/**
 * The screen with no live panel: each line a step prints, led by its package, and one line per step
 * when it ends - the output `--no-progress`, a pipe or CI gets.
 */
/* **Every line names its package.** Packages run concurrently, so one package's lines land between
 * another's, and a step's own status line comes only once the step has ended - *below* its output.
 * Unlabelled, a compiler error read as the package whose line happened to sit above it: reported on
 * opra, where `@opra/api-ui`'s TS2307 printed under `@opra/openapi ┆ after success` and the
 * `api-ui ┆ exec failed` it belonged to came three lines later.
 *
 * **A step's lines are written to the stream, never through `console`.** A function step's own
 * `console` is captured and arrives here as `output` events, synchronously and still inside that
 * step's async context - so a `console.log` from here would be captured again and come straight
 * back. The step lines and the recap are written outside any step and use `console` as they always
 * did. */
export class PlainReporter implements Reporter {
  readonly childEnv: Record<string, string> | undefined;
  /** Four letters per level, as winston and log4j-style formats shorten them - `ERROR` keeps its five. */
  protected readonly levelTags: Readonly<Record<Exclude<LogLevel, 'silent'>, string>> = {
    error: 'ERROR',
    info: 'INFO',
    verbose: 'VERB',
  };

  constructor(
    /** What the per-step lines call the run - `run`, `build`, `check`. */
    protected readonly commandName: string,
    /** Whose tally the recap prints; absent for a reporter that only says rman's own messages. */
    protected readonly panel?: ProgressPanel,
  ) {
    /** A child is run without a terminal and its lines are printed by rman, so it would drop its
     *  colour; this brings it back where our own stdout is a terminal - and only the colour, since
     *  tools gate their live output on `isTTY`, which stays false. */
    this.childEnv = colorsPrintedOutput() ? { FORCE_COLOR: '1' } : undefined;
  }

  report(event: LogEvent, origin?: ReportOrigin): void {
    switch (event.event) {
      case 'start':
        if (origin) this.started(event, origin);
        return;
      case 'output':
        if (origin) this.output(event, origin);
        return;
      case 'end':
        if (origin) this.ended(event, origin);
        return;
      case 'summary':
        this.panel?.printSummary();
        return;
      case 'message':
        console.log(event.level === 'error' ? colors.red(event.message) : colors.gray(event.message));
    }
  }

  /** The `executing` line, at `verbose` only - rman's old behaviour, hidden by default. */
  protected started(event: Extract<LogEvent, { event: 'start' }>, origin: ReportOrigin): void {
    if (!this.atLeast(origin.logLevel, 'verbose')) return;
    console.log(
      this.levelTag('verbose'),
      this.commandName,
      colors.cyan(event.package),
      colors.gray('┆'),
      colors.cyanBright.bold(event.step),
      colors.cyanBright.bold('executing'),
      ...this.describing(origin),
    );
  }

  /** One line of a step's output, to the stream it came from, led by its package - in red when rman
   *  itself wrote the line to say why the step failed (`level: 'error'`). */
  /* **Red only where rman knows, and the stream is not knowing.** It was "red on stderr" for one
   * build, and every progress line went red with it: dpdm prints `Start analyzing dependencies...`
   * and `Analyze done!` to stderr, as spinner libraries do. In the other direction tsc writes its
   * diagnostics to **stdout** (measured: a type error, exit 2, one line on stdout, none on stderr).
   * Neither direction holds. A line is printed as it arrives, before anything knows whether its
   * step will fail, so what is left is the message rman writes itself - a function step's throw,
   * `runBin`'s `exited with code`. Reading the text for `error` is a guess: a test runner prints
   * "0 errors" on success. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the panel's override needs the row
  protected output(event: Extract<LogEvent, { event: 'output' }>, origin: ReportOrigin): void {
    const name = event.level === 'error' ? colors.red(event.package) : colors.cyan(event.package);
    const prefix = name + ' ' + colors.gray('┆') + ' ';
    (event.stream === 'stderr' ? process.stderr : process.stdout).write(prefix + event.line + '\n');
  }

  /** `[INFO] build pkg ┆ exec success ┆ tsc -b  (123 ms)` - suppressed below `info` unless it failed,
   *  and under `silent` even then. */
  protected ended(event: Extract<LogEvent, { event: 'end' }>, origin: ReportOrigin): void {
    const failed = event.status === 'failed';
    if (!failed && !this.atLeast(origin.logLevel, 'info')) return;
    if (failed && origin.logLevel === 'silent') return;
    console.log(
      this.levelTag(failed ? 'error' : 'info'),
      this.commandName,
      failed ? colors.red(event.package) : colors.cyan(event.package),
      colors.gray('┆'),
      colors.cyanBright.bold(event.step),
      failed ? colors.red.bold('failed') : colors.green.bold('success'),
      ...this.describing(origin),
      colors.yellow(` (${event.ms} ms)`),
    );
  }

  /**
   * A line's own level as `[INFO]`, `[VERB]`, `[ERROR]` - upper case, four letters but for `ERROR`, in
   * the level's colour.
   */
  /* **The line's level, not the package's threshold.** `origin.logLevel` decides which lines are
   * printed; the tag says what this line is. Printing the threshold would tag a success line `[VERB]`
   * in a package set to `verbose` - winston and the rest tag the message, not the logger. */
  protected levelTag(level: Exclude<LogLevel, 'silent'>): string {
    const tag = `[${this.levelTags[level]}]`;
    return level === 'error' ? colors.red(tag) : level === 'info' ? colors.green(tag) : colors.magenta(tag);
  }

  /** Whether `level` prints what `wanted` does. */
  protected atLeast(level: LogLevel, wanted: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(wanted);
  }

  /** The `┆ <what it runs>` tail of a step line, **or nothing at all** when the step has no label of
   *  its own - an anonymous function handed to `forEachPackage`, where the slot name already said
   *  everything and a separator with nothing after it is noise. */
  protected describing(origin: ReportOrigin): string[] {
    return origin.label ? [colors.gray('┆'), origin.label] : [];
  }
}

/**
 * The screen while the live panel draws: a step's lines go to its package's row - the last one
 * shown under it, all of them replayed if the package fails - and the recap lists every package.
 */
export class PanelReporter extends PlainReporter {
  /** A child's lines are only stored, and replayed into a row whose width is measured - colour
   *  would only be escape codes counted as text there. */
  override readonly childEnv = undefined;

  constructor(commandName: string, panel: ProgressPanel) {
    super(commandName, panel);
  }

  /** The row names the step itself; there is no separate line to print. */
  protected override started(): void {}

  protected override output(event: Extract<LogEvent, { event: 'output' }>, origin: ReportOrigin): void {
    origin.item.log.push(event.line);
    origin.item.lastLine = event.line;
  }

  /** The row shows the step's outcome; the recap prints the package's. */
  protected override ended(): void {}
}
