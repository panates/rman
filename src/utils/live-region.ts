/**
 * Renders a fixed block of lines at the bottom of the terminal that gets
 * redrawn in place (cursor-up + clear-line) instead of scrolling, the way
 * Turborepo/pnpm show "currently running" status without flooding the log.
 *
 * No-op when stdout isn't a TTY (CI, piped output) - cursor-movement escape
 * codes are meaningless there and would just corrupt the log.
 */
export class LiveRegion {
  private lineCount = 0;
  readonly enabled: boolean;

  constructor(enabled: boolean = !!process.stdout.isTTY) {
    this.enabled = enabled;
  }

  render(lines: string[]): void {
    if (!this.enabled) return;
    const width = process.stdout.columns || 80;
    /** Measure by visible length, not raw length - a heavily-colored line has far more
     *  bytes than visible characters, and slicing the raw string would cut mid-escape-code. */
    let clipped = lines.map(l => {
      if (visibleLength(l) <= width) return l;
      return l.replace(ANSI_PATTERN, '').slice(0, Math.max(0, width - 1));
    });

    /** A block taller than the terminal breaks the cursor-up math below: once printing it
     *  scrolls the screen, "move up N rows" can't actually get back N rows, and every
     *  redraw lands lower than the last, leaving a trail instead of a single updating block.
     *  Callers should size their own content to fit, but this is a hard backstop. */
    const maxRows = Math.max(1, (process.stdout.rows || 24) - 1);
    if (clipped.length > maxRows) clipped = clipped.slice(0, maxRows);

    let out = this.lineCount ? `\x1b[${this.lineCount}A` : '';
    for (const line of clipped) out += `\r\x1b[2K${line}\n`;
    for (let i = clipped.length; i < this.lineCount; i++) out += '\r\x1b[2K\n';
    if (clipped.length < this.lineCount) out += `\x1b[${this.lineCount - clipped.length}A`;

    process.stdout.write(out);
    this.lineCount = clipped.length;
  }

  /** Erases the block entirely, leaving the cursor where it started. */
  clear(): void {
    if (!this.enabled || !this.lineCount) return;
    let out = `\x1b[${this.lineCount}A`;
    for (let i = 0; i < this.lineCount; i++) out += '\r\x1b[2K\n';
    out += `\x1b[${this.lineCount}A`;
    process.stdout.write(out);
    this.lineCount = 0;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_PATTERN, '').length;
}
