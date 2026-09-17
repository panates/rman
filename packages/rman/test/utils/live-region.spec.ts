import { expect } from 'expect';
import { LiveRegion } from '../../src/utils/live-region.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Captures process.stdout.write() calls instead of letting them hit the real terminal,
 *  and lets a test stub `columns`/`rows` for the duration of `fn`. */
function withCapturedStdout<T>(fn: (writes: string[]) => T, size?: { columns?: number; rows?: number }): T {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  process.stdout.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  if (size?.columns !== undefined)
    Object.defineProperty(process.stdout, 'columns', { value: size.columns, configurable: true });
  if (size?.rows !== undefined) Object.defineProperty(process.stdout, 'rows', { value: size.rows, configurable: true });
  try {
    return fn(writes);
  } finally {
    process.stdout.write = originalWrite;
    if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
    if (originalRows) Object.defineProperty(process.stdout, 'rows', originalRows);
  }
}

describe('utils/LiveRegion', () => {
  it('enabled reflects the constructor argument', () => {
    expect(new LiveRegion(true).enabled).toBe(true);
    expect(new LiveRegion(false).enabled).toBe(false);
  });

  it('when disabled, render() and clear() never write to stdout', () => {
    withCapturedStdout(writes => {
      const lr = new LiveRegion(false);
      lr.render(['a', 'b']);
      lr.clear();
      expect(writes).toEqual([]);
    });
  });

  it('the first render writes lines without a leading cursor-up (nothing to erase yet)', () => {
    withCapturedStdout(
      writes => {
        new LiveRegion(true).render(['line A', 'line B']);
        expect(writes.length).toBe(1);
        // eslint-disable-next-line no-control-regex
        expect(/^\x1b\[\d+A/.test(writes[0])).toBe(false); // no cursor-up - there's no prior frame to erase
        expect(writes[0].endsWith('\n')).toBe(true);
        const plain = stripAnsi(writes[0]);
        expect(plain).toContain('line A');
        expect(plain).toContain('line B');
      },
      { columns: 80, rows: 24 },
    );
  });

  it("a later render moves the cursor up by exactly the previous frame's line count", () => {
    withCapturedStdout(
      writes => {
        const lr = new LiveRegion(true);
        lr.render(['a', 'b']); // 2 lines
        lr.render(['c', 'd', 'e']); // 3 lines
        expect(writes[1].startsWith('\x1b[2A')).toBe(true);
      },
      { columns: 80, rows: 24 },
    );
  });

  it('a shrinking frame clears the leftover lines from the previous, larger frame', () => {
    withCapturedStdout(
      writes => {
        const lr = new LiveRegion(true);
        lr.render(['a', 'b', 'c']); // 3 lines
        lr.render(['x']); // 1 line
        const second = writes[1];
        // clears (up to) 3 lines, ends by moving back up 2 so the next render's math stays correct.
        expect(second.startsWith('\x1b[3A')).toBe(true);
        expect(second).toContain('\x1b[2A');
      },
      { columns: 80, rows: 24 },
    );
  });

  it('clear() erases the block and resets so the next render needs no leading cursor-up', () => {
    withCapturedStdout(
      writes => {
        const lr = new LiveRegion(true);
        lr.render(['a', 'b']);
        lr.clear();
        lr.render(['fresh']);
        expect(writes.length).toBe(3);
        expect(writes[1].startsWith('\x1b[2A')).toBe(true); // clear() moves up over the 2 lines
        expect(writes[2]).not.toContain('\x1b['.repeat(0) + '\x1b[2A'); // no leftover cursor-up baggage
        expect(writes[2].startsWith('\x1b[')).toBe(false); // fresh render again has nothing to erase
      },
      { columns: 80, rows: 24 },
    );
  });

  it('truncates by *visible* width, not raw byte length - a heavily-colored line is not cut mid-escape-code', () => {
    // Regression test: truncating on raw string length (ANSI codes included) could slice a line
    // in the middle of an escape sequence once enough color codes accumulated, corrupting it -
    // even though the *visible* text was well within the terminal width.
    withCapturedStdout(
      writes => {
        const colored = '\x1b[46m\x1b[30m\x1b[1m short \x1b[22m\x1b[39m\x1b[49m text here';
        expect(stripAnsi(colored).length).toBeLessThanOrEqual(30);
        new LiveRegion(true).render([colored]);
        const plain = stripAnsi(writes[0]);
        expect(plain).toContain('text here');
      },
      { columns: 30, rows: 24 },
    );
  });

  it('a line that is genuinely too wide falls back to a plain-text truncation', () => {
    withCapturedStdout(
      writes => {
        new LiveRegion(true).render(['a'.repeat(50)]);
        const plain = stripAnsi(writes[0]);
        expect(plain).toContain('a'.repeat(9)); // truncated to width-1, but at least starts correctly
        expect(plain.includes('a'.repeat(50))).toBe(false);
      },
      { columns: 10, rows: 24 },
    );
  });

  it('caps the number of lines to the terminal height, so a tall block cannot break the redraw math', () => {
    // Regression test: printing more lines than the terminal has rows makes it scroll, so
    // "move cursor up N" can no longer get back N rows - every redraw then lands lower than the
    // last, leaving a trail of stale frames instead of one block updating in place.
    withCapturedStdout(
      writes => {
        const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);
        new LiveRegion(true).render(many);
        const printedLines = writes[0].split('\n').filter(Boolean);
        expect(printedLines.length).toBeLessThanOrEqual(5); // rows:6 => at most rows-1 lines
      },
      { columns: 80, rows: 6 },
    );
  });
});
