import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExporterDatabase } from './database.js';
import { createExporterState, createMetrics } from './metrics.js';
import {
  autoOpenRouterId,
  OpenRouterCatalog,
  parseCatalog,
  parsePricingFile,
  perTokenToPerMillion,
  PricingConfigError,
  PricingService,
  resolvePricing,
  type PriceTable,
} from './pricing.js';
import type { FileCursor, UsageEvent } from './protocol.js';
import { makeEvent, tempDir } from '../test/helpers.js';
import type { Logger } from './logger.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

/** Trimmed copy of the real OpenRouter /api/v1/models format. */
const CATALOG = {
  data: [
    {
      id: 'qwen/qwen3.6-35b-a3b',
      canonical_slug: 'qwen/qwen3.6-35b-a3b-20260415',
      hugging_face_id: 'Qwen/Qwen3.6-35B-A3B',
      pricing: { prompt: '0.00000015', completion: '0.000001', input_cache_read: '0.00000005' },
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
        input_cache_write: '0.00000375',
        web_search: '0.01',
        overrides: [{ min_prompt_tokens: 200000, prompt: '0.000006' }],
      },
    },
    { id: 'vendor/model', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'vendor/model:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'broken' },
    { pricing: { prompt: '1' } },
  ],
};

const catalogOf = (entries: Record<string, PriceTable>) => {
  const m = new Map(Object.entries(entries));
  return { get: (id: string) => m.get(id), has: (id: string) => m.has(id) };
};

describe('perTokenToPerMillion', () => {
  it('converts USD per token strings to USD per 1M tokens without float noise', () => {
    expect(perTokenToPerMillion('0.00000015')).toBe(0.15);
    expect(perTokenToPerMillion('0.000003')).toBe(3);
    expect(perTokenToPerMillion('0.0000000025')).toBe(0.0025);
    expect(perTokenToPerMillion('0')).toBe(0);
  });
  it('treats negative (variable-price routers), non-numeric and missing values as unknown', () => {
    expect(perTokenToPerMillion('-1')).toBeUndefined();
    expect(perTokenToPerMillion('abc')).toBeUndefined();
    expect(perTokenToPerMillion(undefined)).toBeUndefined();
    expect(perTokenToPerMillion({})).toBeUndefined();
  });
});

describe('parseCatalog', () => {
  it('maps prompt/completion/input_cache_read/input_cache_write and skips invalid entries', () => {
    const c = parseCatalog(CATALOG);
    expect(c.get('qwen/qwen3.6-35b-a3b')).toEqual({ input: 0.15, output: 1, cache_read: 0.05 });
    expect(c.get('anthropic/claude-sonnet-4.5')).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    });
    expect(c.get('openrouter/free')).toEqual({ input: 0, output: 0 });
    expect(c.has('openrouter/auto')).toBe(false);
    expect(c.has('broken')).toBe(false);
  });
  it('rejects a response without data', () => {
    expect(() => parseCatalog({})).toThrow(/data/);
  });
});

describe('parsePricingFile', () => {
  it('accepts a complete file', () => {
    const f = parsePricingFile(
      JSON.stringify({
        openrouter: { enabled: true, refreshHours: 12 },
        models: [
          { provider: 'llama.cpp', model: 'qwen3.6-35b-a3b', openrouter: 'qwen/qwen3.6-35b-a3b' },
          { provider: 'local', model: 'x', prices: { input: 0.1, output: 0.4 } },
        ],
        references: ['anthropic/claude-sonnet-4.5', { name: 'my-cloud', prices: { input: 1 } }],
      })
    );
    expect(f.models).toHaveLength(2);
  });
  it.each([
    ['invalid JSON', '{'],
    ['unknown key (typo)', '{"model": []}'],
    ['negative price', '{"models":[{"provider":"p","model":"m","prices":{"input":-1}}]}'],
    ['entry without price or mapping', '{"models":[{"provider":"p","model":"m"}]}'],
    ['unknown price key', '{"models":[{"provider":"p","model":"m","prices":{"prompt":1}}]}'],
    ['plain http catalog URL', '{"openrouter":{"enabled":true,"url":"http://example.com/m"}}'],
  ])('rejects %s', (_name, text) => {
    expect(() => parsePricingFile(text)).toThrow(PricingConfigError);
  });
  it('allows http only for a loopback catalog URL', () => {
    expect(() =>
      parsePricingFile('{"openrouter":{"enabled":true,"url":"http://127.0.0.1:1/m"}}')
    ).not.toThrow();
  });
});

