import { describe, it, expect } from "vitest";
import { createUsageEvent, extractAssistantMessageData } from "./events.js";
describe("extractAssistantMessageData", () => {
  it("extracts data from assistant message", () => {
    const message = {
      role: "assistant",
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
    const result = extractAssistantMessageData(message);
    expect(result).not.toBeNull();
    expect(result?.provider).toBe("openrouter");
    expect(result?.model).toBe("openrouter/free");
    expect(result?.api).toBe("openrouter");
    expect(result?.stopReason).toBe("stop");
    expect(result?.usage?.input).toBe(1000);
  });

  it("returns null for user message", () => {
    const message = { role: "user", content: "hello" };
    const result = extractAssistantMessageData(message);
    expect(result).toBeNull();
  });

  it("returns null for tool result message", () => {
    const message = { role: "toolResult", toolCallId: "123", toolName: "test" };
    const result = extractAssistantMessageData(message);
    expect(result).toBeNull();
  });

  it("handles null/undefined fields", () => {
    const message = {
      role: "assistant",
      provider: null,
      model: undefined,
      api: "openrouter",
      stopReason: "error",
      usage: null,
    };
    const result = extractAssistantMessageData(message);
    expect(result).not.toBeNull();
    expect(result?.provider).toBeNull();
    expect(result?.model).toBeNull();
    expect(result?.api).toBe("openrouter");
    expect(result?.stopReason).toBe("error");
    expect(result?.usage).toBeNull();
  });

  it("handles missing fields", () => {
    const message = { role: "assistant" };
    const result = extractAssistantMessageData(message);
    expect(result).not.toBeNull();
    expect(result?.provider).toBeNull();
    expect(result?.model).toBeNull();
    expect(result?.api).toBeNull();
    expect(result?.stopReason).toBeNull();
    expect(result?.usage).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(extractAssistantMessageData(null)).toBeNull();
    expect(extractAssistantMessageData(undefined)).toBeNull();
    expect(extractAssistantMessageData("string")).toBeNull();
    expect(extractAssistantMessageData(123)).toBeNull();
  });
});

describe("createUsageEvent", () => {
  const sessionRunId = "660e8400-e29b-41d4-a716-446655440001";

  it("creates event with correct sessionRunId", () => {
    const data = {
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "stop" as const,
      usage: {
        input: 100,
        output: 50,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const event = createUsageEvent(sessionRunId, data);
    expect(event.sessionRunId).toBe(sessionRunId);
    expect(event.schemaVersion).toBe(1);
    expect(event.eventType).toBe("assistant_message_end");
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("includes all provided data", () => {
    const data = {
      provider: "anthropic",
      model: "claude-3-opus",
      api: "anthropic-messages",
      stopReason: "toolUse" as const,
      usage: {
        input: 2000,
        output: 1000,
        cacheRead: 100,
        cacheWrite: 50,
        totalTokens: 3150,
        reasoningTokens: 200,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0.001, total: 0.031 },
      },
    };
    const event = createUsageEvent(sessionRunId, data);
    expect(event.provider).toBe("anthropic");
    expect(event.model).toBe("claude-3-opus");
    expect(event.api).toBe("anthropic-messages");
    expect(event.stopReason).toBe("toolUse");
    expect(event.usage?.input).toBe(2000);
    expect(event.usage?.reasoningTokens).toBe(200);
  });

  it("handles null usage", () => {
    const data = {
      provider: "openrouter",
      model: "openrouter/free",
      api: "openrouter",
      stopReason: "error" as const,
      usage: null,
    };
    const event = createUsageEvent(sessionRunId, data);
    expect(event.usage).toBeNull();
  });
});