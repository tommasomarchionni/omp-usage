import { describe, it, expect } from "vitest";
import {
  validateEvent,
  validateEvents,
  validateJsonlLine,
  checkSchemaVersion,
  sanitizeForLog,
  createEvent,
  validateUsageAccounting,
  type UsageEvent,
  type UsageEventInput,
} from "./index.js";

describe("validateEvent", () => {
  const validEvent: UsageEvent = {
    schemaVersion: 1,
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
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
  };

  it("returns valid result for valid event", () => {
    const result = validateEvent(validEvent);
    expect(result.valid).toBe(true);
    expect(result.event).toEqual(validEvent);
  });

  it("returns errors for invalid event", () => {
    const result = validateEvent({ ...validEvent, eventId: "invalid" });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});

describe("validateEvents", () => {
  const validEvent: UsageEvent = {
    schemaVersion: 1,
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
    timestamp: "2026-01-15T10:30:00.000Z",
    eventType: "assistant_message_end",
    provider: "openrouter",
    model: "openrouter/free",
    api: "openrouter",
    stopReason: "stop",
    usage: {
      input: 1000,
      output: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };

  it("separates valid and invalid events", () => {
    const input = [validEvent, { ...validEvent, eventId: "invalid" }, validEvent];
    const result = validateEvents(input);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].index).toBe(1);
  });
});

describe("validateJsonlLine", () => {
  const validLine = JSON.stringify({
    schemaVersion: 1,
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
    timestamp: "2026-01-15T10:30:00.000Z",
    eventType: "assistant_message_end",
    provider: "openrouter",
    model: "openrouter/free",
    api: "openrouter",
    stopReason: "stop",
    usage: {
      input: 1000,
      output: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  it("parses valid JSONL line", () => {
    const result = validateJsonlLine(validLine);
    expect(result.valid).toBe(true);
  });

  it("rejects empty line", () => {
    const result = validateJsonlLine("");
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].code).toBe("empty_line");
  });

  it("rejects invalid JSON", () => {
    const result = validateJsonlLine("{ not valid json }");
    expect(result.valid).toBe(false);
    expect(result.errors?.[0].code).toBe("invalid_json");
  });
});

describe("checkSchemaVersion", () => {
  it("returns true for current schema version", () => {
    const event: UsageEvent = {
      schemaVersion: 1,
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
      timestamp: "2026-01-15T10:30:00.000Z",
      eventType: "assistant_message_end",
      provider: null,
      model: null,
      api: null,
      stopReason: null,
      usage: null,
    };
    expect(checkSchemaVersion(event)).toBe(true);
  });

  it("returns false for different schema version", () => {
    const event: UsageEvent = {
      ...{
        schemaVersion: 1,
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
        timestamp: "2026-01-15T10:30:00.000Z",
        eventType: "assistant_message_end",
        provider: null,
        model: null,
        api: null,
        stopReason: null,
        usage: null,
      },
      schemaVersion: 2,
    };
    expect(checkSchemaVersion(event)).toBe(false);
  });
});

describe("sanitizeForLog", () => {
  it("returns event unchanged", () => {
    const event: UsageEvent = {
      schemaVersion: 1,
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
      timestamp: "2026-01-15T10:30:00.000Z",
      eventType: "assistant_message_end",
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop",
      usage: {
        input: 1000,
        output: 500,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    expect(sanitizeForLog(event)).toEqual(event);
  });
});

describe("createEvent", () => {
  it("generates required fields", () => {
    const input: UsageEventInput = {
      eventType: "assistant_message_end",
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop",
      usage: {
        input: 1000,
        output: 500,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const event = createEvent(input);
    expect(event.schemaVersion).toBe(1);
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.sessionRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("uses provided timestamp", () => {
    const input: UsageEventInput = {
      eventType: "assistant_message_end",
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop",
      usage: null,
      timestamp: "2026-01-15T10:30:00.000Z",
    };
    const event = createEvent(input);
    expect(event.timestamp).toBe("2026-01-15T10:30:00.000Z");
  });
});

describe("validateUsageAccounting", () => {
  it("returns no warnings for valid usage", () => {
    const usage = {
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1500,
      reasoningTokens: 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const warnings = validateUsageAccounting(usage);
    expect(warnings).toHaveLength(0);
  });

  it("warns when reasoningTokens exceeds output", () => {
    const usage = {
      input: 1000,
      output: 100,
      reasoningTokens: 200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const warnings = validateUsageAccounting(usage);
    expect(warnings.some((w) => w.includes("reasoningTokens") && w.includes("exceeds output"))).toBe(true);
  });

  it("warns when totalTokens less than sum of parts", () => {
    const usage = {
      input: 1000,
      output: 500,
      cacheRead: 100,
      cacheWrite: 50,
      totalTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const warnings = validateUsageAccounting(usage);
    expect(warnings.some((w) => w.includes("totalTokens") && w.includes("less than sum"))).toBe(true);
  });

  it("returns empty array for null usage", () => {
    expect(validateUsageAccounting(null)).toHaveLength(0);
  });

  it("warns on negative values", () => {
    const usage = {
      input: -100,
      output: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const warnings = validateUsageAccounting(usage);
    expect(warnings.some((w) => w.includes("usage.input"))).toBe(true);
  });

  it("warns on NaN values", () => {
    const usage = {
      input: NaN,
      output: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const warnings = validateUsageAccounting(usage);
    expect(warnings.some((w) => w.includes("usage.input"))).toBe(true);
  });

  it("warns on Infinity", () => {
    const usage = {
      input: Infinity,
      output: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const warnings = validateUsageAccounting(usage);
    expect(warnings.some((w) => w.includes("usage.input"))).toBe(true);
  });
});