describe('autoOpenRouterId', () => {
  const c = catalogOf({ 'vendor/model': {}, 'vendor/model:free': {}, 'openrouter/free': {} });
  it('prices a :free variant as its paid equivalent', () => {
    expect(autoOpenRouterId('vendor/model:free', c)).toBe('vendor/model');
  });
  it('never resolves a router alias to another model', () => {
    expect(autoOpenRouterId('openrouter/free', c)).toBe('openrouter/free');
    expect(autoOpenRouterId('unknown/model', c)).toBeNull();
  });
});

describe('resolvePricing', () => {
  const catalog = catalogOf(Object.fromEntries(parseCatalog(CATALOG)));

  it('merges explicit prices over catalog prices per direction', () => {
    const snap = resolvePricing(
      parsePricingFile(
        JSON.stringify({
          models: [
            {
              provider: 'llama.cpp',
              model: 'qwen3.6-35b-a3b',
              openrouter: 'qwen/qwen3.6-35b-a3b',
              prices: { cacheWrite: 0.2, input: 0.1 },
            },
          ],
        })
      ),
      catalog
    );
    const by = Object.fromEntries(snap.prices.map(p => [p.direction, [p.usdPerMillion, p.source]]));
    expect(by).toEqual({
      input: [0.1, 'file'],
      output: [1, 'openrouter'],
      cache_read: [0.05, 'openrouter'],
      cache_write: [0.2, 'file'],
    });
    expect(snap.unresolved).toEqual([]);
  });

  it('reports unknown catalog ids and works offline with explicit prices only', () => {
    const file = parsePricingFile(
      JSON.stringify({
        models: [
          { provider: 'a', model: 'b', openrouter: 'does/not-exist' },
          { provider: 'local', model: 'm', prices: { input: 0, output: 0.5 } },
        ],
        references: ['nope/nope'],
      })
    );
    const snap = resolvePricing(file, null);
    expect(snap.prices.map(p => `${p.provider}/${p.model}:${p.direction}`)).toEqual([
      'local/m:input',
      'local/m:output',
    ]);
    expect(snap.unresolved).toEqual([
      { kind: 'model', name: 'a/b', openrouter: 'does/not-exist' },
      { kind: 'reference', name: 'nope/nope', openrouter: 'nope/nope' },
    ]);
  });

  it('auto-maps only provider "openrouter" pairs, and only when enabled', () => {
    const seen = [
      { provider: 'openrouter', model: 'vendor/model:free' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'llama.cpp', model: 'vendor/model' }, // never guessed
    ];
    const on = parsePricingFile('{"openrouter":{"enabled":true}}');
    const snap = resolvePricing(on, catalog, seen);
    expect(snap.mappings).toEqual([
      {
        provider: 'openrouter',
        model: 'vendor/model:free',
        openrouterId: 'vendor/model',
        mapping: 'auto',
        directions: ['input', 'output'],
      },
      {
        provider: 'openrouter',
        model: 'openrouter/free',
        openrouterId: 'openrouter/free',
        mapping: 'auto',
        directions: ['input', 'output'],
      },
    ]);
    expect(
      resolvePricing(
        parsePricingFile('{"openrouter":{"enabled":true,"autoMap":false}}'),
        catalog,
        seen
      ).mappings
    ).toEqual([]);
    expect(resolvePricing(parsePricingFile('{}'), catalog, seen).mappings).toEqual([]);
  });

  it('resolves reference models from the catalog or explicit prices', () => {
    const snap = resolvePricing(
      parsePricingFile(
        JSON.stringify({
          references: [
            'anthropic/claude-sonnet-4.5',
            { name: 'custom', prices: { input: 2, output: 8 } },
          ],
        })
      ),
      catalog
    );
    expect(snap.references.filter(r => r.name === 'anthropic/claude-sonnet-4.5')).toHaveLength(4);
    expect(snap.references.find(r => r.name === 'custom' && r.direction === 'output')).toEqual({
      name: 'custom',
      direction: 'output',
      usdPerMillion: 8,
      source: 'file',
    });
  });
});

