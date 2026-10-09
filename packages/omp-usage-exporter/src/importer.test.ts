import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Importer } from "./importer.js";
import { ExporterDatabase } from "./database.js";
import { resolveConfig } from "./config.js";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Importer", () => {
  const testDir = join(tmpdir(), `omp-importer-test-${Date.now()}`);
  const eventsDir = join(testDir, "events");
  const dbPath = join(testDir, "exporter.db");
  let db: ExporterDatabase;
  let importer: Importer;
  let config: ReturnType<typeof resolveConfig>;

  beforeEach(() => {
    mkdirSync(eventsDir, { recursive: true });
    config = resolveConfig({ eventsDir, dbPath });
    db = new ExporterDatabase(dbPath);
    importer = new Importer(config, db);
  });

  afterEach(async () => {
    importer.stop();
    db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("imports valid JSONL file", async () => {
    const event = {
      schemaVersion: 1,
      eventId: "550e8400-e29b-41d4-a716-446655440001",
      sessionRunId: "660e8400-e29b-41d4-a716-446655440002",
      timestamp: "2026-01-15T10:30:00.000Z",
      eventType: "assistant_message_end",
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop",
      usage: { input: 1000, output: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const filePath = join(eventsDir, "session1.jsonl");
    writeFileSync(filePath, JSON.stringify(event) + "\n");

    const result = await importer.importAll();
    expect(result.imported).toBe(1);
    expect(result.files).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("skips malformed lines", async () => {
    const filePath = join(eventsDir, "session1.jsonl");
    writeFileSync(filePath, "not valid json\n");

    const result = await importer.importAll();
    expect(result.imported).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("skips unknown schema version", async () => {
    const event = {
      schemaVersion: 999,
      eventId: "550e8400-e29b-41d4-a716-446655440001",
      sessionRunId: "660e8400-e29b-41d4-a716-446655440002",
      timestamp: "2026-01-15T10:30:00.000Z",
      eventType: "assistant_message_end",
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop",
      usage: { input: 100, output: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const filePath = join(eventsDir, "session1.jsonl");
    writeFileSync(filePath, JSON.stringify(event) + "\n");

    const result = await importer.importAll();
    expect(result.imported).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("handles empty lines", async () => {
    const event = {
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
    };
    const filePath = join(eventsDir, "session1.jsonl");
    writeFileSync(filePath, "\n" + JSON.stringify(event) + "\n\n");

    const result = await importer.importAll();
    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("tracks cursor and resumes", async () => {
    const event1 = {
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
    };
    const event2 = {
      ...event1,
      eventId: "550e8400-e29b-41d4-a716-446655440003",
    };
    const filePath = join(eventsDir, "session1.jsonl");
    writeFileSync(filePath, JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n");

    // First import
    let result = await importer.importAll();
    expect(result.imported).toBe(2);

    // Second import (should not re-import)
    result = await importer.importAll();
    expect(result.imported).toBe(0);
  });

  it("stops on demand", async () => {
    importer.stop();
    const result = await importer.importAll();
    expect(result.imported).toBe(0);
    expect(result.files).toBe(0);
  });
});