import colors from 'ansi-colors';
import { LiveRegion } from './live-region.js';

/**
 * One line at the bottom of the terminal while a command runs - a spinner, the command's name, the
 * repository, and the elapsed time counting up - replaced by a result line when it ends.
 *
 * ```
 * ⠹ lint  postgrejs  2.4s      <- while running, redrawn in place
 * ✔ lint  3.6s                 <- once it ends
 * ```
 */
/* **Why a live line rather than one printed at the start**: a command that prints nothing is
 * indistinguishable from one that never ran, and a static start line answers "did it start" without
 * answering "is it still going". `rman lint` on a clean repository is silent for several seconds
 * because eslint says nothing when it has nothing to say.
 *
 * **On stderr, unlike `ProgressPanel`'s region.** A command's *answer* goes to stdout, and
 * `rman changelog > NOTES.md` has to leave the notes alone in the file - cursor-movement codes in
 * there would be worse than noise. The two streams share a terminal, so only one region is ever
 * live.
 *
 * **Anything printed while it is live has to go through `passThrough`**, which erases the block,
 * writes, and redraws below. A write that bypasses it scrolls the screen, and the next redraw's
 * "move up N rows" then lands on the wrong rows and erases what was just printed - the same cursor
 * arithmetic `LiveRegion` documents as its own hard edge. That is why `runBin` pipes a child while
 * a region is live instead of letting it inherit the terminal.
 *
 * **No-op when stderr is not a TTY** (CI, a pipe), where the escape codes mean nothing. There the
 * caller still gets the result line, which is the part that carries information. */
/**
 * What a region has to offer to take the terminal over from `StatusRegion` - and `passThrough` is
 * the whole of it.
 *
 * **Deliberately not `live`.** `StatusRegion.live` answers "does something own this terminal", which
 * is what `runBin` reads and which stays true across a takeover; `ProgressPanel` spells the same
 * question `enabled` and uses `live` for the `LiveRegion` itself. Putting it in the contract would
 * force one of the two to be renamed for no gain - the handover needs somewhere to write, nothing
 * more.
 */
export interface TerminalRegion {
  /** Write `text` without corrupting the block: erase, write, redraw underneath. */
  passThrough(text: string): void;
}

export class StatusRegion implements TerminalRegion {
  private readonly region: LiveRegion;
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private frame = 0;
  /**
   * Who owns the terminal while this region is suspended - see `suspend`. Pass-through is forwarded
   * there, so `runBin` keeps asking one object (`app.statusRegion`) whatever is actually drawing.
   */
  private takeover?: TerminalRegion;

  constructor(
    private readonly label: string,
    private readonly detail: string = '',
    enabled?: boolean,
  ) {
    this.region = new LiveRegion(enabled, process.stderr);
  }

  /** Whether the spinner is actually drawn. `false` leaves `passThrough` a plain write and `stop`
   *  its single line, which is what a non-TTY wants. */
  get live(): boolean {
    return this.region.enabled;
  }

  /** Starts the spinner. Safe to call when not live - it does nothing. */
  start(): void {
    if (!this.region.enabled) return;
    this.draw();
    /** **`unref`, so a spinner never holds the process open.** A command that finishes its work and
     *  leaves nothing else pending would otherwise wait out the interval before exiting. */
    this.timer = setInterval(() => {
      this.frame++;
      this.draw();
    }, FRAME_MS);
    this.timer.unref();
  }

  /**
   * **Hands the terminal to another region**, usually a `ProgressPanel` - the spinner stops, its
   * line is erased, and pass-through is forwarded to `takeover` until `resume`.
   *
   * **Two live regions on one terminal cannot both work, and this is what enforces that.** Each
   * redraws by moving the cursor up by *its own* line count; interleaved, every redraw lands on the
   * other's rows. On screen that reads as the last line and the status line swapping places several
   * times a second - reported on `rman ci`, and `rman build` has it too through `runBin`, whose
   * pass-through went to this region while the panel was drawing. `LiveRegion`'s own doc has said
   * "only one region is ever live" since it grew a `stream` parameter; nothing enforced it.
   *
   * `live` deliberately stays `true` while suspended: it answers "does something own this
   * terminal", which is what `runBin` needs to decide to pipe rather than let a child scroll the
   * screen. The answer to *which* region is the forwarding above.
   */
  suspend(takeover?: TerminalRegion): void {
    this.takeover = takeover;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.region.clear();
  }

  /**
   * Takes the terminal back - a no-op when it was never suspended.
   *
   * **The first frame waits for the timer rather than being drawn now**, which `start` does. A
   * command is usually seconds from finishing when its panel comes down, and drawing immediately
   * put one spinner frame on screen between the panel's recap and the result line that replaces it
   * - a single flash, which is the thing this whole mechanism exists to remove. Anything still
   * working is drawn 80ms later and nobody waits for it.
   */
  resume(): void {
    if (!this.takeover && this.timer) return;
    this.takeover = undefined;
    if (!this.region.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.draw();
    }, FRAME_MS);
    this.timer.unref();
  }

  /** Writes `text` without corrupting the block: erase, write, redraw underneath. */
  passThrough(text: string): void {
    if (this.takeover) {
      this.takeover.passThrough(text);
      return;
    }
    if (!this.region.enabled) {
      process.stderr.write(text);
      return;
    }
    this.region.clear();
    process.stderr.write(text);
    this.draw();
  }

  /** Erases the spinner and leaves one line saying how it went. */
  stop(outcome: 'ok' | 'fail'): void {
    this.takeover = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.region.clear();
    const mark = outcome === 'ok' ? colors.green('✔') : colors.red('✖');
    process.stderr.write(`${mark} ${colors.bold(this.label)} ${colors.gray(this.elapsed())}\n`);
  }

  private draw(): void {
    const spinner = colors.cyan(FRAMES[this.frame % FRAMES.length]!);
    const parts = [
      spinner,
      colors.bold(this.label),
      this.detail && colors.gray(this.detail),
      colors.gray(this.elapsed()),
    ];
    this.region.render([parts.filter(Boolean).join(' ')]);
  }

  /** `0.4s` while running and `950ms` / `4.1s` / `2m 03s` at the end - one formatter, because a
   *  duration that changes shape as it ticks reads as a glitch. */
  private elapsed(): string {
    return formatElapsed(Date.now() - this.startedAt);
  }
}

/** `950ms`, `4.1s`, `2m 03s` - the three magnitudes a command run lands in. Seconds to one decimal
 *  because the difference between 4.1s and 4.9s is worth seeing and 4.13s is not. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Braille dots - one cell wide in every terminal font that has them, where an emoji spinner is two
 *  cells in some and one in others and makes the line jitter. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Fast enough to read as motion, slow enough that a redraw is not most of what the process does. */
const FRAME_MS = 80;
