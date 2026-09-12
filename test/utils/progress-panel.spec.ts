import expect from 'expect';
import { ProgressPanel } from '../../src/utils/progress-panel.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Captures process.stdout.write() calls instead of letting them hit the real terminal, and
 *  lets a test stub `columns`/`rows` for the duration of `fn`. Same pattern as live-region.spec.ts,
 *  since ProgressPanel's redraw ultimately goes through the same LiveRegion. */
async function withCapturedStdout<T>(
  fn: (writes: string[]) => Promise<T> | T,
  size?: { columns?: number; rows?: number },
): Promise<T> {
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
    return await fn(writes);
  } finally {
    process.stdout.write = originalWrite;
    if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
    if (originalRows) Object.defineProperty(process.stdout, 'rows', originalRows);
  }
}

/** Runs `fn` with console.log captured (plain, ANSI-stripped) instead of printed. */
function captureLogs(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('utils/ProgressPanel', () => {
  it('enabled reflects the constructor argument, mirroring the underlying LiveRegion', () => {
    expect(new ProgressPanel('X', true).enabled).toBe(true);
    expect(new ProgressPanel('X', false).enabled).toBe(false);
  });

  it('addItem() registers and returns a pending item with an empty log', () => {
    const panel = new ProgressPanel('X', false);
    const item = panel.addItem('pkg-a', 3);
    expect(item.name).toBe('pkg-a');
    expect(item.status).toBe('pending');
    expect(item.stepsTotal).toBe(3);
    expect(item.log).toEqual([]);
  });

  it('when disabled, start()/stop() never write to stdout', async () => {
    await withCapturedStdout(async writes => {
      const panel = new ProgressPanel('X', false);
      panel.addItem('pkg-a');
      panel.start();
      await wait(150);
      panel.stop();
      expect(writes).toEqual([]);
    });
  });

  it('when enabled, the redraw shows the title, a progress bar, and the running item', async () => {
    await withCapturedStdout(
      async writes => {
        const panel = new ProgressPanel('CI', true);
        const item = panel.addItem('pkg-a');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'wipe';
        panel.start();
        await wait(150);
        panel.stop();
        expect(writes.length).toBeGreaterThan(0);
        const plain = stripAnsi(writes.join(''));
        expect(plain).toContain('CI');
        expect(plain).toContain('pkg-a');
        expect(plain).toContain('wipe');
      },
      { columns: 80, rows: 24 },
    );
  });

  describe('printSummary()', () => {
    it('tallies success/failed/pending-as-skipped, and prints the total line regardless of enabled', () => {
      const panel = new ProgressPanel('X', false);
      const a = panel.addItem('a');
      a.status = 'success';
      const b = panel.addItem('b');
      b.status = 'failed';
      panel.addItem('c'); // stays 'pending' -> counted and reported as 'skipped'
      panel.start();
      panel.stop();

      let summary: ReturnType<ProgressPanel['printSummary']> | undefined;
      const lines = captureLogs(() => {
        summary = panel.printSummary();
      });

      expect(summary).toEqual({ successCount: 1, failedCount: 1, skippedCount: 1 });
      expect(lines.some(l => l.includes('1 succeeded') && l.includes('1 failed') && l.includes('1 skipped'))).toBe(
        true,
      );
    });

    it('suppresses the per-item ✓/X/○ recap lines when the panel is disabled', () => {
      const panel = new ProgressPanel('X', false);
      const a = panel.addItem('a');
      a.status = 'success';
      panel.start();
      panel.stop();

      const lines = captureLogs(() => panel.printSummary());
      expect(lines.some(l => l.includes('✓'))).toBe(false);
    });

    it('prints a ✓ recap line per successful item when the panel is enabled', () => {
      const panel = new ProgressPanel('X', true);
      const a = panel.addItem('a');
      a.status = 'success';
      panel.start();
      panel.stop();

      const lines = captureLogs(() => panel.printSummary());
      expect(lines.some(l => l.includes('✓') && l.includes('a'))).toBe(true);
    });

    it("prints a failed item's captured log alongside its X recap line when the panel is enabled", () => {
      const panel = new ProgressPanel('X', true);
      const a = panel.addItem('a');
      a.status = 'failed';
      a.log.push('boom');
      panel.start();
      panel.stop();

      const lines = captureLogs(() => panel.printSummary());
      expect(lines.some(l => l.includes('X') && l.includes('a'))).toBe(true);
      expect(lines.some(l => l.includes('boom'))).toBe(true);
    });
  });
});
