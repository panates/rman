import colors from 'ansi-colors';
import { LiveRegion } from './live-region.js';
import type { StatusRegion, TerminalRegion } from './status-region.js';

export type ProgressStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface ProgressItem {
  readonly name: string;
  status: ProgressStatus;
  /** Label of the step currently running, for work with more than one step (e.g. `run`'s
   *  npm-script steps) - omit `stepsTotal` entirely for single-step work like a plain command. */
  currentStep?: string;
  /**
   * **What the current step actually runs** - the shell command, or a function step's name - shown
   * beside the label so a silent step says what it is.
   *
   * The label alone answers "which slot", which is what a reader already knows; a step sitting at
   * `before (2/9)` for ten seconds with nothing on stdout is the case this exists for, and it is
   * the common one for a build.
   */
  currentCommand?: string;
  stepIndex?: number;
  stepsTotal?: number;
  /** Last captured output line, shown dimmed under the item while it's running. */
  lastLine?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Captured output, printed back out if the item ends up failing. */
  log: string[];
}

export interface ProgressSummary {
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

export function formatDuration(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

/**
 * Shared live progress panel for any command that fans work out across packages: a spinner
 * header (progress bar, running/failed counts, elapsed time) plus one or two lines per
 * currently-running item, redrawn in place instead of scrolling - the same panel `run`/`build`
 * use, pulled out so other package-fanning commands (e.g. `ci`) can reuse it instead of
 * reimplementing it.
 *
 * Renders nothing when `enabled` is false (a non-TTY, or a command's own `--no-progress`) -
 * callers are expected to fall back to their own plain logging in that case, the way `run`
 * falls back to its "classic" per-step log.
 */
export class ProgressPanel implements TerminalRegion {
  readonly live: LiveRegion;
  private readonly items = new Map<string, ProgressItem>();
  private renderLoop?: ReturnType<typeof setInterval>;
  /** The region this panel took the terminal from, handed back in `stop`. */
  private statusRegion?: StatusRegion;
  /**
   * What the run is about - the repository name, shown beside the title. Assigned rather than
   * constructed with, the way a `ProgressItem`'s fields are: it keeps `stream` from needing an
   * `undefined` placeholder at four of the five call sites.
   */
  detail?: string;
  private spinnerFrame = 0;
  private startedAt = 0;

  /**
   * `stream` is where the panel is drawn - **stdout by default**, which is what `run` and `exec`
   * have always used. A command whose *answer* goes to stdout passes `process.stderr`, or
   * redirecting that answer into a file captures the panel's cursor-movement codes along with it:
   * `rman changelog > NOTES.md` is the case, and it is the same reason the status region moved.
   */
  constructor(
    private readonly title: string,
    enabled: boolean,
    stream?: NodeJS.WriteStream,
  ) {
    this.live = new LiveRegion(enabled, stream);
  }

  get enabled(): boolean {
    return this.live.enabled;
  }

  /** Registers an item and returns it - callers mutate the returned object directly (`status`,
   *  `currentStep`, `lastLine`, ...) to drive the next render tick. */
  addItem(name: string, stepsTotal?: number): ProgressItem {
    const item = new PanelItem(name, stepsTotal);
    this.items.set(name, item);
    return item;
  }

  /**
   * Starts the redraw loop. No-op (and no timer) when disabled.
   *
   * **Pass `statusRegion` wherever one exists** - `app.statusRegion`, which every command has while
   * it runs. The panel takes the terminal over for as long as it draws and hands it back in `stop`;
   * without that, two regions redraw on top of each other and the bottom lines visibly swap places
   * several times a second. See `StatusRegion.suspend`.
   */
  start(statusRegion?: StatusRegion): void {
    this.startedAt = Date.now();
    if (!this.live.enabled) return;
    /** Only when this panel is actually drawing: a disabled panel owns nothing, and suspending the
     *  status line for it would take away the one thing a non-TTY run still shows. */
    this.statusRegion = statusRegion;
    this.statusRegion?.suspend(this);
    this.renderLoop = setInterval(() => this.render(), 100);
  }

  /** Writes `text` above the panel without corrupting it - erase, write, redraw underneath. The
   *  `TerminalRegion` half of the takeover, so a `runBin` child's output goes somewhere sane while
   *  a panel is up. */
  passThrough(text: string): void {
    if (!this.live.enabled) {
      process.stdout.write(text);
      return;
    }
    this.live.clear();
    process.stdout.write(text);
    this.render();
  }

  private render(): void {
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const spinner = colors.cyan(SPINNER_FRAMES[this.spinnerFrame]);

    const total = this.items.size;
    let running = 0;
    let done = 0;
    let failedSoFar = 0;
    /**
     * **What the bar is filled from, and it is not `done`.** A finished item counts as a whole one;
     * a *running* item counts as the fraction of its own steps it has got through, so the bar moves
     * while a single item is working rather than only when one ends.
     *
     * Counting whole items made the bar useless exactly where it was needed most: `rman changelog`
     * writes one file under `changelog.groupBy: 'group'`, so the bar sat empty at `0/1` for the
     * entire run while the row beside it counted to 1825. `run` gains the same thing in the small -
     * a nine-step build now advances within the package instead of jumping at the end of it.
     */
    let filled = 0;
    for (const item of this.items.values()) {
      if (item.status === 'running') {
        running++;
        /** `stepIndex` is 0-based, so a step in progress is `index + 1` of `total` begun - and
         *  clamped, since a caller may report more steps than it first declared. */
        if (item.stepsTotal && item.stepIndex != null) {
          filled += Math.min(1, (item.stepIndex + 1) / item.stepsTotal);
        }
      } else if (item.status !== 'pending') {
        done++;
        filled += 1;
      }
      if (item.status === 'failed') failedSoFar++;
    }

    const header = colors.bgCyan.black.bold(` ${this.title} `);
    const bar = renderProgressBar(filled, total);
    const totalElapsed = formatDuration(Date.now() - this.startedAt);
    const failedText =
      failedSoFar > 0 ? colors.red.bold(`${failedSoFar} failed`) : colors.gray(`${failedSoFar} failed`);
    /**
     * **The header says what is running, because nothing else does any more.** The status line used
     * to carry `ci opra` beside this panel; it is suspended now so the two stop redrawing over each
     * other, and suppressing it without moving its content here took the command and the repository
     * off the screen entirely. The badge already names the command, so what had to move is the
     * repository.
     *
     * **At the right end, where the line has room.** Between the badge and the bar it would push
     * every column right by the length of a repository name - so the bar, the counts and the clock
     * would sit at a different place in each repository, and the bar would shift the moment a
     * panel's detail were set. The tail is empty space in every terminal this fits in.
     */
    const detail = this.detail ? `   ${colors.gray(this.detail)}` : '';
    const lines: string[] = [
      `${header} ${bar} ${colors.bold(`${done}/${total}`)}  ${colors.cyan(`${running} running`)}  ${failedText}  ${colors.yellow(totalElapsed)}${detail}`,
    ];

    const runningList = [...this.items.values()].filter(i => i.status === 'running');
    /**
     * **A package that failed stays on the list, under the ones still working.**
     * It used to vanish the moment it failed, so on a long run the only sign that anything had gone
     * wrong was a count in the header - and whatever it printed was not read until the recap, by
     * which time the run had been going for another half-minute.
     *
     * **Below the running rows, and only with the space they leave.** Work in progress is what the
     * panel is for; a repository that fails early would otherwise fill the block with corpses and
     * push the live rows off the screen. One line each rather than two, so more of them fit - a
     * failed row's value is that it is *named*, and its output is replayed in full at the end.
     */
    const failedList = [...this.items.values()].filter(i => i.status === 'failed');
    /** Leave room for the header, a safety margin, and a possible "N more" line - a block taller
     *  than the terminal breaks cursor-up math (the terminal scrolls instead of the cursor moving,
     *  so redraws land in the wrong place and pile up). */
    const budget = Math.max(0, (process.stdout.rows || 24) - 3);
    const width = process.stdout.columns || 80;
    let used = 0;
    let shownRunning = 0;
    let shownFailed = 0;

    /** The fixed-width half of a row, plus the command truncated into whatever is left. */
    const describe = (item: ProgressItem, elapsed: string) => {
      const step =
        item.stepsTotal && item.stepsTotal > 1 && item.stepIndex != null
          ? `${item.currentStep} (${item.stepIndex + 1}/${item.stepsTotal})`
          : item.currentStep || '';
      /** Measured against the *plain* text: every piece is wrapped in escape sequences, and
       *  `String.length` counts those, so budgeting on the rendered string wraps a row that fits. */
      const fixed = `  ${item.name}  ${step}  ${elapsed} | `.length;
      return { step, command: truncate(item.currentCommand ?? '', width - fixed - 2) };
    };

    for (const item of runningList) {
      const elapsed = item.startedAt ? formatDuration(Date.now() - item.startedAt) : '';
      const { step, command } = describe(item, elapsed);
      /**
       * **The command last, after a `|`, and that is not only layout.** It is the one field with no
       * bound on its length - a `tsc -b` line carries a path, a `run` step carries whatever the
       * author wrote - so between the step and the clock it pushed the elapsed time to a different
       * column on every row, and off the end entirely once a command was long. Everything
       * fixed-width now reads down a straight edge and the variable part runs off to the right,
       * where `truncate` cuts it.
       */
      const group = [
        `${spinner} ${colors.bold(item.name)}  ${colors.gray(step)}  ${colors.yellow(elapsed)}` +
          (command ? `  ${colors.gray('|')} ${colors.cyan(command)}` : ''),
      ];
      if (item.lastLine) group.push(`    ${colors.dim(item.lastLine)}`);
      if (used + group.length > budget) break;
      lines.push(...group);
      used += group.length;
      shownRunning++;
    }

    for (const item of failedList) {
      if (used + 1 > budget) break;
      const elapsed = item.startedAt && item.finishedAt ? formatDuration(item.finishedAt - item.startedAt) : '';
      const { step, command } = describe(item, elapsed);
      lines.push(
        `${colors.red.bold('✖')} ${colors.bold(item.name)}  ${colors.gray(step)}  ${colors.yellow(elapsed)}` +
          (command ? `  ${colors.gray('|')} ${colors.red(command)}` : ''),
      );
      used++;
      shownFailed++;
    }

    /** One line for both, or a run with rows cut from each would need two and the block is already
     *  budgeted to the row. */
    const hidden: string[] = [];
    if (runningList.length > shownRunning) hidden.push(`${runningList.length - shownRunning} more running`);
    if (failedList.length > shownFailed) hidden.push(`${failedList.length - shownFailed} more failed`);
    if (hidden.length) lines.push(colors.gray(`… and ${hidden.join(', ')}`));

    this.live.render(lines);
  }

  /** Stops the redraw loop and erases the panel, leaving the cursor where it started. */
  stop(): void {
    if (this.renderLoop) clearInterval(this.renderLoop);
    this.renderLoop = undefined;
    this.live.clear();
    /** **Handed back, not left suspended.** A command keeps working after its panel comes down -
     *  `ci` prints its summary, `run` its recap - and those writes have to go through a region
     *  again, or they scroll the status line's own block. */
    this.statusRegion?.resume();
    this.statusRegion = undefined;
  }

  /**
   * Prints the final per-item recap (✓/X/○) and the "N succeeded, M failed (Xs)" summary line,
   * and returns the tally. Any item still 'pending' is counted (and printed) as 'skipped'. The
   * per-item recap lines are only printed when the live panel was actually on - with it off, the
   * caller's own plain logging already showed each item's outcome as it happened.
   */
  printSummary(): ProgressSummary {
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    for (const item of this.items.values()) {
      if (item.status === 'pending') item.status = 'skipped';
      const duration =
        item.startedAt && item.finishedAt ? colors.gray(formatDuration(item.finishedAt - item.startedAt)) : '';
      if (item.status === 'success') {
        successCount++;
        if (this.live.enabled) console.log(colors.green('✓'), item.name, duration);
      } else if (item.status === 'failed') {
        failedCount++;
        if (this.live.enabled) {
          console.log(colors.red.bold('X'), item.name, duration);
          /* **The replayed log is printed as it was captured, never painted.** It holds the output
           * of every step this item ran, and only the last one failed - so colouring the block red
           * reports the ones that succeeded as failures. Measured on a real build whose `before`
           * ran `rman check` and then `rman lint`: check passed and printed
           * `✅ no circular dependency was found` and `1 succeeded, 0 failed`, and both came back
           * red under the failing package.
           *
           * It also corrupts what the steps themselves coloured. `colors.red()` wraps the whole
           * string, so a line with its own colour keeps it up to its reset and then falls into red
           * for the remainder: `1 succeeded, 0 failed` rendered with `1 succeeded` still green and
           * the comma after it red.
           *
           * The `X` above already says the item failed, and the step that failed printed its own
           * error. */
          if (item.log.length) console.log(item.log.join('\n'));
        }
      } else {
        skippedCount++;
        if (this.live.enabled) console.log(colors.gray('○'), item.name, colors.gray('skipped'));
      }
    }
    const totalElapsed = formatDuration(Date.now() - this.startedAt);
    const summary = [
      colors.green(`${successCount} succeeded`),
      failedCount > 0 ? colors.red(`${failedCount} failed`) : colors.gray(`${failedCount} failed`),
    ];
    if (skippedCount) summary.push(colors.gray(`${skippedCount} skipped`));
    console.log(summary.join(colors.gray(', ')), colors.gray(`(${totalElapsed})`));

    return { successCount, failedCount, skippedCount };
  }
}

/**
 * `text` cut to `width`, with a `…` in place of what was dropped.
 *
 * **Cut from the end, not the middle.** A command's information is front-loaded - `tsc -b
 * packages/rman/tsconfig.json` says what it is in the first four characters, and a middle-ellipsis
 * spends them on a tail nobody is reading at a glance. The one thing it must never do is wrap: a
 * block taller than the terminal breaks the panel's cursor-up arithmetic, which is the same reason
 * the row budget above exists.
 */
function truncate(text: string, width: number): string {
  if (!text || width <= 1) return '';
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** Classic braille "dots" spinner (cli-spinners' default), one frame per render tick. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** `done` is fractional - see the `filled` accumulator in `render`. Clamped both ends, or a
 *  rounding overshoot asks `repeat` for a negative count and throws inside a redraw. */
function renderProgressBar(done: number, total: number, width = 24): string {
  const cells = total ? Math.round((done / total) * width) : 0;
  const filled = Math.max(0, Math.min(width, cells));
  return colors.green('█'.repeat(filled)) + colors.gray('░'.repeat(width - filled));
}

/**
 * What `addItem` hands back - a `ProgressItem` whose `currentStep` and `currentCommand` clear
 * `lastLine` when they change.
 */
/* **Accessors rather than a line at each call site**, because the call sites are four services and
 * a command and the one that forgets is invisible: stale output under a new command does not look
 * like a bug, it looks like output. Reported from `ci`, where the row read
 * `install (2/2) | npm install` over `removed node_modules, package-lock.json` - the wipe's line,
 * sitting under the install's command as though it belonged to it.
 *
 * **Cleared where it changes, not at render time.** The panel redraws every 100ms, so comparing
 * there would race a line that arrived between the change and the next frame and throw away real
 * output. This is synchronous with the assignment.
 */
class PanelItem implements ProgressItem {
  status: ProgressStatus = 'pending';
  stepIndex?: number;
  stepsTotal?: number;
  lastLine?: string;
  startedAt?: number;
  finishedAt?: number;
  readonly log: string[] = [];
  private _currentStep?: string;
  private _currentCommand?: string;

  constructor(
    readonly name: string,
    stepsTotal?: number,
  ) {
    this.stepsTotal = stepsTotal;
  }

  get currentStep(): string | undefined {
    return this._currentStep;
  }

  set currentStep(value: string | undefined) {
    if (value === this._currentStep) return;
    this._currentStep = value;
    this.lastLine = undefined;
  }

  get currentCommand(): string | undefined {
    return this._currentCommand;
  }

  set currentCommand(value: string | undefined) {
    if (value === this._currentCommand) return;
    this._currentCommand = value;
    this.lastLine = undefined;
  }
}
