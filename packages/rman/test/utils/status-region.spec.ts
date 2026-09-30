import { expect } from 'expect';
import { formatElapsed, StatusRegion } from '../../src/utils/status-region.js';

/**
 * Captures what the region writes. **`process.stderr.write`, not `console.error`** - the region
 * writes escape sequences and partial lines, so it goes to the stream directly and a console stub
 * would never see it.
 */
function capture(fn: (write: () => string) => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = '';
  (process.stderr as NodeJS.WriteStream).write = ((chunk: any) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn(() => out);
  } finally {
    (process.stderr as NodeJS.WriteStream).write = original;
  }
  return out;
}

/** Everything but the visible text - the region is mostly cursor movement, and an assertion about
 *  what a reader *sees* has to strip it or it is asserting about the redraw. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const visible = (s: string) => s.replace(ANSI, '');

describe('utils/StatusRegion', () => {
  /**
   * **Built with `enabled` forced on**, because under a test runner stderr is a pipe and the region
   * is a deliberate no-op there. Every case below is about the live behaviour, which is the half
   * `cli.spec.ts` structurally cannot reach.
   */
  it('draws a spinner, the label and a clock, and redraws in place rather than scrolling', () => {
    const out = capture(() => {
      const region = new StatusRegion('lint', 'my-repo', true);
      region.start();
      region.stop('ok');
    });

    expect(visible(out)).toContain('lint');
    expect(visible(out)).toContain('my-repo');
    /** A spinner frame, and the braille set rather than an emoji: one cell wide in every font that
     *  has it, where a two-cell emoji makes the line jitter as it spins. */
    expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    /** Redrawn in place: the block is erased with a cursor-up before the result line. */
    expect(out).toContain('\x1b[2K');
  });

  /** The result line is the half that survives into a CI log, so it says how it went and how long
   *  it took - not just that it stopped. */
  it('ends with a mark and an elapsed time', () => {
    const ok = capture(() => new StatusRegion('lint', '', true).stop('ok'));
    const bad = capture(() => new StatusRegion('lint', '', true).stop('fail'));

    expect(visible(ok)).toContain('✔');
    expect(visible(bad)).toContain('✖');
    expect(visible(ok)).toMatch(/\d+(\.\d+)?(ms|s)/);
  });

  /**
   * **A write that bypasses the region corrupts it**, which is the whole reason `runBin` pipes a
   * child while one is live: the region redraws by moving the cursor up N rows, so text printed
   * underneath it puts those rows somewhere else and the next redraw erases the wrong ones.
   * `passThrough` is the safe route - erase, write, redraw below.
   */
  it('passes text through without losing it, erasing and redrawing around it', () => {
    const out = capture(() => {
      const region = new StatusRegion('lint', '', true);
      region.start();
      region.passThrough('a real line of output\n');
      region.stop('ok');
    });

    expect(visible(out)).toContain('a real line of output');
    /** The text is still followed by the block being drawn again - it did not simply end the
     *  region. Two erases at least: one before the write, one for the final clear. */
    // eslint-disable-next-line no-control-regex
    expect(out.match(/\x1b\[2K/g)?.length).toBeGreaterThan(1);
  });

  /**
   * **Not a TTY: nothing is drawn, but the result still is.** CI is the case - escape codes mean
   * nothing there and would just be noise in the log, while "it took 3.6s and passed" is exactly
   * what a log is for.
   */
  it('draws nothing when disabled, and still reports the result', () => {
    const out = capture(() => {
      const region = new StatusRegion('lint', 'my-repo', false);
      region.start();
      region.passThrough('output\n');
      region.stop('ok');
    });

    expect(out).toContain('output');
    expect(visible(out)).toContain('lint');
    /** No cursor movement at all - the two things a non-TTY must never receive. */
    expect(out).not.toContain('\x1b[2K');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[\d+A/);
  });

  /** One formatter for the ticking clock and the result line both: a duration that changes shape as
   *  it counts reads as a glitch. */
  it('formats a duration by magnitude', () => {
    expect(formatElapsed(0)).toBe('0ms');
    expect(formatElapsed(950)).toBe('950ms');
    expect(formatElapsed(4123)).toBe('4.1s');
    expect(formatElapsed(123_000)).toBe('2m 03s');
  });
});
