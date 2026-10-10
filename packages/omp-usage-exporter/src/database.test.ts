import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { DB_SCHEMA_VERSION, DatabaseLockedError, ExporterDatabase } from './database.js';
import type { FileCursor, UsageEvent } from './protocol.js';
import { makeEvent, tempDir } from '../test/helpers.js';

const cursor = (offset: number): FileCursor => ({
  filePath: '/x/a.jsonl',
  offset,
  fileSize: offset,
  inode: 1,
  device: 1,
  mtimeMs: 0,
  tailHash: 'h',
});

describe('ExporterDatabase', () => {
  let dir: ReturnType<typeof tempDir>;
  let dbPath: string;
  let db: ExporterDatabase;

  beforeEach(() => {
    dir = tempDir();
    dbPath = join(dir.path, 'nested', 'exporter.db');
    db = new ExporterDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('creates the schema and sets user_version', () => {
    expect(db.getSchemaVersion()).toBe(DB_SCHEMA_VERSION);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it('reopens an existing database (regression: second start crashed)', () => {
    db.close();
    db = new ExporterDatabase(dbPath);
    expect(db.getSchemaVersion()).toBe(DB_SCHEMA_VERSION);
  });

  it('rejects a second writer on the same database', () => {
    expect(() => new ExporterDatabase(dbPath, { lockTimeoutMs: 50 })).toThrow(DatabaseLockedError);
  });

  it('allows a read-only, lock-free open while the writer runs', async () => {
    const ro = new ExporterDatabase(dbPath, { lock: false });
    const out = join(dir.path, 'backup.db');
    await ro.backup(out);
    ro.close();
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it('applies a batch atomically and updates aggregates', () => {
    const e = makeEvent() as UsageEvent;
    const r = db.applyBatch({ events: [e], invalid: { invalid_json: 2 }, cursor: cursor(100) });
    expect(r).toEqual({ imported: 1, duplicates: 0 });
    const [agg] = db.getAggregates();
    expect(agg).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/free',
      inputTokens: 11351,
      outputTokens: 83,
      reasoningTokens: 71,
      requestsSuccess: 1,
      requestsError: 0,
      usageMissing: 0,
      costMissing: 0,
    });
    expect(db.getInvalidRecordCounts()).toEqual({ invalid_json: 2 });
    expect(db.getCursor('/x/a.jsonl')?.offset).toBe(100);
  });

  it('does not double count duplicate event ids', () => {
    const e = makeEvent() as UsageEvent;
    db.applyBatch({ events: [e], invalid: {}, cursor: cursor(1) });
    const r = db.applyBatch({ events: [e], invalid: {}, cursor: cursor(2) });
    expect(r).toEqual({ imported: 0, duplicates: 1 });
    expect(db.getAggregates()[0]?.inputTokens).toBe(11351);
    expect(db.countEvents()).toBe(1);
  });

  it('classifies error, aborted, missing usage and missing cost', () => {
    db.applyBatch({
      events: [
        makeEvent({ stopReason: 'error', usage: { input: 0, output: 0, cost: { total: 0 } } }),
        makeEvent({ stopReason: 'aborted' }),
        makeEvent({ usage: null }),
        makeEvent({ usage: { input: 5, output: 1 } }),
        makeEvent({ provider: null, model: null, stopReason: null }),
      ] as UsageEvent[],
      invalid: {},
      cursor: cursor(1),
    });
    const aggs = db.getAggregates();
    const or = aggs.find(a => a.provider === 'openrouter')!;
    expect(or.requestsError).toBe(1);
    expect(or.requestsAborted).toBe(1);
    expect(or.requestsSuccess).toBe(2);
    expect(or.usageMissing).toBe(1);
    expect(or.costMissing).toBe(1);
    const unknown = aggs.find(a => a.provider === 'unknown')!;
    expect(unknown.model).toBe('unknown');
    expect(unknown.requestsSuccess).toBe(1);
    const reasons = db
      .getStopReasonAggregates()
      .map(s => `${s.provider}:${s.stopReason}=${s.count}`);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'openrouter:error=1',
        'openrouter:aborted=1',
        'openrouter:stop=2',
        'unknown:unknown=1',
      ])
    );
  });

  it('rolls back everything when a statement fails', () => {
    const bad = { ...makeEvent(), sessionRunId: null } as unknown as UsageEvent; // NOT NULL violation
    expect(() =>
      db.applyBatch({
        events: [makeEvent() as UsageEvent, bad],
        invalid: { invalid_json: 1 },
        cursor: cursor(50),
      })
    ).toThrow();
    expect(db.countEvents()).toBe(0);
    expect(db.getAggregates()).toEqual([]);
    expect(db.getInvalidRecordCounts()).toEqual({});
    expect(db.getCursor('/x/a.jsonl')).toBeNull();
  });

  it('rebuildAggregates reproduces incremental aggregates', () => {
    db.applyBatch({
      events: [
        makeEvent(),
        makeEvent({ stopReason: 'error' }),
        makeEvent({ usage: null }),
      ] as UsageEvent[],
      invalid: {},
      cursor: cursor(1),
    });
    const before = db.getAggregates();
    const reasonsBefore = db.getStopReasonAggregates();
    db.rebuildAggregates();
    expect(db.getAggregates()).toEqual(before);
    expect(db.getStopReasonAggregates()).toEqual(reasonsBefore);
  });

  it('refuses a database from a newer exporter', () => {
    db.close();
    const raw = new Database(dbPath);
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => new ExporterDatabase(dbPath)).toThrow(/newer than supported/);
    db = new ExporterDatabase(join(dir.path, 'other.db'));
  });
});

