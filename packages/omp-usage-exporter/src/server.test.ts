import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import http from 'node:http';
import { ExporterDatabase } from './database.js';
import { createExporterState, createMetrics, type ExporterState } from './metrics.js';
import { ExporterServer } from './server.js';
import { tempDir } from '../test/helpers.js';

describe('ExporterServer', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: ExporterDatabase;
  let state: ExporterState;
  let server: ExporterServer;
  let base: string;

  beforeEach(async () => {
    dir = tempDir();
    db = new ExporterDatabase(join(dir.path, 'db.sqlite'));
    state = createExporterState();
    const { registry } = createMetrics(db, state, {
      maxLabelCardinality: 10,
      version: 't',
      collectProcessMetrics: false,
    });
    server = new ExporterServer(registry, db, state, {
      listen: '127.0.0.1:0',
      staleAfterMs: 60_000,
    });
    await server.start();
    base = `http://${server.address()}`;
  });
  afterEach(async () => {
    await server.stop();
    db.close();
    dir.cleanup();
  });

  it('serves /metrics in Prometheus text format', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('omp_usage_build_info');
  });

  it('supports query strings and HEAD', async () => {
    expect((await fetch(`${base}/metrics?x=1`)).status).toBe(200);
    const head = await fetch(`${base}/metrics`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('rejects other methods and paths', async () => {
    const post = await fetch(`${base}/metrics`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    for (const p of ['/', '/events', '/../exporter.db', '/metrics/x']) {
      expect((await fetch(`${base}${p}`)).status).toBe(404);
    }
  });

  it('reports ok, degraded and unavailable health states', async () => {
    state.lastSuccessMs = Date.now();
    state.lastAttemptMs = Date.now();
    let res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; lastImport: string };
    expect(body.status).toBe('ok');
    expect(typeof body.lastImport).toBe('string'); // regression: was a serialized promise

    state.lastCycleOk = false;
    state.lastError = 'boom';
    res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe('degraded');

    state.lastCycleOk = true;
    state.lastSuccessMs = Date.now() - 120_000;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);

    expect(server.health().body.database).toBe(true);
    db.close();
    expect(server.health()).toMatchObject({
      code: 503,
      body: { status: 'unavailable', database: false },
    });
  });

  it('stops promptly even with an idle keep-alive connection open', async () => {
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      http
        .get(`${base}/metrics`, { agent }, res => {
          res.resume();
          res.on('end', () => resolve());
        })
        .on('error', reject);
    });
    const t = Date.now();
    await server.stop(2_000);
    expect(Date.now() - t).toBeLessThan(1_000);
    agent.destroy();
  });
});
