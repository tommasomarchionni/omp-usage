import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExporterDatabase } from "./database.js";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ExporterDatabase", () => {
  const testDir = join(tmpdir(), `omp-exporter-test-${Date.now()}`);
  const dbPath = join(testDir, "exporter.db");
  let db: ExporterDatabase;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = new ExporterDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("initializes schema on first run", () => {
    const tables = db.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("events");
    expect(names).toContain("cursors");
    expect(names).toContain("aggregates");
    expect(names).toContain("operational_metrics");
    expect(names).toContain("schema_info");
  });

  it("imports events and updates aggregates", () => {
    const events = [
      {
        event: {
          schemaVersion: 1,
          eventId: "550e8400-e29b-41d4-a716-446655440001",
          sessionRunId: "660e8400-e29b-41d4-a716-446655440002",
          timestamp: "2026-01-15T10:30:00.000Z",
          eventType: "assistant_message_end",
          provider: "openrouter",
          model: "openrouter/free",
          api: "openrouter",
          stopReason: "stop",
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1500,
            reasoningTokens: 50,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        cursor: {
          filePath: "/test/events.jsonl",
          offset: 100,
          fileSize: 200,
          inode: 123,
          device: 456,
          mtimeMs: Date.now(),
        },
      },
    ];

    const result = db.importEvents(events);
    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);

    const aggregates = db.getAggregates();
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].provider).toBe("openrouter");
    expect(aggregates[0].model).toBe("openrouter/free");
    expect(aggregates[0].inputTokens).toBe(1000);
    expect(aggregates[0].outputTokens).toBe(500);
    expect(aggregates[0].reasoningTokens).toBe(50);
    expect(aggregates[0].requestsSuccess).toBe(1);
    expect(aggregates[0].requestsError).toBe(0);
  });

  it("handles duplicate event_id", () => {
    const event = {
      event: {
        schemaVersion: 1,
        eventId: "550e8400-e29b-41d4-a716-446655440001",
        sessionRunId: "660e8400-e29b-41d4-a716-446655440002",
        timestamp: "2026-01-15T10:30:00.000Z",
        eventType: "assistant_message_end",
        provider: "openrouter",
        model: "openrouter/free",
        api: "openrouter",
        stopReason: "stop",
        usage: { input: 100, output: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      cursor: { filePath: "/test/events.jsonl", offset: 100, fileSize: 200, inode: 123, device: 456, mtimeMs: Date.now() },
    };

    db.importEvents([event]);
    const result = db.importEvents([event]);
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(1);
  });

  it("counts error stopReason as requests_error", () => {
    const events = [
      {
        event: {
          schemaVersion: 1,
          eventId: "550e8400-e29b-41d4-a716-446655440001",
          sessionRunId: "660e8400-e29b-41d4-a716-446655440002",
          timestamp: "2026-01-15T10:30:00.000Z",
          eventType: "assistant_message_end",
          provider: "openrouter",
          model: "openrouter/free",
          api: "openrouter",
          stopReason: "error",
          usage: { input: 100, output: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        cursor: { filePath: "/test/events.jsonl", offset: 100, fileSize: 200, inode: 123, device: 456, mtimeMs: Date.now() },
      },
    ];

    db.importEvents(events);
    const aggregates = db.getAggregates();
    expect(aggregates[0].requestsSuccess).toBe(0);
    expect(aggregates[0].requestsError).toBe(1);
  });

  it("counts missing usage as usage_missing", () => {
    const events = [
      {
        event: {
          schemaVersion: 1,
          eventId: "550e8400-e29b-41d4-a716-446655440001",
          sessionRunId: "660e8400-e29b-41d4-a716-446655440002",
          timestamp: "2026-01-15T10:30:00.000Z",
          eventType: "assistant_message_end",
          provider: "openrouter",
          model: "openrouter/free",
          api: "openrouter",
          stopReason: "stop",
          usage: null,
        },
        cursor: { filePath: "/test/events.jsonl", offset: 100, fileSize: 200, inode: 123, device: 456, mtimeMs: Date.now() },
      },
    ];

    db.importEvents(events);
    const aggregates = db.getAggregates();
    expect(aggregates[0].usageMissing).toBe(1);
  });

  it("tracks cursors", () => {
    const cursor = {
      filePath: "/test/events.jsonl",
      offset: 500,
      fileSize: 1000,
      inode: 123,
      device: 456,
      mtimeMs: Date.now(),
    };

    db.getDatabase().prepare("INSERT INTO cursors VALUES (?, ?, ?, ?, ?, ?)").run(
      cursor.filePath,
      cursor.offset,
      cursor.fileSize,
      cursor.inode,
      cursor.device,
      cursor.mtimeMs,
    );

    const retrieved = db.getCursor("/test/events.jsonl");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.offset).toBe(500);
  });

  it("manages operational metrics", () => {
    db.setOperationalMetric("test_key", "test_value");
    expect(db.getOperationalMetric("test_key")).toBe("test_value");

    db.incrementOperationalMetric("counter");
    db.incrementOperationalMetric("counter");
    expect(db.getOperationalMetric("counter")).toBe("2");
  });

  it("closes database", () => {
    expect(() => db.close()).not.toThrow();
  });
});