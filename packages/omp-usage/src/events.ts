import { randomUUID } from 'node:crypto';
import type { AssistantMessageEvent, Usage, UsageEvent } from './types.js';

const MAX_STRING = 256;

/**
 * Creates a usage event from extracted assistant message data.
 * Only metadata is recorded: never content, tool input/output or headers.
 */
export function createUsageEvent(sessionRunId: string, data: AssistantMessageEvent): UsageEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    sessionRunId,
    timestamp: new Date().toISOString(),
    eventType: 'assistant_message_end',
    provider: data.provider,
    model: data.model,
    api: data.api,
    stopReason: data.stopReason,
    usage: data.usage,
  };
}

/**
 * Extracts usage metadata from an OMP `message_end` payload.
 *
 * The payload is untrusted: every field is type-checked and copied into a
 * fresh object, so unexpected fields (content, tool calls, provider-specific
 * extras) are never written. Invalid numbers (negative, NaN, Infinity,
 * non-integer token counts) are dropped individually instead of making the
 * whole event invalid for the exporter.
 */
export function extractAssistantMessageData(message: unknown): AssistantMessageEvent | null {
  if (!isRecord(message) || message['role'] !== 'assistant') {
    return null;
  }

  const counter = { dropped: 0 };
  const rawUsage = message['usage'];
  const usage = isRecord(rawUsage) ? sanitizeUsage(rawUsage, counter) : null;
  const ts = message['timestamp'];

  return {
    provider: str(message['provider']),
    model: str(message['model']),
    api: str(message['api']),
    stopReason: str(message['stopReason'], 64),
    usage,
    messageTimestamp: typeof ts === 'number' && Number.isFinite(ts) ? ts : null,
    droppedFields: counter.dropped,
  };
}

function sanitizeUsage(raw: Record<string, unknown>, c: { dropped: number }): Usage {
  const usage: Usage = {};
  assign(usage, 'input', int(raw['input'], c));
  assign(usage, 'output', int(raw['output'], c));
  assign(usage, 'cacheRead', int(raw['cacheRead'], c));
  assign(usage, 'cacheWrite', int(raw['cacheWrite'], c));
  assign(usage, 'totalTokens', int(raw['totalTokens'], c));
  assign(usage, 'reasoningTokens', int(raw['reasoningTokens'], c));
  assign(usage, 'contextTokens', int(raw['contextTokens'], c));
  assign(usage, 'premiumRequests', int(raw['premiumRequests'], c));
  assign(
    usage,
    'orchestration',
    nested(raw['orchestration'], ['input', 'cacheRead', 'output'], int, c)
  );
  assign(usage, 'cttl', nested(raw['cttl'], ['ephemeral5m', 'ephemeral1h'], int, c));
  assign(usage, 'server', nested(raw['server'], ['webSearch', 'webFetch'], int, c));
  assign(usage, 'credits', nested(raw['credits'], ['cost', 'committedCost', 'acuCost'], num, c));
  assign(
    usage,
    'cost',
    nested(raw['cost'], ['input', 'output', 'cacheRead', 'cacheWrite', 'total'], num, c)
  );
  return usage;
}

function nested<K extends string>(
  value: unknown,
  keys: readonly K[],
  conv: (v: unknown, c: { dropped: number }) => number | undefined,
  c: { dropped: number }
): Partial<Record<K, number>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.dropped++;
    return undefined;
  }
  const out: Partial<Record<K, number>> = {};
  let any = false;
  for (const k of keys) {
    const v = conv(value[k], c);
    if (v !== undefined) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

function int(v: unknown, c: { dropped: number }): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  c.dropped++;
  return undefined;
}

function num(v: unknown, c: { dropped: number }): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  c.dropped++;
  return undefined;
}

function str(v: unknown, max = MAX_STRING): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void {
  if (value !== undefined) target[key] = value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
