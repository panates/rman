import fs from 'node:fs';
import path from 'node:path';
import type { ProgressItem } from '../../utils/progress-panel.js';
import type { LogLevel } from './logger.js';

/**
 * One thing that happened during a run, in the order it happened. The JSON form is exactly this
 * object with a `time` added; the text form is one line per event.
 */
export type LogEvent =
  | { event: 'start'; package: string; step: string; command?: string }
  | {
      event: 'output';
      package: string;
      stream: 'stdout' | 'stderr';
      line: string;
      /** Set on a line rman itself wrote to say why a step failed - never inferred from the stream. */
      level?: 'error';
    }
  | { event: 'end'; package: string; step: string; status: 'success' | 'failed'; ms: number; error?: string }
  | { event: 'summary'; succeeded: number; failed: number; skipped: number; ms: number }
  | { event: 'message'; level: 'info' | 'error'; message: string };

/**
 * Something a run's events are rendered by - the screen, the `--json` stream, a log file.
 *
 * The scheduler produces each event once and hands it to every reporter the run has; none of them
 * knows the others exist. Adding a destination is a reporter, never another branch where the event
 * is produced.
 */
/* **Why a set of reporters rather than one writer with modes.** A step's line used to go through four
 * branches at the place it was produced - the panel's row, the plain screen, `--json`, the file - and
 * every new thing to do with a line (the package prefix was the one that showed it) meant touching
 * each of them. winston and consola were weighed for this: both make the shape available, and both
 * would have meant translating these typed events into a log record and back, while the set of
 * destinations here is closed. winston also writes files asynchronously, which loses the last lines
 * of an interrupted run - the ones that say why it was interrupted. */
export interface Reporter {
  /**
   * One event. `origin` is given for every event that belongs to a package - which row it is, the
   * package's own log level, and the step's label - and is absent for the run's own (`summary`,
   * `message`).
   */
  report(event: LogEvent, origin?: ReportOrigin): void;
  /**
   * Environment a child should be started with for this reporter to render its lines - `FORCE_COLOR`
   * where a reporter prints them to a terminal, nothing where colour would only be stripped again.
   */
  readonly childEnv?: Record<string, string>;
}

/** Which package an event is about, as a screen reporter needs to know it. */
export interface ReportOrigin {
  /** The package's row - the run's state for it, whether or not a panel is drawing it. */
  item: ProgressItem;
  /** The package's own `run.<script>.logLevel`, which decides what a plain screen prints. */
  logLevel: LogLevel;
  /** The step's label for a one-line-per-step log; empty for an anonymous function. */
  label?: string;
}

/**
 * Where a run's log goes besides the screen - the global `--json` and `--log-file`.
 *
 * - **`--json`**: the log is written to stdout as JSON Lines, one event per line, and nothing else
 *   is - no panel, no spinner, no prose.
 * - **`--log-file <path>`**: the log is written to that file, in the same format the console uses -
 *   JSON Lines under `--json`, plain text lines otherwise.
 *
 * One per invocation, on `RmanApplication.logSink`, beside `statusRegion` and for the same reason:
 * what writes to it is handed the application already, so nothing reaches for ambient state.
 */
/* **A log, not an answer.** `list`, `version`, `publish`, `config`, `info` and `github-release`
 * declare their own `--json`, and what it prints is the command's *result* - a contract the shared
 * release workflow reads with `jq` (`rman publish --dry-run --json`, `rman list --json`). This never
 * writes to stdout for one of those: the result stays where it was, in the shape it had.
 *
 * **Every line is stripped of escape sequences** before it is written anywhere. A child piped with
 * `FORCE_COLOR` carries colour, and a JSON string or a log file holding `\u001b[32m` is noise to every
 * reader that is not a terminal - which is every reader of either.
 *
 * **The file is opened on the first event, not up front**, so a command that writes no log leaves
 * no empty file behind - and `used` stays false, which is how the CLI can say so. Written
 * synchronously, line by line: an interrupted run keeps every line written before the interrupt,
 * and lines from concurrent packages stay whole and in order. */
export class LogSink implements Reporter {
  /** The console format is JSON Lines - so nothing but events may reach stdout. */
  readonly json: boolean;
  /** Whether anything was written - read by the CLI to warn about a flag nothing honoured. */
  used = false;
  private fd?: number;
  private readonly file?: string;

  constructor(options: {
    /** Write the log to stdout as JSON Lines, and use that format for the file. */
    json?: boolean;
    /** Where to write the log; resolved against `cwd`. */
    file?: string;
    cwd?: string;
  }) {
    this.json = !!options.json;
    this.file = options.file ? path.resolve(options.cwd ?? process.cwd(), options.file) : undefined;
  }

  /** Whether an event would go anywhere. A caller can skip building one when it would not. */
  get active(): boolean {
    return this.json || !!this.file;
  }

  /** The resolved file, for the message that reports it. */
  get filePath(): string | undefined {
    return this.file;
  }

  report(event: LogEvent): void {
    if (!this.active) return;
    this.used = true;
    const time = new Date().toISOString();
    const clean = stripEvent(event);
    const json = JSON.stringify({ time, ...clean });
    if (this.json) process.stdout.write(json + '\n');
    if (this.file) this.append((this.json ? json : textLine(time, clean)) + '\n');
  }

  /** Closes the file, if one was opened. Safe to call twice. */
  close(): void {
    if (this.fd === undefined) return;
    fs.closeSync(this.fd);
    this.fd = undefined;
  }

  protected append(text: string): void {
    if (this.fd === undefined) {
      fs.mkdirSync(path.dirname(this.file!), { recursive: true });
      this.fd = fs.openSync(this.file!, 'w');
    }
    fs.writeSync(this.fd, text);
  }
}

/** One event as a line of the text log: the time, the package in brackets, and what happened. */
function textLine(time: string, e: LogEvent): string {
  switch (e.event) {
    case 'start':
      return `${time} [${e.package}] ▶ ${e.step}${e.command ? ` | ${e.command}` : ''}`;
    case 'output':
      return `${time} [${e.package}] ${e.line}`;
    case 'end':
      return (
        `${time} [${e.package}] ${e.status === 'success' ? '✔' : '✖'} ${e.step} ${e.status} (${e.ms} ms)` +
        (e.error ? `\n${time} [${e.package}] ${e.error.split('\n').join(`\n${time} [${e.package}] `)}` : '')
      );
    case 'summary':
      return (
        `${time} ${e.succeeded} succeeded, ${e.failed} failed` +
        (e.skipped ? `, ${e.skipped} skipped` : '') +
        ` (${e.ms} ms)`
      );
    case 'message':
      return `${time} ${e.message}`;
  }
}

/** Every string field of an event, with escape sequences removed. */
function stripEvent(e: LogEvent): LogEvent {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) out[k] = typeof v === 'string' ? stripAnsi(v) : v;
  return out as LogEvent;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
