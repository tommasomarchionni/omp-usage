import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  DEFAULTS,
  isLoopback,
  parseListen,
  parsePositiveInt,
  resolveConfig,
} from './config.js';

describe('parseListen', () => {
  it('parses host:port, [ipv6]:port and :port', () => {
    expect(parseListen('127.0.0.1:9464')).toEqual({ host: '127.0.0.1', port: 9464 });
    expect(parseListen('[::1]:9464')).toEqual({ host: '::1', port: 9464 });
    expect(parseListen(':9464')).toEqual({ host: '0.0.0.0', port: 9464 });
    expect(parseListen('localhost:1')).toEqual({ host: 'localhost', port: 1 });
  });
  it.each(['9464', '::1:9464', '[nope]:1', 'h:65536', 'h:12ab', 'h:'])('rejects %s', v => {
    expect(() => parseListen(v)).toThrow(ConfigError);
  });
});

describe('parsePositiveInt', () => {
  it.each(['10abc', '1e3', '-1', '0', '', ' ', '1.5', '99999999999999999999'])('rejects %j', v => {
    expect(() => parsePositiveInt('x', v)).toThrow(ConfigError);
  });
  it('accepts decimal integers', () => {
    expect(parsePositiveInt('x', ' 42 ')).toBe(42);
    expect(parsePositiveInt('x', 7)).toBe(7);
  });
});

describe('resolveConfig', () => {
  it('uses defaults', () => {
    const c = resolveConfig({}, {});
    expect(c.listen).toBe(DEFAULTS.listen);
    expect(c.eventsDir).toBe(join(homedir(), '.local', 'state', 'omp-usage', 'events'));
    expect(c.dbPath).toBe(join(homedir(), '.local', 'state', 'omp-usage', 'exporter.db'));
    expect(c.pollIntervalMs).toBe(5000);
    expect(c.staleAfterMs).toBe(60_000);
  });

  it('prefers flags over env over defaults', () => {
    const env = {
      OMP_USAGE_LISTEN: '127.0.0.1:1111',
      OMP_USAGE_MAX_LINE_LENGTH: '2048',
      OMP_USAGE_LOG_LEVEL: 'DEBUG',
    };
    expect(resolveConfig({}, env)).toMatchObject({
      listen: '127.0.0.1:1111',
      maxLineLength: 2048,
      logLevel: 'debug',
    });
    expect(resolveConfig({ listen: '127.0.0.1:2222', maxLineLength: '4096' }, env)).toMatchObject({
      listen: '127.0.0.1:2222',
      maxLineLength: 4096,
    });
  });

  it('ignores empty env values', () => {
    expect(
      resolveConfig({}, { OMP_USAGE_LISTEN: '', OMP_USAGE_MAX_LINE_LENGTH: '  ' }).listen
    ).toBe(DEFAULTS.listen);
  });

  it('rejects invalid env values instead of producing NaN (regression)', () => {
    expect(() => resolveConfig({}, { OMP_USAGE_MAX_LINE_LENGTH: 'abc' })).toThrow(ConfigError);
    expect(() => resolveConfig({}, { OMP_USAGE_MAX_LABEL_CARDINALITY: '-5' })).toThrow(ConfigError);
    expect(() => resolveConfig({}, { OMP_USAGE_LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
    expect(() => resolveConfig({}, { OMP_USAGE_POLL_INTERVAL_MS: '50' })).toThrow(/at least 100/);
  });

  it('expands ~ in paths', () => {
    const c = resolveConfig({ eventsDir: '~/ev', dbPath: '~/db.sqlite' }, {});
    expect(c.eventsDir).toBe(join(homedir(), 'ev'));
    expect(c.dbPath).toBe(join(homedir(), 'db.sqlite'));
  });
});

describe('isLoopback', () => {
  it('detects loopback hosts', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });
});
