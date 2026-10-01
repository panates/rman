import colors from 'ansi-colors';
import { expect } from 'expect';
import { ProgressPanel } from '../../src/utils/progress-panel.js';

/**
 * **Every CSI sequence, not just the colours.** A redraw also writes cursor moves and erases
 * (`\x1b[2K`, `\x1b[1A`), and those survive a colour-only pattern - which is invisible to a
 * `toContain` assertion and wrong by exactly their length to anything *measuring* the row. Measured:
 * an 80-column row came back as 84 characters.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
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

/** `captureLogs` strips ANSI, which is right for every case asserting on text and useless for one
 *  asserting on colour. This is the same capture with the escape sequences left in. */
function captureRawLogs(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
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

  /**
   * **The bar is filled from step progress, not from finished items.** With one item it otherwise
   * never moves at all - which is `rman changelog` under `changelog.groupBy: 'group'`, where the
   * row beside the bar counts to 1825 while the bar sits empty.
   */
  describe("the bar fills from a running item's own steps", () => {
    /** How many cells of the 24-wide bar are filled, read back off a redraw. */
    async function filledCells(prepare: (panel: ProgressPanel) => void): Promise<number> {
      let cells = -1;
      await withCapturedStdout(
        async writes => {
          const panel = new ProgressPanel('X', true);
          prepare(panel);
          panel.start();
          await wait(150);
          panel.stop();
          const plain = stripAnsi(writes.join(''));
          /** The whole bar, filled and empty cells together - matching only up to the first
           *  empty cell reads a *full* bar as no bar at all, which is the case this exists for. */
          const bar = /[█░]{24}/.exec(plain);
          cells = bar ? [...bar[0]].filter(c => c === '█').length : -1;
        },
        { columns: 200, rows: 24 },
      );
      return cells;
    }

    it('a single item half way through its steps fills about half the bar', async () => {
      const cells = await filledCells(panel => {
        const item = panel.addItem('only');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'reading commits';
        item.stepsTotal = 1000;
        item.stepIndex = 499;
      });
      expect(cells).toBe(12);
    });

    it('stays empty for that same item before it reports a step - nothing has happened yet', async () => {
      const cells = await filledCells(panel => {
        const item = panel.addItem('only');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'detecting';
      });
      expect(cells).toBe(0);
    });

    it('a finished item still counts as a whole one', async () => {
      const cells = await filledCells(panel => {
        panel.addItem('a').status = 'success';
        const b = panel.addItem('b');
        b.status = 'running';
        b.startedAt = Date.now();
        b.currentStep = 'x';
        b.stepsTotal = 2;
        b.stepIndex = 0;
      });
      /** One of two done plus half of the other: three quarters of 24. */
      expect(cells).toBe(18);
    });

    it('clamps a caller that reports more steps than it declared', async () => {
      const cells = await filledCells(panel => {
        const item = panel.addItem('only');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'x';
        item.stepsTotal = 10;
        item.stepIndex = 99;
      });
      expect(cells).toBe(24);
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

  /**
   * **A silent step has to say what it is.** The slot label answers "which slot", which the reader
   * already knows; a row sitting at `before (2/9)` for ten seconds with nothing on stdout is the
   * case this exists for, and for a build it is the common one.
   */
  it('shows the command the running step is executing, beside its label', async () => {
    await withCapturedStdout(
      async writes => {
        const panel = new ProgressPanel('RUN build', true);
        const item = panel.addItem('pkg-a');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'before';
        item.stepIndex = 1;
        item.stepsTotal = 9;
        item.currentCommand = 'tsc -b';
        panel.start();
        await wait(150);
        panel.stop();
        const plain = stripAnsi(writes.join(''));
        expect(plain).toContain('before (2/9)');
        expect(plain).toContain('tsc -b');
      },
      { columns: 80, rows: 24 },
    );
  });

  /**
   * **It must never wrap.** A block taller than the terminal breaks the panel's cursor-up
   * arithmetic - the terminal scrolls instead of the cursor moving, so redraws land in the wrong
   * place and pile up. That is the same reason the row budget exists, and it is why the command is
   * cut rather than left to the terminal.
   *
   * **Measured on the plain text, not the rendered string.** Every piece of the row is wrapped in
   * escape sequences and `String.length` counts those, so a budget computed on what is written
   * would leave the row far shorter than the width and still be wrong in the other direction once
   * the colours changed.
   */
  it('cuts a command that would not fit, and leaves the row inside the terminal width', async () => {
    await withCapturedStdout(
      async writes => {
        const panel = new ProgressPanel('RUN build', true);
        const item = panel.addItem('pkg-a');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'exec';
        item.currentCommand = `node ${'x'.repeat(200)}.cjs`;
        panel.start();
        await wait(150);
        panel.stop();
        const plain = stripAnsi(writes.join(''));
        const row = plain.split(/[\r\n]/).find(l => l.includes('pkg-a'));
        expect(row).toBeDefined();
        expect(row!.length).toBeLessThanOrEqual(80);
        /** Cut from the end: a command's information is front-loaded, so the first characters are
         *  the ones worth keeping. */
        expect(row).toContain('node xxx');
        expect(row).toContain('…');
      },
      { columns: 80, rows: 24 },
    );
  });

  /** Nothing extra for a driver that sets no command - `ci` and `clean` name their own steps
   *  (`wipe`, `install`, `ts`), which are already self-describing. */
  it('leaves the row as it was when the step has no command to name', async () => {
    await withCapturedStdout(
      async writes => {
        const panel = new ProgressPanel('CI', true);
        const item = panel.addItem('pkg-a');
        item.status = 'running';
        item.startedAt = Date.now();
        item.currentStep = 'install';
        panel.start();
        await wait(150);
        panel.stop();
        const plain = stripAnsi(writes.join(''));
        const row = plain.split(/[\r\n]/).find(l => l.includes('pkg-a'))!;
        expect(row).toContain('install');
        /** Two spaces between each field, and no third gap where a command would have gone. */
        expect(row.replace(/\s+$/, '')).toMatch(/pkg-a {2}install {2}[0-9.]+s$/);
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

    /**
     * **The log is a replay, so it is printed exactly as captured.** It holds every step the item
     * ran and only the last one failed - painting the block red reports the ones that succeeded as
     * failures. Measured on a real build whose `before` ran `rman check` then `rman lint`: check
     * passed, printed `no circular dependency was found` and `1 succeeded, 0 failed`, and both came
     * back red under the failing package.
     *
     * Asserted on the raw text rather than through `stripAnsi`, because the defect *is* an escape
     * sequence: `colors.red()` wrapped the join, so an uncoloured line gained a red opener and a
     * line carrying its own colour fell into red after its reset.
     */
    it("leaves a failed item's captured log uncoloured - the steps that succeeded are in it too", () => {
      /* **`colors.enabled` has to be forced on, or this case proves nothing.** ansi-colors
       * disables itself when stdout is not a TTY, which it is not under mocha - so `colors.red(x)`
       * returns `x` and the assertion passes with the defect reinstated. Caught by running the
       * negative control: reverting the fix left this green. It also reads through
       * `captureRawLogs` rather than `captureLogs`, which strips ANSI - either alone is enough
       * to make the case vacuous. Restored in `finally`, since
       * `enabled` is module-global and a leaked `true` would colour every later spec's output. */
      const wasEnabled = colors.enabled;
      colors.enabled = true;
      try {
        const panel = new ProgressPanel('X', true);
        const a = panel.addItem('a');
        a.status = 'failed';
        a.log.push('check passed', '1 succeeded, 0 failed', 'boom');
        panel.start();
        panel.stop();

        const lines = captureRawLogs(() => panel.printSummary());
        const replay = lines.find(l => l.includes('1 succeeded, 0 failed'));
        expect(replay).toBeDefined();
        expect(replay).toBe('check passed\n1 succeeded, 0 failed\nboom');

        /** The X line itself still marks the failure - that is what the colour is for. */
        const header = lines.find(l => stripAnsi(l).startsWith('X '));
        expect(header).toContain('\x1b[31m');
      } finally {
        colors.enabled = wasEnabled;
      }
    });
  });

  /**
   * **The panel takes the terminal from the status region and hands it back.** Two live regions
   * each redraw by moving the cursor up by their own line count, so interleaved they land on each
   * other's rows - on screen, the bottom lines swap places several times a second. Reported on
   * `rman ci`; `rman build` had it too, through `runBin`'s pass-through.
   */
  describe('takeover of the status region', () => {
    it('suspends it on start and resumes it on stop', async () => {
      const calls: string[] = [];
      const region = {
        suspend: (t?: unknown) => calls.push(t ? 'suspend(panel)' : 'suspend()'),
        resume: () => calls.push('resume'),
      };
      await withCapturedStdout(
        async () => {
          const panel = new ProgressPanel('X', true);
          panel.start(region as never);
          await wait(120);
          panel.stop();
        },
        { columns: 80, rows: 24 },
      );
      expect(calls).toEqual(['suspend(panel)', 'resume']);
    });

    /** A disabled panel draws nothing, so taking the terminal from the status line would remove the
     *  one thing a non-TTY run still shows. */
    it('leaves it alone when the panel is not drawing', async () => {
      const calls: string[] = [];
      const region = { suspend: () => calls.push('suspend'), resume: () => calls.push('resume') };
      const panel = new ProgressPanel('X', false);
      panel.start(region as never);
      panel.stop();
      expect(calls).toEqual([]);
    });
  });
});
