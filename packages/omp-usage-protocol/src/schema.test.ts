import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, validateEvent, safeValidateEvent } from './schema.js';
describe('UsageEventSchema', () => {
  const validEventBase = {
    schemaVersion: SCHEMA_VERSION,
    eventId: '550e8400-e29b-41d4-a716-446655440000',
    sessionRunId: '660e8400-e29b-41d4-a716-446655440001',
    timestamp: '2026-01-15T10:30:00.000Z',
    eventType: 'assistant_message_end' as const,
    provider: 'openrouter',
    model: 'openrouter/free',
    api: 'openrouter',
    stopReason: 'stop' as const,
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

  it('accepts a valid complete event', () => {
    const result = validateEvent(validEventBase);
    expect(result).toEqual(validEventBase);
  });

  it('accepts event with null usage', () => {
    const event = { ...validEventBase, usage: null };
    const result = validateEvent(event);
    expect(result.usage).toBeNull();
  });

  it('accepts event with partial usage (optional fields omitted)', () => {
    const event = {
      ...validEventBase,
      usage: {
        input: 100,
        output: 50,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const result = validateEvent(event);
    expect(result.usage?.input).toBe(100);
    expect(result.usage?.cacheRead).toBeUndefined();
  });

  it('rejects negative input tokens', () => {
    const event = { ...validEventBase, usage: { ...validEventBase.usage!, input: -1 } };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects NaN values', () => {
    const event = { ...validEventBase, usage: { ...validEventBase.usage!, input: NaN } };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects Infinity', () => {
    const event = { ...validEventBase, usage: { ...validEventBase.usage!, input: Infinity } };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID', () => {
    const event = { ...validEventBase, eventId: 'not-a-uuid' };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects invalid ISO timestamp', () => {
    const event = { ...validEventBase, timestamp: 'not-a-timestamp' };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const event: Record<string, unknown> = { ...validEventBase };
    delete event.provider;
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('accepts a stop reason introduced by a newer OMP version', () => {
    const event = { ...validEventBase, stopReason: 'refusal' };
    expect(safeValidateEvent(event).success).toBe(true);
  });

  it('rejects empty or oversized stopReason', () => {
    expect(safeValidateEvent({ ...validEventBase, stopReason: '' }).success).toBe(false);
    expect(safeValidateEvent({ ...validEventBase, stopReason: 'x'.repeat(65) }).success).toBe(
      false
    );
  });

  it('accepts usage without cost (missing cost is not zero)', () => {
    const event = { ...validEventBase, usage: { input: 1, output: 2 } };
    expect(safeValidateEvent(event).success).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    const event = { ...validEventBase, usage: { input: Number.POSITIVE_INFINITY } };
    expect(safeValidateEvent(event).success).toBe(false);
  });

  it('rejects unknown eventType', () => {
    const event = { ...validEventBase, eventType: 'unknown_type' };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects wrong schemaVersion', () => {
    const event = { ...validEventBase, schemaVersion: 2 };
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const event: Record<string, unknown> = { ...validEventBase };
    delete event.provider;
    const result = safeValidateEvent(event);
    expect(result.success).toBe(false);
  });

  it('allows cost fields to be zero', () => {
    const event = {
      ...validEventBase,
      usage: {
        ...validEventBase.usage!,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const result = validateEvent(event);
    expect(result.usage?.cost.total).toBe(0);
  });

  it('accepts null provider/model/api/stopReason', () => {
    const event = {
      ...validEventBase,
      provider: null,
      model: null,
      api: null,
      stopReason: null,
    };
    const result = validateEvent(event);
    expect(result.provider).toBeNull();
    expect(result.stopReason).toBeNull();
  });

  it('accepts orchestration field', () => {
    const event = {
      ...validEventBase,
      usage: {
        ...validEventBase.usage!,
        orchestration: { input: 10, cacheRead: 5, output: 2 },
      },
    };
    const result = validateEvent(event);
    expect(result.usage?.orchestration?.input).toBe(10);
  });

  it('accepts cttl field', () => {
    const event = {
      ...validEventBase,
      usage: {
        ...validEventBase.usage!,
        cttl: { ephemeral5m: 100, ephemeral1h: 50 },
      },
    };
    const result = validateEvent(event);
    expect(result.usage?.cttl?.ephemeral5m).toBe(100);
  });

  it('accepts server field', () => {
    const event = {
      ...validEventBase,
      usage: {
        ...validEventBase.usage!,
        server: { webSearch: 2, webFetch: 1 },
      },
    };
    const result = validateEvent(event);
    expect(result.usage?.server?.webSearch).toBe(2);
  });

  it('accepts credits field', () => {
    const event = {
      ...validEventBase,
      usage: {
        ...validEventBase.usage!,
        credits: { cost: 1.5, committedCost: 1.5, acuCost: 0 },
      },
    };
    const result = validateEvent(event);
    expect(result.usage?.credits?.cost).toBe(1.5);
  });
});
