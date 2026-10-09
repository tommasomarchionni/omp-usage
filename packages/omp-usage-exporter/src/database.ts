import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { FileCursor, AggregatedMetrics } from "@tommasomarchionni/omp-usage-protocol";

export const SCHEMA_VERSION = 1;

interface UsageEventRow {
  eventId: string;
  sessionRunId: string;
  timestamp: string;
  eventType: string;
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: string | null;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  } | null;
}
export class ExporterDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");

    this.initialize();
  }

  private initialize(): void {
    const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const currentVersion = versionRow?.user_version ?? 0;

    if (currentVersion < SCHEMA_VERSION) {
      this.migrate(currentVersion);
    }
  }

  private migrate(fromVersion: number): void {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      if (fromVersion === 0) {
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

        this.db.prepare("INSERT INTO schema_info (version, updated_at) VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  importEvents(
    events: Array<{ event: unknown; cursor: FileCursor }>,
  ): { imported: number; duplicates: number; errors: number } {
    const stmtInsertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (
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
    `);

    const stmtUpdateCursor = this.db.prepare(`
      INSERT OR REPLACE INTO cursors (file_path, offset, file_size, inode, device, mtime_ms)
      VALUES (@filePath, @offset, @fileSize, @inode, @device, @mtimeMs)
    `);
    const stmtUpdateAggregates = this.db.prepare(`
      INSERT INTO aggregates (provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                              reasoning_tokens, requests_success, requests_error, reported_cost_usd, usage_missing)
      VALUES (@provider, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
              @reasoning_tokens, @requests_success, @requests_error, @reported_cost_usd, @usage_missing)
      ON CONFLICT(provider, model) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        requests_success = requests_success + excluded.requests_success,
        requests_error = requests_error + excluded.requests_error,
        reported_cost_usd = reported_cost_usd + excluded.reported_cost_usd,
        usage_missing = usage_missing + excluded.usage_missing
    `);

    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    const transaction = this.db.transaction((items: typeof events) => {
      for (const item of items) {
        const event = item.event as UsageEventRow;
        const cursor = item.cursor;

        const existing = this.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(event.eventId);
        if (existing) {
          duplicates++;
          stmtUpdateCursor.run(cursor);
          continue;
        }

        const usage = event.usage;
        const isError = event.stopReason === "error";

        const result = stmtInsertEvent.run({
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
          usage_cost_input: usage?.cost?.input ?? null,
          usage_cost_output: usage?.cost?.output ?? null,
          usage_cost_cache_read: usage?.cost?.cacheRead ?? null,
          usage_cost_cache_write: usage?.cost?.cacheWrite ?? null,
          usage_cost_total: usage?.cost?.total ?? null,
          raw_json: JSON.stringify(event),
        });

        if (result.changes > 0) {
          imported++;
        } else {
          duplicates++;
        }

        stmtUpdateAggregates.run({
          provider: event.provider ?? "unknown",
          model: event.model ?? "unknown",
          input_tokens: usage?.input ?? 0,
          output_tokens: usage?.output ?? 0,
          cache_read_tokens: usage?.cacheRead ?? 0,
          cache_write_tokens: usage?.cacheWrite ?? 0,
          reasoning_tokens: usage?.reasoningTokens ?? 0,
          requests_success: isError ? 0 : 1,
          requests_error: isError ? 1 : 0,
          reported_cost_usd: usage?.cost?.total ?? 0,
          usage_missing: usage === null ? 1 : 0,
        });

        stmtUpdateCursor.run(cursor);
      }
    });

    try {
      transaction(events);
    } catch (e) {
      errors = events.length;
      throw e;
    }

    return { imported, duplicates, errors };
  }

  getCursor(filePath: string): FileCursor | null {
    const row = this.db.prepare("SELECT * FROM cursors WHERE file_path = ?").get(filePath) as
      | (FileCursor & { file_path: string; file_size: number; mtime_ms: number })
      | undefined;
    if (!row) return null;
    return {
      filePath: row.file_path,
      offset: row.offset,
      fileSize: row.file_size,
      inode: row.inode,
      device: row.device,
      mtimeMs: row.mtime_ms,
    };
  }

  getAggregates(): AggregatedMetrics[] {
    return this.db.prepare(`
      SELECT
        provider,
        model,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_write_tokens AS cacheWriteTokens,
        reasoning_tokens AS reasoningTokens,
        requests_success AS requestsSuccess,
        requests_error AS requestsError,
        reported_cost_usd AS reportedCostUsd,
        usage_missing AS usageMissing
      FROM aggregates
    `).all() as AggregatedMetrics[];
  }

  getOperationalMetrics(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM operational_metrics").all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  setOperationalMetric(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO operational_metrics (key, value) VALUES (?, ?)").run(key, value);
  }

  incrementOperationalMetric(key: string, delta = 1): void {
    const current = this.getOperationalMetric(key);
    const next = (current ? parseInt(current, 10) : 0) + delta;
    this.setOperationalMetric(key, String(next));
  }

  getOperationalMetric(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM operational_metrics WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.db.close();
  }

  getDatabase(): Database.Database {
    return this.db;
  }
}