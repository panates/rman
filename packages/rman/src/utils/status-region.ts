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
export class StatusRegion {
  private readonly region: LiveRegion;
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private frame = 0;

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

  /** Writes `text` without corrupting the block: erase, write, redraw underneath. */
  passThrough(text: string): void {
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
