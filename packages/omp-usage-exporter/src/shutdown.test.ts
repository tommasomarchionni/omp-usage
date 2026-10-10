import { describe, it, expect } from 'vitest';
import { ShutdownManager } from './shutdown.js';
import { silentLogger } from './logger.js';

describe('ShutdownManager', () => {
  it('runs steps in order exactly once', async () => {
    const calls: string[] = [];
    const m = new ShutdownManager(
      [
        { name: 'a', stop: async () => void calls.push('a') },
        { name: 'b', stop: () => void calls.push('b') },
      ],
      silentLogger,
      1000
    );
    const [r1, r2] = await Promise.all([m.shutdown('x'), m.shutdown('y')]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toBe(r1);
    expect(calls).toEqual(['a', 'b']);
  });

  it('reports a timeout when a step hangs', async () => {
    const m = new ShutdownManager(
      [{ name: 'hang', stop: () => new Promise(() => {}) }],
      silentLogger,
      50
    );
    await expect(m.shutdown('x')).resolves.toEqual({ ok: false });
  });

  it('reports failure when a step throws', async () => {
    const m = new ShutdownManager(
      [{ name: 'bad', stop: () => Promise.reject(new Error('no')) }],
      silentLogger,
      1000
    );
    await expect(m.shutdown('x')).resolves.toEqual({ ok: false });
  });
});