describe('OpenRouterCatalog', () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.cleanup());

  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('downloads, caches to disk (0600) and reloads the cache without network', async () => {
    const cacheFile = join(dir.path, 'state', 'catalog.json');
    const fetchMock = vi.fn(async () => response(CATALOG));
    const c = new OpenRouterCatalog({ cacheFile, refreshMs: 3_600_000, fetch: fetchMock });
    await c.refreshIfStale();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.get('qwen/qwen3.6-35b-a3b')?.input).toBe(0.15);
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    // Only prices are cached, nothing else from the response.
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('hugging_face_id');

    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    const c2 = new OpenRouterCatalog({ cacheFile, refreshMs: 3_600_000, fetch: offline });
    expect(c2.loadCache()).toBe(true);
    await c2.refreshIfStale(); // fresh cache: no request
    expect(offline).not.toHaveBeenCalled();
    expect(c2.size).toBe(c.size);
  });

  it('keeps previous prices on failure and backs off instead of retrying every tick', async () => {
    let now = 1_000_000_000_000;
    let fail = false;
    const fetchMock = vi.fn(async () => (fail ? response({ error: 'x' }, 503) : response(CATALOG)));
    const c = new OpenRouterCatalog({
      cacheFile: join(dir.path, 'c.json'),
      refreshMs: 1000,
      fetch: fetchMock,
      now: () => now,
    });
    await c.refreshIfStale();
    fail = true;
    now += 2000;
    await c.refreshIfStale();
    expect(c.refreshErrors).toBe(1);
    expect(c.lastError).toMatch(/503/);
    expect(c.get('vendor/model')).toBeDefined();
    now += 1000;
    await c.refreshIfStale(); // within back-off
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 10 * 60_000;
    fail = false;
    await c.refreshIfStale();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(c.lastError).toBeNull();
  });

  it('rejects an empty catalog and does not replace good prices with it', async () => {
    let body: unknown = CATALOG;
    let now = 0;
    const c = new OpenRouterCatalog({
      cacheFile: join(dir.path, 'c.json'),
      refreshMs: 1,
      fetch: async () => response(body),
      now: () => now,
    });
    await c.refresh();
    body = { data: [] };
    now = 10;
    await c.refresh();
    expect(c.size).toBeGreaterThan(0);
    expect(c.refreshErrors).toBe(1);
  });

  it('shares a single request between concurrent refreshes', async () => {
    const fetchMock = vi.fn(async () => response(CATALOG));
    const c = new OpenRouterCatalog({
      cacheFile: join(dir.path, 'c.json'),
      refreshMs: 1,
      fetch: fetchMock,
    });
    await Promise.all([c.refresh(), c.refresh(), c.refresh()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a cache written for another URL', async () => {
    const cacheFile = join(dir.path, 'c.json');
    const c = new OpenRouterCatalog({
      cacheFile,
      refreshMs: 1,
      fetch: async () => response(CATALOG),
    });
    await c.refresh();
    const other = new OpenRouterCatalog({ cacheFile, refreshMs: 1, url: 'https://example.com/m' });
    expect(other.loadCache()).toBe(false);
  });
});

describe('PricingService', () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.cleanup());

  it('fails fast on an invalid file at startup', () => {
    const file = join(dir.path, 'p.json');
    writeFileSync(file, '{"models":[{"provider":"p"}]}');
    expect(
      () => new PricingService({ file, logger: silent, defaultCacheFile: join(dir.path, 'c') })
    ).toThrow(PricingConfigError);
    expect(
      () =>
        new PricingService({
          file: join(dir.path, 'missing.json'),
          logger: silent,
          defaultCacheFile: join(dir.path, 'c'),
        })
    ).toThrow(PricingConfigError);
  });

  it('reloads the file when it changes and keeps the previous one when invalid', () => {
    const file = join(dir.path, 'p.json');
    writeFileSync(file, '{"models":[{"provider":"p","model":"m","prices":{"input":1}}]}');
    const s = new PricingService({ file, logger: silent, defaultCacheFile: join(dir.path, 'c') });
    expect(s.snapshot().prices[0]?.usdPerMillion).toBe(1);

    writeFileSync(file, '{"models":[{"provider":"p","model":"m","prices":{"input":2}}]}');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(s.reloadIfChanged()).toBe(true);
    expect(s.snapshot().prices[0]?.usdPerMillion).toBe(2);

    writeFileSync(file, '{ broken');
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(s.reloadIfChanged()).toBe(false);
    expect(s.reloadErrors).toBe(1);
    expect(s.snapshot().prices[0]?.usdPerMillion).toBe(2);
  });

  it('makes no network request when the catalog is disabled', async () => {
    const file = join(dir.path, 'p.json');
    writeFileSync(file, '{"models":[{"provider":"p","model":"m","openrouter":"vendor/model"}]}');
    const fetchMock = vi.fn();
    const s = new PricingService({
      file,
      logger: silent,
      defaultCacheFile: join(dir.path, 'c'),
      fetch: fetchMock as unknown as typeof fetch,
    });
    await s.tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.openrouter).toBeNull();
    expect(s.snapshot().unresolved).toHaveLength(1);
    expect(existsSync(join(dir.path, 'c'))).toBe(false);
  });
});

