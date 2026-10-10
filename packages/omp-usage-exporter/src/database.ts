import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AggregatedMetrics,
  FileCursor,
  InvalidReason,
  StopReasonAggregate,
  UsageEvent,
} from './protocol.js';

/**
 * SQLite schema version stored in `PRAGMA user_version`.
 *
 * - 0: empty database (or a legacy database created by <= 0.2.2, which never
 *      set `user_version`; detected by the presence of the `events` table).
 * - 1: initial layout (events, cursors, aggregates, operational_metrics).
 * - 2: stop-reason aggregates, invalid-record counters, cursor tail hash,
 *      aggregates rebuilt from events and cursors reset (offsets written by
 *      <= 0.2.2 were not cumulative).
 */
export const DB_SCHEMA_VERSION = 2;

export class DatabaseLockedError extends Error {
  constructor(dbPath: string) {
    super(
      `Database ${dbPath} is locked by another process. ` +
        'Only one omp-usage-exporter may use a database at a time.'
    );
    this.name = 'DatabaseLockedError';
  }
}

export interface ImportBatch {
  events: UsageEvent[];
  invalid: Partial<Record<InvalidReason, number>>;
  cursor: FileCursor;
}

export interface BatchResult {
  imported: number;
  duplicates: number;
}

export interface ExporterDatabaseOptions {
  /** Milliseconds to wait for the exclusive lock before failing. */
  lockTimeoutMs?: number;
  /**
   * Acquire the single-writer lock (default true). `false` opens the
   * database read-only, without migrations (used by `--backup`, which may
   * run while the exporter is running).
   */
  lock?: boolean;
}

const UNKNOWN_LABEL = 'unknown';

export class ExporterDatabase {
  private readonly db: Database.Database;
  private readonly lockDb: Database.Database | null = null;
  private readonly readonly: boolean;
  private closed = false;

  constructor(
    private readonly dbPath: string,
    options: ExporterDatabaseOptions = {}
  ) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Single-writer guard: an OS-level lock held on a side file for the
    // lifetime of the process. It is released automatically if the process
    // crashes, and leaves the main database readable by other tools
    // (sqlite3 CLI, backups) while the exporter runs.
    if (options.lock !== false) {
      this.lockDb = acquireLock(`${dbPath}.lock`, options.lockTimeoutMs ?? 2000);
    }

    const readonly = options.lock === false;
    const isNew = !existsSync(dbPath);
    try {
      this.db = new Database(dbPath, { readonly, fileMustExist: readonly });
      this.db.pragma('busy_timeout = 5000');
      if (!readonly) {
        if (isNew) restrictPermissions(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
      }
    } catch (e) {
      this.lockDb?.close();
      throw e;
    }

    this.readonly = readonly;
    if (!readonly) this.migrate();
  }

  // ---------------------------------------------------------------- schema --

  getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private tableExists(name: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    );
  }

  private migrate(): void {
    let version = this.getSchemaVersion();
    if (version > DB_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than supported (${DB_SCHEMA_VERSION}). ` +
          'Upgrade omp-usage-exporter or restore a backup.'
      );
    }

    if (version === 0 && this.tableExists('events')) {
      // Legacy database from <= 0.2.2: tables exist but user_version was never set.
      version = 1;
    }

    const steps: Array<{ to: number; run: () => void }> = [
      { to: 1, run: () => this.migrateTo1() },
      { to: 2, run: () => this.migrateTo2() },
    ];

    for (const step of steps) {
      if (version >= step.to) continue;
      const tx = this.db.transaction(() => {
        step.run();
        this.db.pragma(`user_version = ${step.to}`);
      });
      tx.immediate();
      version = step.to;
    }

    // Keep the legacy schema_info table in sync for humans inspecting the DB.
    if (this.tableExists('schema_info')) {
      this.db.prepare('DELETE FROM schema_info').run();
      this.db
        .prepare('INSERT INTO schema_info (version, updated_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    }
  }

  private migrateTo1(): void {
    this.db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        api TEXT,
        stop_reason TEXT,
        usage_input INTEGER,
        usage_output INTEGER,
        usage_cache_read INTEGER,
        usage_cache_write INTEGER,
        usage_total_tokens INTEGER,
        usage_reasoning_tokens INTEGER,
        usage_cost_input REAL,
        usage_cost_output REAL,
        usage_cost_cache_read REAL,
        usage_cost_cache_write REAL,
        usage_cost_total REAL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX idx_events_session_run_id ON events(session_run_id);
      CREATE INDEX idx_events_timestamp ON events(timestamp);
      CREATE INDEX idx_events_provider_model ON events(provider, model);

      CREATE TABLE cursors (
        file_path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        inode INTEGER NOT NULL,
        device INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL
      );

      CREATE TABLE aggregates (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        requests_success INTEGER NOT NULL DEFAULT 0,
        requests_error INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL NOT NULL DEFAULT 0,
        usage_missing INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, model)
      );

      CREATE TABLE operational_metrics (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE schema_info (
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private migrateTo2(): void {
    this.db.exec(`
      ALTER TABLE cursors ADD COLUMN tail_hash TEXT;
      ALTER TABLE aggregates ADD COLUMN requests_aborted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE aggregates ADD COLUMN cost_missing INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE stop_reason_aggregates (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        stop_reason TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, model, stop_reason)
      );

      CREATE TABLE invalid_records (
        reason TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );

      -- Offsets written by <= 0.2.2 were not cumulative: re-read every file.
      -- The UNIQUE(event_id) constraint guarantees no double counting.
      DELETE FROM cursors;
      -- Counters of the old importer were incremented on every re-read.
      DELETE FROM operational_metrics WHERE key LIKE 'import_errors_%';
    `);
    this.rebuildAggregates();
  }

  /**
   * Recomputes every aggregate from the events table. Used by migrations and
   * available for manual recovery (`--rebuild-aggregates`).
   */
  rebuildAggregates(): void {
    this.db.exec(`
      DELETE FROM aggregates;
      INSERT INTO aggregates (
        provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, requests_success, requests_error, requests_aborted,
        reported_cost_usd, usage_missing, cost_missing
      )
      SELECT
        COALESCE(provider, '${UNKNOWN_LABEL}'), COALESCE(model, '${UNKNOWN_LABEL}'),
        COALESCE(SUM(usage_input), 0), COALESCE(SUM(usage_output), 0),
        COALESCE(SUM(usage_cache_read), 0), COALESCE(SUM(usage_cache_write), 0),
        COALESCE(SUM(usage_reasoning_tokens), 0),
        SUM(CASE WHEN stop_reason IS NULL OR stop_reason NOT IN ('error', 'aborted') THEN 1 ELSE 0 END),
        SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),
        SUM(CASE WHEN stop_reason = 'aborted' THEN 1 ELSE 0 END),
        COALESCE(SUM(usage_cost_total), 0),
        SUM(CASE WHEN json_extract(raw_json, '$.usage') IS NULL THEN 1 ELSE 0 END),
        SUM(CASE WHEN json_extract(raw_json, '$.usage') IS NOT NULL
                  AND usage_cost_total IS NULL THEN 1 ELSE 0 END)
      FROM events
      GROUP BY COALESCE(provider, '${UNKNOWN_LABEL}'), COALESCE(model, '${UNKNOWN_LABEL}')
      ORDER BY MIN(id);

      DELETE FROM stop_reason_aggregates;
      INSERT INTO stop_reason_aggregates (provider, model, stop_reason, count)
      SELECT COALESCE(provider, '${UNKNOWN_LABEL}'), COALESCE(model, '${UNKNOWN_LABEL}'),
             COALESCE(stop_reason, '${UNKNOWN_LABEL}'), COUNT(*)
      FROM events
      GROUP BY 1, 2, 3
      ORDER BY MIN(id);
    `);
  }

  // ---------------------------------------------------------------- import --

  private readonly stmts = new Map<string, Database.Statement>();

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /**
   * Applies a batch atomically: inserts new events, updates aggregates and
   * invalid-record counters, and advances the file cursor. Either everything
   * is committed or nothing is.
   */
  applyBatch(batch: ImportBatch): BatchResult {
    let imported = 0;
    let duplicates = 0;

    const insertEvent = this.stmt(`
      INSERT INTO events (
        event_id, session_run_id, timestamp, event_type, provider, model, api, stop_reason,
        usage_input, usage_output, usage_cache_read, usage_cache_write,
        usage_total_tokens, usage_reasoning_tokens,
        usage_cost_input, usage_cost_output, usage_cost_cache_read, usage_cost_cache_write, usage_cost_total,
        raw_json
      ) VALUES (
        @event_id, @session_run_id, @timestamp, @event_type, @provider, @model, @api, @stop_reason,
        @usage_input, @usage_output, @usage_cache_read, @usage_cache_write,
        @usage_total_tokens, @usage_reasoning_tokens,
        @usage_cost_input, @usage_cost_output, @usage_cost_cache_read, @usage_cost_cache_write, @usage_cost_total,
        @raw_json
      )
      ON CONFLICT(event_id) DO NOTHING
    `);
    const upsertAggregate = this.stmt(`
      INSERT INTO aggregates (provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                              reasoning_tokens, requests_success, requests_error, requests_aborted,
                              reported_cost_usd, usage_missing, cost_missing)
      VALUES (@provider, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
              @reasoning_tokens, @requests_success, @requests_error, @requests_aborted,
              @reported_cost_usd, @usage_missing, @cost_missing)
      ON CONFLICT(provider, model) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        requests_success = requests_success + excluded.requests_success,
        requests_error = requests_error + excluded.requests_error,
        requests_aborted = requests_aborted + excluded.requests_aborted,
        reported_cost_usd = reported_cost_usd + excluded.reported_cost_usd,
        usage_missing = usage_missing + excluded.usage_missing,
        cost_missing = cost_missing + excluded.cost_missing
    `);
    const upsertStopReason = this.stmt(`
      INSERT INTO stop_reason_aggregates (provider, model, stop_reason, count)
      VALUES (@provider, @model, @stop_reason, 1)
      ON CONFLICT(provider, model, stop_reason) DO UPDATE SET count = count + 1
    `);
    const upsertInvalid = this.stmt(`
      INSERT INTO invalid_records (reason, count) VALUES (@reason, @count)
      ON CONFLICT(reason) DO UPDATE SET count = count + excluded.count
    `);
    const upsertCursor = this.stmt(`
      INSERT INTO cursors (file_path, offset, file_size, inode, device, mtime_ms, tail_hash)
      VALUES (@filePath, @offset, @fileSize, @inode, @device, @mtimeMs, @tailHash)
      ON CONFLICT(file_path) DO UPDATE SET
        offset = excluded.offset, file_size = excluded.file_size, inode = excluded.inode,
        device = excluded.device, mtime_ms = excluded.mtime_ms, tail_hash = excluded.tail_hash
    `);

    const tx = this.db.transaction((b: ImportBatch) => {
      for (const event of b.events) {
        const usage = event.usage;
        const cost = usage?.cost;
        const result = insertEvent.run({
          event_id: event.eventId,
          session_run_id: event.sessionRunId,
          timestamp: event.timestamp,
          event_type: event.eventType,
          provider: event.provider,
          model: event.model,
          api: event.api,
          stop_reason: event.stopReason,
          usage_input: usage?.input ?? null,
          usage_output: usage?.output ?? null,
          usage_cache_read: usage?.cacheRead ?? null,
          usage_cache_write: usage?.cacheWrite ?? null,
          usage_total_tokens: usage?.totalTokens ?? null,
          usage_reasoning_tokens: usage?.reasoningTokens ?? null,
          usage_cost_input: cost?.input ?? null,
          usage_cost_output: cost?.output ?? null,
          usage_cost_cache_read: cost?.cacheRead ?? null,
          usage_cost_cache_write: cost?.cacheWrite ?? null,
          usage_cost_total: cost?.total ?? null,
          raw_json: JSON.stringify(event),
        });

        if (result.changes === 0) {
          // Already imported (re-read after restart, rename or cursor reset).
          duplicates++;
          continue;
        }
        imported++;

        const provider = event.provider ?? UNKNOWN_LABEL;
        const model = event.model ?? UNKNOWN_LABEL;
        upsertAggregate.run({
          provider,
          model,
          input_tokens: usage?.input ?? 0,
          output_tokens: usage?.output ?? 0,
          cache_read_tokens: usage?.cacheRead ?? 0,
          cache_write_tokens: usage?.cacheWrite ?? 0,
          reasoning_tokens: usage?.reasoningTokens ?? 0,
          requests_success: event.stopReason === 'error' || event.stopReason === 'aborted' ? 0 : 1,
          requests_error: event.stopReason === 'error' ? 1 : 0,
          requests_aborted: event.stopReason === 'aborted' ? 1 : 0,
          reported_cost_usd: cost?.total ?? 0,
          usage_missing: usage === null ? 1 : 0,
          cost_missing: usage !== null && cost?.total === undefined ? 1 : 0,
        });
        upsertStopReason.run({ provider, model, stop_reason: event.stopReason ?? UNKNOWN_LABEL });
      }

      for (const [reason, count] of Object.entries(b.invalid)) {
        if (count && count > 0) upsertInvalid.run({ reason, count });
      }

      upsertCursor.run({ ...b.cursor, tailHash: b.cursor.tailHash ?? null });
    });

    tx.immediate(batch);
    return { imported, duplicates };
  }

  getCursor(filePath: string): FileCursor | null {
    const row = this.stmt('SELECT * FROM cursors WHERE file_path = ?').get(filePath) as
      | {
          file_path: string;
          offset: number;
          file_size: number;
          inode: number;
          device: number;
          mtime_ms: number;
          tail_hash: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      filePath: row.file_path,
      offset: row.offset,
      fileSize: row.file_size,
      inode: row.inode,
      device: row.device,
      mtimeMs: row.mtime_ms,
      tailHash: row.tail_hash,
    };
  }

  listCursors(): FileCursor[] {
    return (
      this.stmt('SELECT file_path FROM cursors ORDER BY file_path').all() as Array<{
        file_path: string;
      }>
    )
      .map(r => this.getCursor(r.file_path))
      .filter((c): c is FileCursor => c !== null);
  }

  deleteCursor(filePath: string): void {
    this.stmt('DELETE FROM cursors WHERE file_path = ?').run(filePath);
  }

  // --------------------------------------------------------------- queries --

  getAggregates(): AggregatedMetrics[] {
    return this.stmt(
      `
      SELECT
        provider, model,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_write_tokens AS cacheWriteTokens,
        reasoning_tokens AS reasoningTokens,
        requests_success AS requestsSuccess,
        requests_error AS requestsError,
        requests_aborted AS requestsAborted,
        reported_cost_usd AS reportedCostUsd,
        usage_missing AS usageMissing,
        cost_missing AS costMissing
      FROM aggregates
      ORDER BY rowid
    `
    ).all() as AggregatedMetrics[];
  }

  getStopReasonAggregates(): StopReasonAggregate[] {
    return this.stmt(
      `
      SELECT provider, model, stop_reason AS stopReason, count
      FROM stop_reason_aggregates
      ORDER BY rowid
    `
    ).all() as StopReasonAggregate[];
  }

  getInvalidRecordCounts(): Record<string, number> {
    const rows = this.stmt('SELECT reason, count FROM invalid_records').all() as Array<{
      reason: string;
      count: number;
    }>;
    return Object.fromEntries(rows.map(r => [r.reason, r.count]));
  }

  countEvents(): number {
    return (this.stmt('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }

  /** Cheap liveness probe used by /healthz. */
  ping(): boolean {
    if (this.closed) return false;
    try {
      this.stmt('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  getOperationalMetric(key: string): string | null {
    const row = this.stmt('SELECT value FROM operational_metrics WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setOperationalMetric(key: string, value: string): void {
    this.stmt(
      'INSERT INTO operational_metrics (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }

  /** Online, consistent copy of the database (safe while the exporter runs). */
  async backup(destination: string): Promise<void> {
    await this.db.backup(destination);
    restrictPermissions(destination);
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    try {
      if (!this.readonly) this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A concurrent reader may prevent a full checkpoint; close still syncs.
    } finally {
      this.db.close();
      this.lockDb?.close();
    }
  }

  get path(): string {
    return this.dbPath;
  }
}

function restrictPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: some filesystems do not support chmod.
  }
}

function acquireLock(lockPath: string, timeoutMs: number): Database.Database {
  const isNew = !existsSync(lockPath);
  const lock = new Database(lockPath);
  if (isNew) restrictPermissions(lockPath);
  try {
    lock.pragma(`busy_timeout = ${timeoutMs}`);
    lock.pragma('locking_mode = EXCLUSIVE');
    // The first write transaction takes the exclusive lock; in EXCLUSIVE
    // locking mode SQLite keeps it after COMMIT until the connection closes.
    lock.exec('CREATE TABLE IF NOT EXISTS owner (pid INTEGER, started_at TEXT)');
    lock.exec('BEGIN EXCLUSIVE');
    lock.exec('DELETE FROM owner');
    lock
      .prepare('INSERT INTO owner (pid, started_at) VALUES (?, ?)')
      .run(process.pid, new Date().toISOString());
    lock.exec('COMMIT');
    return lock;
  } catch (e) {
    lock.close();
    if (isBusyError(e)) throw new DatabaseLockedError(lockPath.replace(/\.lock$/, ''));
    throw e;
  }
}

function isBusyError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    ((e as { code: string }).code.startsWith('SQLITE_BUSY') ||
      (e as { code: string }).code.startsWith('SQLITE_LOCKED'))
  );
}
