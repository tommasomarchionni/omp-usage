/**
 * End-to-end: the built plugin (packages/omp-usage/dist) writes events through
 * a fake OMP ExtensionAPI, the built exporter (dist/cli.js) imports them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from '../helpers.js';

const CLI = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)));
const PLUGIN = resolve(fileURLToPath(new URL('../../../omp-usage/dist/index.js', import.meta.url)));

type Handler = (payload?: unknown) => unknown;

function fakeOmp() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: {
      on(event: string, h: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
    },
    async emit(event: string, payload?: unknown) {
      for (const h of handlers.get(event) ?? []) await h(payload);
    },
  };
}

const assistant = (i: number, over: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content: [{ type: 'text', text: `secret answer ${i}` }],
  provider: 'openrouter',
  model: 'openrouter/free',
  api: 'openrouter',
  stopReason: 'stop',
  timestamp: 1_760_000_000_000 + i,
  usage: {
    input: 1000,
    output: 100,
    cacheRead: 50,
    cacheWrite: 0,
    totalTokens: 1150,
    reasoningTokens: 10,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  },
  ...over,
});

function metric(text: string, name: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  for (const l of text.split('\n')) {
    if (!l.startsWith(name + '{')) continue;
    if (Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
      sum += Number(l.split(' ').pop());
  }
  return sum;
}

describe('plugin → exporter (e2e)', () => {
  let dir: ReturnType<typeof tempDir>;
  let eventsDir: string;
  let dbPath: string;

  beforeAll(() => {
    for (const f of [CLI, PLUGIN]) if (!existsSync(f)) throw new Error(`Build first: ${f}`);
  });
  beforeEach(() => {
    dir = tempDir('omp-usage-e2e-');
    eventsDir = join(dir.path, 'events');
    dbPath = join(dir.path, 'exporter.db');
    mkdirSync(eventsDir);
  });
  afterEach(() => dir.cleanup());

  const importOnce = () =>
    spawnSync(
      process.execPath,
      [CLI, '--events-dir', eventsDir, '--db-path', dbPath, '--import-once'],
      {
        encoding: 'utf8',
      }
    );

  /** Metrics are only served over HTTP; start, scrape once, stop. */
  async function scrapeOnce(): Promise<string> {
    const { spawn } = await import('node:child_process');
    const proc = spawn(
      process.execPath,
      [
        CLI,
        '--events-dir',
        eventsDir,
        '--db-path',
        dbPath,
        '--listen',
        '127.0.0.1:0',
        '--log-level',
        'info',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    const exit = new Promise(r => proc.on('exit', r));
    try {
      const start = Date.now();
      let url: string | undefined;
      while (!(url = /metrics="([^"]+)"/.exec(err)?.[1])) {
        if (Date.now() - start > 10_000) throw new Error(`exporter did not start: ${err}`);
        await new Promise(r => setTimeout(r, 25));
      }
      // Wait until the first cycle has run.
      for (;;) {
        const h = (await (await fetch(url.replace('/metrics', '/healthz'))).json()) as {
          lastImport: string | null;
        };
        if (h.lastImport) break;
        await new Promise(r => setTimeout(r, 25));
      }
      return await (await fetch(url)).text();
    } finally {
      proc.kill('SIGTERM');
      await exit;
    }
  }

  it('records usage in-process and exports exact totals', async () => {
    const { default: factory } = (await import(pathToFileURL(PLUGIN).href)) as {
      default: (api: unknown, cfg?: unknown) => () => Promise<void>;
    };

    const main = fakeOmp();
    const sub = fakeOmp(); // subagent binding
    factory(main.api, { eventsDir });
    factory(sub.api, { eventsDir });

    for (let i = 0; i < 10; i++) await main.emit('message_end', { message: assistant(i) });
    await main.emit('message_end', { message: assistant(3) }); // replay → skipped
    await main.emit('message_end', { message: { role: 'user', content: 'hi' } });
    await main.emit('message_end', {
      message: assistant(100, {
        stopReason: 'error',
        usage: { input: 0, output: 0, cost: { total: 0 } },
      }),
    });
    await sub.emit('message_end', {
      message: assistant(200, {
        provider: 'llama.cpp',
        model: 'qwen3.6-35b-a3b',
        usage: { input: 500, output: 50 },
      }),
    });
    await main.emit('session_shutdown');
    await sub.emit('session_shutdown');

    expect(readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'))).toHaveLength(2);
    const r = importOnce();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/imported=12 duplicates=0 invalid=0/);

    const text = await scrapeOnce();
    const or = { provider: 'openrouter', model: 'openrouter/free' };
    expect(metric(text, 'omp_llm_tokens_total', { ...or, direction: 'input' })).toBe(10_000);
    expect(metric(text, 'omp_llm_tokens_total', { ...or, direction: 'cache_read' })).toBe(500);
    expect(metric(text, 'omp_llm_reasoning_tokens_total', or)).toBe(100);
    expect(metric(text, 'omp_llm_requests_total', { ...or, status: 'success' })).toBe(10);
    expect(metric(text, 'omp_llm_requests_total', { ...or, status: 'error' })).toBe(1);
    expect(metric(text, 'omp_llm_reported_cost_usd_total', or)).toBeCloseTo(0.03, 10);
    expect(metric(text, 'omp_llm_cost_missing_total', { provider: 'llama.cpp' })).toBe(1);
    expect(
      metric(text, 'omp_llm_tokens_total', { model: 'qwen3.6-35b-a3b', direction: 'input' })
    ).toBe(500);
    expect(text).not.toContain('secret answer');
  });

  it('keeps every event written before OMP is killed with SIGKILL', () => {
    const script = join(dir.path, 'omp.mjs');
    writeFileSync(
      script,
      `
      const { default: factory } = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)});
      const handlers = {};
      factory({ on: (e, h) => (handlers[e] = h) }, { eventsDir: ${JSON.stringify(eventsDir)} });
      for (let i = 0; i < 250; i++) {
        handlers.message_end({ message: { role: 'assistant', provider: 'p', model: 'm', timestamp: i,
          stopReason: 'stop', usage: { input: 1, output: 1 } } });
        await Promise.resolve(); // end of the OMP turn
      }
      process.kill(process.pid, 'SIGKILL'); // no session_shutdown, no exit handlers
      `
    );
    const child = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(child.signal).toBe('SIGKILL');

    const r = importOnce();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/imported=250 duplicates=0 invalid=0/);
  });
});
