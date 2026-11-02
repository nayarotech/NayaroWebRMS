/**
 * Minimal logging, sufficient for development.
 *
 * Deliberately not a logging library. When we need log files under the
 * `logs/` directory the data layout already reserves, this is the one place
 * that changes.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  /** Derives a logger for a sub-component, e.g. `nayaro` -> `nayaro:socket`. */
  child(scope: string): Logger;
}

export interface CreateLoggerOptions {
  readonly scope: string;
  /** Default 'info'. Set 'debug' to see every request. */
  readonly level?: LogLevel;
  /** When true the logger swallows everything - used by tests running many servers. */
  readonly silent?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: CreateLoggerOptions): Logger {
  const { scope, level = 'info', silent = false } = options;

  const write = (entryLevel: LogLevel, message: string, details?: unknown): void => {
    if (silent) return;
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;

    const stamp = new Date().toISOString();
    const line = `${stamp} ${entryLevel.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    const stream = entryLevel === 'error' || entryLevel === 'warn' ? console.error : console.log;

    if (details === undefined) stream(line);
    else stream(line, details);
  };

  return {
    debug: (message, details) => write('debug', message, details),
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details),
    child: (childScope) => createLogger({ scope: `${scope}:${childScope}`, level, silent }),
  };
}

/** A logger that discards everything. Handy as a default in tests. */
export const silentLogger: Logger = createLogger({ scope: 'silent', silent: true });
