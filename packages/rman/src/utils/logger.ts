import type { Repository } from '../core/repository.js';

export type LogLevel = 'silent' | 'error' | 'info' | 'verbose';
export const LOG_LEVELS: LogLevel[] = ['silent', 'error', 'info', 'verbose'];

/**
 * Gates console output by verbosity (`--log-level`/`.rmanrc logLevel`) so a command's routine
 * narration can be turned down without losing failure output - the same semantics `run`'s own
 * classic per-step log already used (see `resolveLogLevel` in `cmd/run.command.ts`), centralized here
 * so every command can respect `--log-level` instead of reimplementing the checks, or ignoring it
 * altogether via plain `console.log`.
 */
export class Logger {
  constructor(public level: LogLevel) {}

  /** Routine narration - hidden at 'silent'/'error', shown at 'info'/'verbose'. */
  info(...args: unknown[]): void {
    if (LOG_LEVELS.indexOf(this.level) < LOG_LEVELS.indexOf('info')) return;
    console.log(...args);
  }

  /** Extra detail, shown only at 'verbose'. */
  verbose(...args: unknown[]): void {
    if (LOG_LEVELS.indexOf(this.level) < LOG_LEVELS.indexOf('verbose')) return;
    console.log(...args);
  }

  /** A real failure - hidden only at 'silent', shown at every other level regardless of 'info'/'verbose'. */
  error(...args: unknown[]): void {
    if (this.level === 'silent') return;
    console.log(...args);
  }
}

/** The root's own `.rmanrc logLevel` (a plain top-level key) - the base default a command falls
 *  back to once no explicit `--log-level`/option override applies. An invalid value is ignored,
 *  falling back to 'info' rather than failing the whole command. */
export function resolveRootLogLevel(repository: Repository): LogLevel {
  const v = repository.config?.logLevel;
  return typeof v === 'string' && (LOG_LEVELS as string[]).includes(v) ? (v as LogLevel) : 'info';
}
