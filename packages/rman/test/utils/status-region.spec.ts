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

  /**
   * **Two live regions on one terminal cannot both work**, and `suspend`/`resume` is what enforces
   * the one-owner rule `LiveRegion`'s own doc has always claimed. Reported on `rman ci`: the panel
   * and this line each redraw by moving the cursor up by *their own* line count, so interleaved
   * they land on each other's rows and the bottom lines visibly swap places.
   */
  /**
   * **A command's own output survives the spinner.** Measured with a pseudo-terminal: `rman deps`
   * printed its plan with `console.log`, the region's final erase moved up one row from below the
   * plan, and the plan's last line was gone - a "not updated" heading with nothing under it.
   * `version --show` lost "Nothing to version." the same way. Asserted on what a terminal would
   * show, since every byte is still in the stream either way.
   */
  describe('output written while it is live', () => {
    it('keeps every line a command prints itself, the last one included', () => {
      const shown = screen(() => {
        const region = new StatusRegion('deps', '', true);
        region.start();
        process.stdout.write('@panates/reportj\n');
        console.log('  not updated');
        process.stdout.write('    typescript  ^6.0.3  7.0.2\n');
        region.stop('ok');
      });

      expect(shown.slice(0, 3)).toEqual(['@panates/reportj', '  not updated', '    typescript  ^6.0.3  7.0.2']);
      expect(shown[3]).toMatch(/^✔ deps /);
      expect(shown).toHaveLength(4);
    });

    it('does not draw over a line written in pieces', () => {
      const shown = screen(() => {
        const region = new StatusRegion('deps', '', true);
        region.start();
        process.stderr.write('half ');
        process.stderr.write('and the rest\n');
        region.stop('ok');
      });

      expect(shown[0]).toBe('half and the rest');
      expect(shown[1]).toMatch(/^✔ deps /);
    });

    it('hands the streams back when it stops', () => {
      const before = { out: process.stdout.write, err: process.stderr.write };
      const region = new StatusRegion('deps', '', true);
      screen(() => {
        region.start();
        region.stop('ok');
      });
      expect(process.stdout.write).toBe(before.out);
      expect(process.stderr.write).toBe(before.err);
    });
  });

  describe('handing the terminal over (suspend/resume)', () => {
    it('stops drawing its own line while suspended', () => {
      const out = capture(written => {
        const region = new StatusRegion('ci', 'my-repo', true);
        region.start();
        region.suspend();
        const before = written().length;
        /** Longer than one frame (80ms), so a surviving timer would have drawn at least once.
         *  Busy, because `capture` restores the stream synchronously and an awaited gap would
         *  put the assertion outside it. */
        const until = Date.now() + 200;
        while (Date.now() < until) {
          /* spin */
        }
        expect(written().length).toBe(before);
        region.stop('ok');
      });
      /** The result line still prints - suspension is about the spinner, not about the outcome. */
      expect(visible(out)).toContain('ci');
    });

    it('forwards passThrough to whoever took over', () => {
      const taken: string[] = [];
      const out = capture(() => {
        const region = new StatusRegion('ci', 'my-repo', true);
        region.start();
        region.suspend({ passThrough: text => taken.push(text) });
        region.passThrough('a child line\n');
        region.stop('ok');
      });

      expect(taken).toEqual(['a child line\n']);
      /** And not written here as well - one copy, in the region that owns the terminal. */
      expect(visible(out)).not.toContain('a child line');
    });

    /** `runBin` reads this to decide whether to pipe a child rather than let it scroll the screen,
     *  and a panel owning the terminal needs that just as much as this line does. */
    it('still reports live while suspended', () => {
      capture(() => {
        const region = new StatusRegion('ci', 'my-repo', true);
        region.start();
        region.suspend();
        expect(region.live).toBe(true);
        region.stop('ok');
      });
    });

    it('draws again once resumed, and takes passThrough back', () => {
      const taken: string[] = [];
      const out = capture(() => {
        const region = new StatusRegion('ci', 'my-repo', true);
        region.start();
        region.suspend({ passThrough: text => taken.push(text) });
        region.resume();
        region.passThrough('back here\n');
        region.stop('ok');
      });

      expect(taken).toEqual([]);
      expect(visible(out)).toContain('back here');
    });
  });
});

/**
 * What a terminal would show for everything written to stdout and stderr during `fn` - one entry per
 * row, colours dropped. Just enough of a VT100 for this region: `\r`, `\n`, cursor up (`ESC[nA`)
 * and erase line (`ESC[2K`).
 */
function screen(fn: () => void): string[] {
  let out = '';
  const streams = [process.stdout, process.stderr] as NodeJS.WriteStream[];
  const originals = streams.map(stream => stream.write);
  for (const stream of streams) {
    stream.write = ((chunk: any) => {
      out += String(chunk);
      return true;
    }) as typeof stream.write;
  }
  try {
    fn();
  } finally {
    streams.forEach((stream, i) => (stream.write = originals[i]!));
  }

  const rows: string[] = [''];
  let row = 0;
  let col = 0;
  // eslint-disable-next-line no-control-regex
  for (const match of out.matchAll(/\x1b\[(\d*)([A-Za-z])|\r|\n|[^\x1b\r\n]+/g)) {
    const [token, count, command] = match;
    if (token === '\r') col = 0;
    else if (token === '\n') {
      row++;
      col = 0;
      rows[row] ??= '';
    } else if (command === 'A') row = Math.max(0, row - Number(count || 1));
    else if (command === 'K') rows[row] = '';
    else if (!command) {
      const line = rows[row] ?? '';
      rows[row] = line.slice(0, col).padEnd(col) + token + line.slice(col + token.length);
      col += token.length;
    }
  }
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows;
}
