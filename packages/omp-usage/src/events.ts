import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, UsageEvent } from "./types.js";

/**
 * Creates a usage event from an OMP assistant message event.
 */
export function createUsageEvent(
  sessionRunId: string,
  data: AssistantMessageEvent,
): UsageEvent {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    sessionRunId,
    timestamp: now,
    eventType: "assistant_message_end",
    provider: data.provider,
    model: data.model,
    api: data.api,
    stopReason: data.stopReason,
    usage: data.usage,
  };
}

/**
 * Extracts the relevant data from an OMP assistant message.
 * Based on verified OMP 18.8.6 event shape.
 */
export function extractAssistantMessageData(message: unknown): AssistantMessageEvent | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const msg = message as Record<string, unknown>;

  if (msg["role"] !== "assistant") {
    return null;
  }

  return {
    provider: (msg["provider"] as string) ?? null,
    model: (msg["model"] as string) ?? null,
    api: (msg["api"] as string) ?? null,
    stopReason: (msg["stopReason"] as AssistantMessageEvent["stopReason"]) ?? null,
    usage: (msg["usage"] as AssistantMessageEvent["usage"]) ?? null,
  };
}