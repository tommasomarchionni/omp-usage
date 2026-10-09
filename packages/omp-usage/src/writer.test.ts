import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventWriter, resolveEventsDir, createPluginConfig } from "./writer.js";
import { createEvent, type UsageEvent } from "@tommasomarchionni/omp-usage-protocol";
import { rmSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
describe("resolveEventsDir", () => {
  it("returns default path when empty", () => {
    const result = resolveEventsDir("");
    expect(result).toContain(".local/state/omp-usage/events");
  });

  it("expands tilde", () => {
    const result = resolveEventsDir("~/custom/path");
    expect(result).toContain("custom/path");
    expect(result).not.toContain("~");
  });

  it("returns absolute path for relative", () => {
    const result = resolveEventsDir("relative/path");
    expect(result).toContain("relative/path");
  });
});

describe("createPluginConfig", () => {
  it("returns defaults with resolved eventsDir", () => {
    const config = createPluginConfig({});
    expect(config.eventsDir).toContain(".local/state/omp-usage/events");
    expect(config.maxQueueSize).toBe(1000);
    expect(config.flushIntervalMs).toBe(1000);
    expect(config.fileMode).toBe(0o600);
    expect(config.dirMode).toBe(0o700);
  });

  it("overrides provided values", () => {
    const config = createPluginConfig({ maxQueueSize: 500, flushIntervalMs: 500 });
    expect(config.maxQueueSize).toBe(500);
    expect(config.flushIntervalMs).toBe(500);
  });
});

describe("EventWriter", () => {
  const testDir = join(tmpdir(), `omp-usage-test-${Date.now()}`);
  let writer: EventWriter;
  const sessionRunId = "550e8400-e29b-41d4-a716-446655440000";

  const createTestEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => {
    const base = createEvent({
      eventType: "assistant_message_end",
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop",
      usage: {
        input: 100,
        output: 50,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    return { ...base, ...overrides, sessionRunId };
  };

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    const config = createPluginConfig({ eventsDir: testDir });
    writer = new EventWriter(sessionRunId, config);
  });

  afterEach(async () => {
    await writer.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("writes event to queue", () => {
    const event = createTestEvent();
    const ok = writer.write(event);
    expect(ok).toBe(true);
    expect(writer.getQueueLength()).toBe(1);
  });

  it("flushes events to file", async () => {
    const event = createTestEvent();
    writer.write(event);
    await writer.flush();
    expect(writer.getQueueLength()).toBe(0);
    expect(writer.getBytesWritten()).toBeGreaterThan(0);
  });

  it("creates JSONL file with correct content", async () => {
    const event = createTestEvent();
    writer.write(event);
    await writer.flush();

    const filePath = writer.getFilePath();
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.sessionRunId).toBe(sessionRunId);
    expect(parsed.provider).toBe("openrouter");
    expect(parsed.usage?.input).toBe(100);
  });

  it("appends multiple events to same file", async () => {
    writer.write(createTestEvent({ eventId: "111e8400-e29b-41d4-a716-446655440001" }));
    writer.write(createTestEvent({ eventId: "222e8400-e29b-41d4-a716-446655440002" }));
    await writer.flush();

    const content = readFileSync(writer.getFilePath(), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("returns false when queue is full", () => {
    const config = createPluginConfig({ eventsDir: testDir, maxQueueSize: 2 });
    const smallWriter = new EventWriter(sessionRunId, config);

    smallWriter.write(createTestEvent());
    smallWriter.write(createTestEvent());
    const ok = smallWriter.write(createTestEvent());
    expect(ok).toBe(false);
    expect(smallWriter.getQueueLength()).toBe(2);
  });

  it("returns false after close", async () => {
    await writer.close();
    const ok = writer.write(createTestEvent());
    expect(ok).toBe(false);
  });

  it("closes and flushes remaining events", async () => {
    writer.write(createTestEvent());
    writer.write(createTestEvent());
    await writer.close();
    expect(writer.getQueueLength()).toBe(0);
  });

  it("uses correct file permissions", async () => {
    writer.write(createTestEvent());
    await writer.flush();

    const filePath = writer.getFilePath();
    const stats = statSync(filePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});