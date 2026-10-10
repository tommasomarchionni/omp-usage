import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ResolvedConfig {
  eventsDir: string;
  dbPath: string;
  /** `host:port`, `[ipv6]:port` or `:port`. */
  listen: string;
  maxLineLength: number;
  logLevel: LogLevel;
  maxLabelCardinality: number;
  /** Interval between import cycles (a file-system watcher may trigger earlier). */
  pollIntervalMs: number;
  /** Maximum time allowed for a graceful shutdown before forcing exit. */
  shutdownTimeoutMs: number;
  /** /healthz reports unhealthy if no import succeeded for this long. */
  staleAfterMs: number;
}

export const DEFAULTS = {
  listen: '127.0.0.1:9464',
  maxLineLength: 1_048_576,
  logLevel: 'info' as LogLevel,
  maxLabelCardinality: 1000,
  pollIntervalMs: 5_000,
  shutdownTimeoutMs: 10_000,
};

export interface ConfigFlags {
  eventsDir?: string;
  dbPath?: string;
  listen?: string;
  maxLineLength?: number | string;
  logLevel?: string;
  maxLabelCardinality?: number | string;
  pollIntervalMs?: number | string;
  shutdownTimeoutMs?: number | string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parses a strictly positive decimal integer. Rejects `"10abc"`, `"1e3"`,
 * `"-1"`, `""` and values above Number.MAX_SAFE_INTEGER instead of silently
 * returning NaN or a partial value.
 */
export function parsePositiveInt(name: string, value: number | string): number {
  const n =
    typeof value === 'number'
      ? value
      : /^\s*\d+\s*$/.test(value)
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return n;
}

function pick<T>(
  flag: T | undefined,
  envName: string,
  env: NodeJS.ProcessEnv
): T | string | undefined {
  if (flag !== undefined) return flag;
  const v = env[envName];
  return v === undefined || v.trim() === '' ? undefined : v;
}

export function resolveConfig(
  flags: ConfigFlags = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const stateDir = join(homedir(), '.local', 'state', 'omp-usage');
  const eventsDir = pick(flags.eventsDir, 'OMP_USAGE_EVENTS_DIR', env) ?? join(stateDir, 'events');
  const dbPath = pick(flags.dbPath, 'OMP_USAGE_DB_PATH', env) ?? join(stateDir, 'exporter.db');
  const listen = (pick(flags.listen, 'OMP_USAGE_LISTEN', env) ?? DEFAULTS.listen).trim();

  const logLevelRaw = (pick(flags.logLevel, 'OMP_USAGE_LOG_LEVEL', env) ?? DEFAULTS.logLevel)
    .trim()
    .toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
    throw new ConfigError(
      `logLevel must be one of ${LOG_LEVELS.join(', ')} (got ${JSON.stringify(logLevelRaw)})`
    );
  }

  const int = (name: string, flag: number | string | undefined, envName: string, def: number) => {
    const v = pick(flag, envName, env);
    return v === undefined ? def : parsePositiveInt(name, v);
  };

  const pollIntervalMs = int(
    'pollIntervalMs',
    flags.pollIntervalMs,
    'OMP_USAGE_POLL_INTERVAL_MS',
    DEFAULTS.pollIntervalMs
  );

  const config: ResolvedConfig = {
    eventsDir: expandPath(eventsDir),
    dbPath: expandPath(dbPath),
    listen,
    maxLineLength: int(
      'maxLineLength',
      flags.maxLineLength,
      'OMP_USAGE_MAX_LINE_LENGTH',
      DEFAULTS.maxLineLength
    ),
    logLevel: logLevelRaw as LogLevel,
    maxLabelCardinality: int(
      'maxLabelCardinality',
      flags.maxLabelCardinality,
      'OMP_USAGE_MAX_LABEL_CARDINALITY',
      DEFAULTS.maxLabelCardinality
    ),
    pollIntervalMs,
    shutdownTimeoutMs: int(
      'shutdownTimeoutMs',
      flags.shutdownTimeoutMs,
      'OMP_USAGE_SHUTDOWN_TIMEOUT_MS',
      DEFAULTS.shutdownTimeoutMs
    ),
    staleAfterMs: Math.max(3 * pollIntervalMs, 60_000),
  };
  validateConfig(config);
  return config;
}

export function expandPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function validateConfig(config: ResolvedConfig): void {
  if (!config.eventsDir) throw new ConfigError('eventsDir is required');
  if (!config.dbPath) throw new ConfigError('dbPath is required');
  for (const key of [
    'maxLineLength',
    'maxLabelCardinality',
    'pollIntervalMs',
    'shutdownTimeoutMs',
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new ConfigError(`${key} must be a positive integer`);
    }
  }
  if (config.pollIntervalMs < 100) throw new ConfigError('pollIntervalMs must be at least 100');
  parseListen(config.listen);
}

/**
 * Parses `host:port`, `[ipv6]:port` or `:port` (all interfaces).
 * Hostnames are accepted; IPv6 literals must be bracketed.
 */
export function parseListen(listen: string): { host: string; port: number } {
  let host: string;
  let portStr: string;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(listen);
  if (v6) {
    host = v6[1] ?? '';
    portStr = v6[2] ?? '';
    if (isIP(host) !== 6)
      throw new ConfigError(`listen: invalid IPv6 address ${JSON.stringify(host)}`);
  } else {
    const idx = listen.lastIndexOf(':');
    if (idx === -1)
      throw new ConfigError('listen must be in format host:port, [ipv6]:port or :port');
    host = listen.slice(0, idx);
    portStr = listen.slice(idx + 1);
    if (host.includes(':'))
      throw new ConfigError('listen: IPv6 addresses must be written as [addr]:port');
    if (host === '') host = '0.0.0.0';
  }
  if (!/^\d+$/.test(portStr)) throw new ConfigError('listen: port must be a number');
  const port = Number(portStr);
  // Port 0 asks the OS for a free port (used by tests).
  if (port > 65535) throw new ConfigError('port must be between 0 and 65535');
  return { host, port };
}

/** True when the listener is reachable only from the local machine. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** Render an address for URLs/logs (brackets IPv6). */
export function formatHostPort(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}
