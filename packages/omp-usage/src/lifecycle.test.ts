import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializePlugin } from './lifecycle.js';
import type { ExtensionCommandContext, OmpApi } from './types.js';

type Handler = (...args: unknown[]) => unknown;

function fakeOmp() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(
      name: string,
      opts: { handler: (a: string, c: ExtensionCommandContext) => unknown }
    ) {
      commands.set(name, opts.handler);
    },
  } as unknown as OmpApi;
  const emit = async (event: string, payload?: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(payload);
  };
  const run = async (args: string) => {
    const out: Array<[string, string | undefined]> = [];
    await commands.get('omp-usage')!(args, { ui: { notify: (m, t) => out.push([m, t]) } });
    return out;
  };
  return { api, handlers, emit, run };
}

const msg = (over: Record<string, unknown> = {}) => ({
  role: 'assistant',
  provider: 'openrouter',
  model: 'openrouter/free',
  stopReason: 'stop',
  timestamp: Date.now(),
  usage: { input: 10, output: 2 },
  ...over,
});

describe('initializePlugin', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'omp-usage-life-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const files = () => readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const events = () =>
    files().flatMap(f =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as Record<string, unknown>)
    );

  it('registers message_end and session_shutdown (not the non-existent "shutdown")', () => {
    const omp = fakeOmp();
    initializePlugin(omp.api, { eventsDir: dir });
    expect([...omp.handlers.keys()].sort()).toEqual(['message_end', 'session_shutdown']);
  });

  it('records assistant messages and flushes on session_shutdown', async () => {
    const omp = fakeOmp();
    initializePlugin(omp.api, { eventsDir: dir });
    await omp.emit('message_end', { message: msg() });
    await omp.emit('message_end', { message: { role: 'user', content: 'hi' } });
    await omp.emit('session_shutdown');
    const ev = events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/free',
      schemaVersion: 1,
    });
  });

  it('never throws into OMP, whatever the payload', async () => {
    const omp = fakeOmp();
    initializePlugin(omp.api, { eventsDir: dir });
    for (const p of [
      undefined,
      null,
      1,
      { message: null },
      {
        get message() {
          throw new Error('x');
        },
      },
    ]) {
      await expect(omp.emit('message_end', p)).resolves.toBeUndefined();
    }
  });

  it('does not record the same message twice (replayed history)', async () => {
    const omp = fakeOmp();
    initializePlugin(omp.api, { eventsDir: dir });
    const m = msg({ timestamp: 123 });
    await omp.emit('message_end', { message: m });
    await omp.emit('message_end', { message: { ...m } });
    await omp.emit('message_end', { message: msg({ timestamp: 124 }) });
    await omp.emit('session_shutdown');
    expect(events()).toHaveLength(2);
    const [[status]] = await omp.run('status');
    expect(status).toContain('duplicatesSkipped=1');
  });

  it('uses one file per session binding (subagents get their own file)', async () => {
    const parent = fakeOmp();
    const child = fakeOmp();
    initializePlugin(parent.api, { eventsDir: dir });
    initializePlugin(child.api, { eventsDir: dir });
    await parent.emit('message_end', { message: msg({ timestamp: 1 }) });
    await child.emit('message_end', { message: msg({ timestamp: 2 }) });
    await parent.emit('session_shutdown');
    await child.emit('session_shutdown');
    expect(files()).toHaveLength(2);
    const runs = new Set(events().map(e => e['sessionRunId']));
    expect(runs.size).toBe(2);
  });

  it('status reports drops and warns', async () => {
    const omp = fakeOmp();
    initializePlugin(omp.api, { eventsDir: dir, maxQueueSize: 1 });
    await Promise.all([
      omp.emit('message_end', { message: msg({ timestamp: 1 }) }),
      omp.emit('message_end', { message: msg({ timestamp: 2 }) }),
    ]);
    const [[text, level]] = await omp.run('status');
    expect(text).toMatch(/dropped=1/);
    expect(level).toBe('warning');
  });

  it('retention commands: off by default, warn when enabled', async () => {
    const omp = fakeOmp();
    initializePlugin(omp.api, { eventsDir: dir });
    expect((await omp.run('retention'))[0]![0]).toBe('Current retention: off');
    expect((await omp.run('prune'))[0]![0]).toMatch(/Retention is off/);
    const [[text, level]] = await omp.run('retention 30');
    expect(level).toBe('warning');
    expect(text).toMatch(/--retention-days/);
    expect((await omp.run('retention abc'))[0]![1]).toBe('error');
    expect((await omp.run('retention off'))[0]![0]).toBe('Retention disabled.');
    expect((await omp.run('bogus'))[0]![1]).toBe('error');
  });
});
