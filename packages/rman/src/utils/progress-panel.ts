import colors from 'ansi-colors';
import { LiveRegion } from './live-region.js';

export type ProgressStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface ProgressItem {
  readonly name: string;
  status: ProgressStatus;
  /** Label of the step currently running, for work with more than one step (e.g. `run`'s
   *  npm-script steps) - omit `stepsTotal` entirely for single-step work like a plain command. */
  currentStep?: string;
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
export class ProgressPanel {
  readonly live: LiveRegion;
  private readonly items = new Map<string, ProgressItem>();
  private renderLoop?: ReturnType<typeof setInterval>;
  private spinnerFrame = 0;
  private startedAt = 0;

  constructor(
    private readonly title: string,
    enabled: boolean,
  ) {
    this.live = new LiveRegion(enabled);
  }

  get enabled(): boolean {
    return this.live.enabled;
  }

  /** Registers an item and returns it - callers mutate the returned object directly (`status`,
   *  `currentStep`, `lastLine`, ...) to drive the next render tick. */
  addItem(name: string, stepsTotal?: number): ProgressItem {
    const item: ProgressItem = { name, status: 'pending', stepsTotal, log: [] };
    this.items.set(name, item);
    return item;
  }

  /** Starts the redraw loop. No-op (and no timer) when disabled. */
  start(): void {
    this.startedAt = Date.now();
    if (!this.live.enabled) return;
    this.renderLoop = setInterval(() => this.render(), 100);
  }

  private render(): void {
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const spinner = colors.cyan(SPINNER_FRAMES[this.spinnerFrame]);

    const total = this.items.size;
    let running = 0;
    let done = 0;
    let failedSoFar = 0;
    for (const item of this.items.values()) {
      if (item.status === 'running') running++;
      else if (item.status !== 'pending') done++;
      if (item.status === 'failed') failedSoFar++;
    }

    const header = colors.bgCyan.black.bold(` ${this.title} `);
    const bar = renderProgressBar(done, total);
    const totalElapsed = formatDuration(Date.now() - this.startedAt);
    const failedText =
      failedSoFar > 0 ? colors.red.bold(`${failedSoFar} failed`) : colors.gray(`${failedSoFar} failed`);
    const lines: string[] = [
      `${header} ${bar} ${colors.bold(`${done}/${total}`)}  ${colors.cyan(`${running} running`)}  ${failedText}  ${colors.yellow(totalElapsed)}`,
    ];

    const runningList = [...this.items.values()].filter(i => i.status === 'running');
    /** Leave room for the header, a safety margin, and a possible "N more running" line - a
     *  block taller than the terminal breaks cursor-up math (the terminal scrolls instead of
     *  the cursor moving, so redraws land in the wrong place and pile up). */
    const budget = Math.max(0, (process.stdout.rows || 24) - 3);
    let used = 0;
    let shown = 0;
    for (const item of runningList) {
      const elapsed = item.startedAt ? formatDuration(Date.now() - item.startedAt) : '';
      const step =
        item.stepsTotal && item.stepsTotal > 1 && item.stepIndex != null
          ? `${item.currentStep} (${item.stepIndex + 1}/${item.stepsTotal})`
          : item.currentStep || '';
      const group = [`${spinner} ${colors.bold(item.name)}  ${colors.gray(step)}  ${colors.yellow(elapsed)}`];
      if (item.lastLine) group.push(`    ${colors.dim(item.lastLine)}`);
      if (used + group.length > budget) break;
      lines.push(...group);
      used += group.length;
      shown++;
    }
    const remaining = runningList.length - shown;
    if (remaining > 0) lines.push(colors.gray(`… and ${remaining} more running`));

    this.live.render(lines);
  }

  /** Stops the redraw loop and erases the panel, leaving the cursor where it started. */
  stop(): void {
    if (this.renderLoop) clearInterval(this.renderLoop);
    this.renderLoop = undefined;
    this.live.clear();
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
          if (item.log.length) console.log(colors.red(item.log.join('\n')));
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

/** Classic braille "dots" spinner (cli-spinners' default), one frame per render tick. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function renderProgressBar(done: number, total: number, width = 24): string {
  const filled = total ? Math.round((done / total) * width) : 0;
  return colors.green('█'.repeat(filled)) + colors.gray('░'.repeat(width - filled));
}
