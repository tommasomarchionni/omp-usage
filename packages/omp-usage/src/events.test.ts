import { describe, it, expect } from 'vitest';
import { UsageEventSchema } from '@tommasomarchionni/omp-usage-protocol';
import { createUsageEvent, extractAssistantMessageData } from './events.js';

/** Real payload shape observed on OMP 18.8.6 with OpenRouter. */
const realMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'SECRET RESPONSE' }],
  provider: 'openrouter',
  model: 'openrouter/free',
  api: 'openrouter',
  stopReason: 'stop',
  timestamp: 1_760_000_000_000,
  usage: {
    input: 11351,
    output: 83,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 11434,
    reasoningTokens: 71,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

describe('extractAssistantMessageData', () => {
  it('extracts metadata from a real assistant message', () => {
    const d = extractAssistantMessageData(realMessage)!;
    expect(d).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/free',
      api: 'openrouter',
      stopReason: 'stop',
      messageTimestamp: 1_760_000_000_000,
      droppedFields: 0,
    });
    expect(d.usage).toEqual(realMessage.usage);
  });

  it.each([null, undefined, 42, 'x', [], { role: 'user' }, { role: 'toolResult' }])(
    'ignores non-assistant payload %j',
    m => {
      expect(extractAssistantMessageData(m)).toBeNull();
    }
  );

  it('never copies content or unknown fields', () => {
    const d = extractAssistantMessageData({
      ...realMessage,
      usage: { ...realMessage.usage, secret: 'x', headers: { authorization: 'Bearer k' } },
      apiKey: 'sk-123',
    });
    const json = JSON.stringify(createUsageEvent('s', d!));
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('sk-123');
    expect(json).not.toContain('Bearer');
    expect(json).not.toContain('secret');
  });

  it('drops invalid numbers individually and counts them', () => {
    const d = extractAssistantMessageData({
      role: 'assistant',
      usage: {
        input: -1,
        output: 1.5,
        cacheRead: Number.NaN,
        cacheWrite: Number.POSITIVE_INFINITY,
        totalTokens: '10',
        reasoningTokens: 3,
        cost: { total: -0.1, input: 0.002 },
        orchestration: 'bad',
      },
    })!;
    expect(d.usage).toEqual({ reasoningTokens: 3, cost: { input: 0.002 } });
    expect(d.droppedFields).toBe(7);
  });

  it('keeps null usage distinct from zero usage', () => {
    expect(extractAssistantMessageData({ role: 'assistant' })!.usage).toBeNull();
    expect(extractAssistantMessageData({ role: 'assistant', usage: {} })!.usage).toEqual({});
  });

  it('normalizes non-string identifiers to null and truncates long ones', () => {
    const d = extractAssistantMessageData({
      role: 'assistant',
      provider: 42,
      model: 'm'.repeat(1000),
      api: '',
      stopReason: { x: 1 },
    })!;
    expect(d.provider).toBeNull();
    expect(d.model).toHaveLength(256);
    expect(d.api).toBeNull();
    expect(d.stopReason).toBeNull();
  });

  it('passes through stop reasons added by newer OMP versions', () => {
    expect(
      extractAssistantMessageData({ role: 'assistant', stopReason: 'refusal' })!.stopReason
    ).toBe('refusal');
  });
});

describe('contract with the exporter schema', () => {
  const cases: Array<[string, unknown]> = [
    ['real OpenRouter message', realMessage],
    [
      'error with zero usage',
      { ...realMessage, stopReason: 'error', usage: { input: 0, output: 0 } },
    ],
    ['missing usage', { role: 'assistant', provider: 'p', model: 'm' }],
    [
      'garbage usage',
      {
        role: 'assistant',
        usage: { input: -5, cost: 'free', cacheRead: Number.POSITIVE_INFINITY },
      },
    ],
    ['unknown stop reason', { role: 'assistant', stopReason: 'pause_turn' }],
    ['huge model name', { role: 'assistant', model: 'x'.repeat(10_000) }],
  ];

  it.each(cases)('%s produces an event the exporter accepts', (_name, message) => {
    const data = extractAssistantMessageData(message)!;
    const event = createUsageEvent('660e8400-e29b-41d4-a716-446655440002', data);
    const parsed = UsageEventSchema.safeParse(JSON.parse(JSON.stringify(event)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
