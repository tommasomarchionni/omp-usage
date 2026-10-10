import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestEventOverrides {
  [key: string]: unknown;
}

/** A schema-valid event modelled on the real OMP 18.8.6 OpenRouter payload. */
export function makeEvent(overrides: TestEventOverrides = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    sessionRunId: '660e8400-e29b-41d4-a716-446655440002',
    timestamp: '2026-10-10T10:30:00.000Z',
    eventType: 'assistant_message_end',
    provider: 'openrouter',
    model: 'openrouter/free',
    api: 'openrouter',
    stopReason: 'stop',
    usage: {
      input: 11351,
      output: 83,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11434,
      reasoningTokens: 71,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

export function line(event: Record<string, unknown>): string {
  return JSON.stringify(event) + '\n';
}

export function tempDir(prefix = 'omp-usage-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
