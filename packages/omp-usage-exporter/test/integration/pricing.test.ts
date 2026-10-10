/**
 * Pricing against the built CLI with a local stand-in for the OpenRouter
 * catalog (same response format as https://openrouter.ai/api/v1/models).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { line, makeEvent, tempDir } from '../helpers.js';

const CLI = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)));

const CATALOG = {
  data: [
    {
      id: 'qwen/qwen3.6-35b-a3b',
      pricing: { prompt: '0.00000015', completion: '0.000001', input_cache_read: '0.00000005' },
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
      },
    },
    { id: 'vendor/model', pricing: { prompt: '0.000001', completion: '0.000002' } },
  ],
};

describe('pricing (integration)', () => {
  let server: Server;
  let catalogUrl: string;
  let requests = 0;
  let requestHeaders: Record<string, unknown>[] = [];
  let dir: ReturnType<typeof tempDir>;
  let eventsDir: string;
  let dbPath: string;
  let pricingFile: string;

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error(`Build first: ${CLI}`);
    server = createServer((req, res) => {
      requests++;
      requestHeaders.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CATALOG));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    catalogUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/models`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  beforeEach(() => {
    requests = 0;
    requestHeaders = [];
    dir = tempDir('omp-usage-pricing-it-');
    eventsDir = join(dir.path, 'events');
    dbPath = join(dir.path, 'exporter.db');
    pricingFile = join(dir.path, 'pricing.json');
    mkdirSync(eventsDir);
    writeFileSync(
      pricingFile,
      JSON.stringify({
        openrouter: { enabled: true, url: catalogUrl, cacheFile: join(dir.path, 'catalog.json') },
        models: [
          { provider: 'llama.cpp', model: 'qwen3.6-35b-a3b', openrouter: 'qwen/qwen3.6-35b-a3b' },
          { provider: 'local', model: 'tiny', prices: { input: 0.05, output: 0.1 } },
        ],
        references: ['anthropic/claude-sonnet-4.5'],
      })
    );
    writeFileSync(
      join(eventsDir, 's.jsonl'),
      line(makeEvent({ provider: 'llama.cpp', model: 'qwen3.6-35b-a3b' })) +
        line(makeEvent({ provider: 'openrouter', model: 'vendor/model:free' }))
    );
  });
  afterEach(() => dir.cleanup());

  // Async on purpose: spawnSync would block the in-process catalog server.
  const cli = (extra: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
      execFile(
        process.execPath,
        [
          CLI,
          '--events-dir',
          eventsDir,
          '--db-path',
          dbPath,
          '--pricing-file',
          pricingFile,
          ...extra,
        ],
        { encoding: 'utf8' },
        (err, stdout, stderr) =>
          done({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
      );
    });

  it('--print-prices resolves file, catalog and database pairs, then uses the disk cache', async () => {
    expect((await cli(['--import-once'])).status).toBe(0);
    const r = await cli(['--print-prices']);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      catalog: { models: number };
      prices: Array<{ provider: string; model: string; direction: string; usdPerMillion: number }>;
      mappings: Array<{ model: string; openrouterId: string | null; mapping: string }>;
      references: unknown[];
      unpricedPairs: unknown[];
    };
    expect(out.catalog.models).toBe(3);
    expect(
      out.prices.find(p => p.model === 'qwen3.6-35b-a3b' && p.direction === 'input')?.usdPerMillion
    ).toBe(0.15);
    expect(out.mappings).toContainEqual(
      expect.objectContaining({
        model: 'vendor/model:free',
        openrouterId: 'vendor/model',
        mapping: 'auto',
      })
    );
    expect(out.references).toHaveLength(4);
    expect(out.unpricedPairs).toEqual([]);
    expect(requests).toBe(1);
    // The request carries no usage data or credentials.
    expect(requestHeaders[0]?.['authorization']).toBeUndefined();
    expect(String(requestHeaders[0]?.['user-agent'])).toMatch(/^omp-usage-exporter\//);

    // Fresh cache: no second download.
    expect((await cli(['--print-prices'])).status).toBe(0);
    expect(requests).toBe(1);
  });

  it('exits with status 3 when a configured model cannot be priced', async () => {
    writeFileSync(
      pricingFile,
      JSON.stringify({ models: [{ provider: 'a', model: 'b', openrouter: 'does/not-exist' }] })
    );
    const r = await cli(['--print-prices']);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).unresolved).toHaveLength(1);
  });

  it('refuses to start with an invalid pricing file (exit 2, database untouched)', async () => {
    writeFileSync(pricingFile, '{"models":[{"provider":"p","model":"m","prices":{"input":-1}}]}');
    const r = await cli(['--import-once']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Configuration error: .*pricing\.json/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('serves price gauges next to the token counters', async () => {
    const proc = spawn(
      process.execPath,
      [
        CLI,
        '--events-dir',
        eventsDir,
        '--db-path',
        dbPath,
        '--pricing-file',
        pricingFile,
        '--listen',
        '127.0.0.1:0',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    const exit = new Promise(r => proc.on('exit', r));
    try {
      let url: string | undefined;
      const start = Date.now();
      while (!(url = /metrics="([^"]+)"/.exec(err)?.[1])) {
        if (Date.now() - start > 10_000) throw new Error(err);
        await new Promise(r => setTimeout(r, 25));
      }
      let text = '';
      while (Date.now() - start < 10_000) {
        text = await (await fetch(url)).text();
        if (text.includes('reference_model=') && text.includes('vendor/model:free')) break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(text).toMatch(
        /omp_llm_price_usd_per_million_tokens\{provider="local",model="tiny",direction="output",source="file"[^}]*\} 0\.1\n/
      );
      expect(text).toMatch(
        /omp_llm_price_usd_per_million_tokens\{provider="openrouter",model="vendor\/model:free",direction="input",source="openrouter"[^}]*\} 1\n/
      );
      expect(text).toMatch(
        /omp_llm_reference_price_usd_per_million_tokens\{reference_model="anthropic\/claude-sonnet-4\.5",direction="output"[^}]*\} 15\n/
      );
      expect(text).toMatch(/omp_usage_pricing_catalog_updated_timestamp_seconds\{[^}]*\} \d+/);
    } finally {
      proc.kill('SIGTERM');
      await exit;
    }
  });
});
