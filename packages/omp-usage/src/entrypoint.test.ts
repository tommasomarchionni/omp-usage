import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('plugin dist entrypoint', () => {
  it('exports a factory function compatible with OMP loader', async () => {
    const distPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    expect(existsSync(distPath)).toBe(true);

    const loaded = (await import(pathToFileURL(distPath).href)) as { default?: unknown } | unknown;
    const factory =
      typeof loaded === 'function' ? loaded : (loaded as { default?: unknown }).default;

    expect(typeof factory).toBe('function');

    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const api = {
      on(event: string, handler: (...args: unknown[]) => void): void {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    };

    const cleanup = (factory as (apiArg: typeof api) => unknown)(api);
    expect(typeof cleanup).toBe('function');

    await (cleanup as () => Promise<void>)();
  });
});