describe('migration from legacy (<= 0.2.2) databases', () => {
  it('upgrades a v0.2.2 database, rebuilds aggregates and resets cursors', () => {
    const dir = tempDir();
    const dbPath = join(dir.path, 'legacy.db');
    // Reproduce the 0.2.2 layout: tables exist, user_version left at 0.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        session_run_id TEXT NOT NULL, timestamp TEXT NOT NULL, event_type TEXT NOT NULL, provider TEXT,
        model TEXT, api TEXT, stop_reason TEXT, usage_input INTEGER, usage_output INTEGER,
        usage_cache_read INTEGER, usage_cache_write INTEGER, usage_total_tokens INTEGER,
        usage_reasoning_tokens INTEGER, usage_cost_input REAL, usage_cost_output REAL,
        usage_cost_cache_read REAL, usage_cost_cache_write REAL, usage_cost_total REAL, raw_json TEXT NOT NULL);
      CREATE TABLE cursors (file_path TEXT PRIMARY KEY, offset INTEGER NOT NULL, file_size INTEGER NOT NULL,
        inode INTEGER NOT NULL, device INTEGER NOT NULL, mtime_ms INTEGER NOT NULL);
      CREATE TABLE aggregates (provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        requests_success INTEGER NOT NULL DEFAULT 0, requests_error INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL NOT NULL DEFAULT 0, usage_missing INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, model));
      CREATE TABLE operational_metrics (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE schema_info (version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO events (event_id, session_run_id, timestamp, event_type, provider, model, stop_reason,
        usage_input, usage_output, usage_reasoning_tokens, usage_cost_total, raw_json)
      VALUES ('e1', 's', 't', 'assistant_message_end', 'openrouter', 'openrouter/free', 'stop', 10, 5, 2, 0,
        '{"usage":{"input":10}}');
      INSERT INTO aggregates (provider, model, input_tokens) VALUES ('openrouter', 'openrouter/free', 999);
      INSERT INTO cursors VALUES ('/f.jsonl', 123, 1000, 1, 1, 0);
      INSERT INTO operational_metrics VALUES ('import_errors_malformed', '42');
    `);
    raw.close();

    const db = new ExporterDatabase(dbPath);
    expect(db.getSchemaVersion()).toBe(DB_SCHEMA_VERSION);
    expect(db.getAggregates()[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      requestsSuccess: 1,
    });
    expect(db.getCursor('/f.jsonl')).toBeNull();
    expect(db.getOperationalMetric('import_errors_malformed')).toBeNull();
    db.close();
    dir.cleanup();
  });
});