describe('price metrics', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: ExporterDatabase;
  beforeEach(() => {
    dir = tempDir();
    db = new ExporterDatabase(join(dir.path, 'db.sqlite'));
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('exports price gauges with the same provider/model labels as the token counters', async () => {
    const file = join(dir.path, 'p.json');
    writeFileSync(
      file,
      JSON.stringify({
        openrouter: { enabled: true, cacheFile: join(dir.path, 'c.json') },
        models: [
          { provider: 'llama.cpp', model: 'qwen3.6-35b-a3b', openrouter: 'qwen/qwen3.6-35b-a3b' },
          { provider: 'x', model: 'y', openrouter: 'unknown/id' },
        ],
        references: ['anthropic/claude-sonnet-4.5'],
      })
    );
    const pricing = new PricingService({
      file,
      logger: silent,
      defaultCacheFile: join(dir.path, 'unused'),
      fetch: async () => new Response(JSON.stringify(CATALOG)),
    });
    await pricing.tick();

    const cursor: FileCursor = {
      filePath: '/f',
      offset: 1,
      fileSize: 1,
      inode: 1,
      device: 1,
      mtimeMs: 0,
    };
    db.applyBatch({
      events: [
        makeEvent({ provider: 'llama.cpp', model: 'qwen3.6-35b-a3b' }),
        makeEvent({ provider: 'openrouter', model: 'vendor/model:free' }),
      ] as UsageEvent[],
      invalid: {},
      cursor,
    });
    const { registry } = createMetrics(db, createExporterState(), {
      maxLabelCardinality: 10,
      version: 't',
      collectProcessMetrics: false,
      pricing,
    });
    const text = await registry.metrics();
    expect(text).toContain(
      'omp_llm_price_usd_per_million_tokens{provider="llama.cpp",model="qwen3.6-35b-a3b",direction="input",source="openrouter",app="omp-usage-exporter"} 0.15'
    );
    expect(text).toContain(
      'omp_llm_price_usd_per_million_tokens{provider="openrouter",model="vendor/model:free",direction="output",source="openrouter",app="omp-usage-exporter"} 2'
    );
    expect(text).toContain(
      'omp_llm_reference_price_usd_per_million_tokens{reference_model="anthropic/claude-sonnet-4.5",direction="cache_write",source="openrouter",app="omp-usage-exporter"} 3.75'
    );
    expect(text).toContain(
      'omp_llm_pricing_info{provider="openrouter",model="vendor/model:free",openrouter_id="vendor/model",mapping="auto",app="omp-usage-exporter"} 2'
    );
    expect(text).toContain(
      'omp_usage_pricing_unresolved{kind="model",name="x/y",app="omp-usage-exporter"} 1'
    );
    expect(text).toMatch(/omp_usage_pricing_catalog_models\{[^}]*\} 5\n/);
    // Reported cost is untouched by prices.
    expect(text).toMatch(/omp_llm_reported_cost_usd_total\{provider="llama.cpp"[^}]*\} 0\n/);
  });

  it('exports no price metrics without a pricing file', async () => {
    const { registry } = createMetrics(db, createExporterState(), {
      maxLabelCardinality: 10,
      version: 't',
      collectProcessMetrics: false,
    });
    expect(await registry.metrics()).not.toContain('price');
  });
});
