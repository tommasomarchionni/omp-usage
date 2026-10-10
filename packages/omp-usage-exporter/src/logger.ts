import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Minimal level-filtered logger. Lines are `<ISO time> <LEVEL> <msg> k=v ...`
 * on stderr so stdout stays clean for `--config-check` and `--version`.
 * Event content is never logged: only file paths, offsets and reasons.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = l => process.stderr.write(l + '\n')
): Logger {
  const min = ORDER[level];
  const log = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const extra = fields
      ? ' ' +
        Object.entries(fields)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
          .join(' ')
      : '';
    write(`${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}${extra}`);
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
