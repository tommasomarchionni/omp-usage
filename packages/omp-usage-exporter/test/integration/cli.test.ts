/**
 * End-to-end tests against the built CLI (dist/cli.js): real processes, real
 * HTTP, real SQLite, real signals. Run with `npm run test:integration` after
 * `npm run build`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { line, makeEvent, tempDir } from '../helpers.js';

const CLI = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)));

interface Running {
  proc: ChildProcess;
  base: string;
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  let found = false;
  for (const l of text.split('\n')) {
    if (!l.startsWith(name + '{') && !l.startsWith(name + ' ')) continue;
    if (!Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`))) continue;
    total += Number(l.split(' ').pop());
    found = true;
  }
  return found ? total : Number.NaN;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000
): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out${lastErr ? `: ${String(lastErr)}` : ''}`);
}

describe('omp-usage-exporter CLI (integration)', () => {
  let dir: ReturnType<typeof tempDir>;
  let eventsDir: string;
  let dbPath: string;
  const running: Running[] = [];

  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`Build first: ${CLI} not found (npm run build)`);
  });

  beforeEach(() => {
    dir = tempDir('omp-usage-it-');
    eventsDir = join(dir.path, 'events');
    dbPath = join(dir.path, 'state', 'exporter.db');
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(async () => {
    for (const r of running.splice(0)) {
      if (r.proc.exitCode === null && r.proc.signalCode === null) {
        r.proc.kill('SIGKILL');
        await r.exit;
      }
    }
    dir.cleanup();
  });

  const args = (extra: string[] = []) => [
    CLI,
    '--events-dir',
    eventsDir,
    '--db-path',
    dbPath,
    '--listen',
    '127.0.0.1:0',
    '--poll-interval-ms',
    '200',
    '--log-level',
    'debug',
    ...extra,
  ];

  async function start(extra: string[] = []): Promise<Running> {
    const proc = spawn(process.execPath, args(extra), { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res =>
      proc.on('exit', (code, signal) => res({ code, signal }))
    );
    const r: Running = { proc, base: '', stderr: () => err, exit };
    running.push(r);
    const url = await waitFor(() => /metrics="(http:\/\/[^"]+)\/metrics"/.exec(err)?.[1]);
    r.base = url;
    return r;
  }

  const scrape = async (r: Running) => (await fetch(`${r.base}/metrics`)).text();
  const runSync = (extra: string[]) =>
    spawnSync(process.execPath, args(extra), { encoding: 'utf8' });

  it('imports continuously while running and reports health', async () => {
    const file = join(eventsDir, 'run-1.jsonl');
    writeFileSync(file, line(makeEvent()));
    const r = await start();

    await waitFor(
      async () =>
        metricValue(await scrape(r), 'omp_llm_tokens_total', { direction: 'input' }) === 11351
    );
    appendFileSync(file, line(makeEvent()));
    writeFileSync(
      join(eventsDir, 'run-2.jsonl'),
      line(makeEvent({ provider: 'llama.cpp', model: 'qwen3.6-35b-a3b' }))
    );

    const text = await waitFor(async () => {
      const t = await scrape(r);
      return metricValue(t, 'omp_llm_tokens_total', { direction: 'input' }) === 3 * 11351
        ? t
        : undefined;
    });
    expect(
      metricValue(text, 'omp_llm_tokens_total', { model: 'qwen3.6-35b-a3b', direction: 'input' })
    ).toBe(11351);
    expect(metricValue(text, 'omp_usage_events_imported_total')).toBe(3);
    expect(metricValue(text, 'omp_usage_last_import_success')).toBe(1);

    const health = await fetch(`${r.base}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe('ok');
  });

  it('shuts down gracefully on SIGTERM and does not double count after restart', async () => {
    const lines = Array.from({ length: 50 }, () => line(makeEvent()));
    writeFileSync(join(eventsDir, 'a.jsonl'), lines.join(''));
    let r = await start();
    await waitFor(
      async () => metricValue(await scrape(r), 'omp_usage_events_imported_total') === 50
    );

    r.proc.kill('SIGTERM');
    expect(await r.exit).toEqual({ code: 0, signal: null });
    expect(r.stderr()).toContain('shutdown complete');

    r = await start();
    const text = await scrape(r);
    expect(metricValue(text, 'omp_usage_events_imported_total')).toBe(50);
    expect(metricValue(text, 'omp_llm_tokens_total', { direction: 'input' })).toBe(50 * 11351);
  });

  it('stays consistent when SIGTERM or SIGKILL arrive during a large import', async () => {
    const N = 20_000;
    writeFileSync(
      join(eventsDir, 'big.jsonl'),
      Array.from({ length: N }, () => line(makeEvent())).join('')
    );

    let r = await start();
    r.proc.kill('SIGTERM');
    const exited = await r.exit;
    expect(exited.code).toBe(0);

    r = await start();
    r.proc.kill('SIGKILL');
    await r.exit;

    r = await start();
    const text = await waitFor(async () => {
      const t = await scrape(r);
      return metricValue(t, 'omp_usage_events_imported_total') === N ? t : undefined;
    }, 60_000);
    expect(metricValue(text, 'omp_llm_tokens_total', { direction: 'input' })).toBe(N * 11351);
    expect(metricValue(text, 'omp_llm_requests_total', { status: 'success' })).toBe(N);
  });

  it('refuses to start a second exporter on the same database', async () => {
    await start();
    const second = runSync(['--import-once']);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/locked by another process/);
  });

  it('supports repeated --import-once runs (regression: second start crashed)', () => {
    writeFileSync(join(eventsDir, 'a.jsonl'), line(makeEvent()));
    expect(runSync(['--import-once']).status).toBe(0);
    appendFileSync(join(eventsDir, 'a.jsonl'), line(makeEvent()));
    const second = runSync(['--import-once']);
    expect(second.status).toBe(0);
    expect(second.stderr).toMatch(/import complete imported=1 duplicates=0/);
  });

  it('writes an online backup while the exporter is running', async () => {
    writeFileSync(join(eventsDir, 'a.jsonl'), line(makeEvent()));
    const r = await start();
    await waitFor(
      async () => metricValue(await scrape(r), 'omp_usage_events_imported_total') === 1
    );
    const out = join(dir.path, 'backup.db');
    const b = runSync(['--backup', out]);
    expect(b.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('exits with code 2 on invalid configuration', () => {
    const r = spawnSync(process.execPath, [CLI, '--listen', 'nope'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Configuration error/);
    const env = spawnSync(process.execPath, [CLI, '--config-check'], {
      encoding: 'utf8',
      env: { ...process.env, OMP_USAGE_MAX_LINE_LENGTH: 'abc' },
    });
    expect(env.status).toBe(2);
  });

  it('prints version and help', () => {
    const v = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('--poll-interval-ms');
  });
});
