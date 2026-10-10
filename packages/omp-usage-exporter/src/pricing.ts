/**
 * Optional price tables used to compute an *equivalent* cost in PromQL
 * (tokens × price). The exporter never multiplies tokens by prices itself and
 * never mixes these values with the cost reported by OMP.
 *
 * Sources, in order of precedence for every direction:
 *   1. explicit prices in the pricing file (USD per 1M tokens)
 *   2. the public OpenRouter model catalog (opt-in, cached on disk)
 *
 * Mapping a (provider, model) pair to a catalog id is explicit. The only
 * automatic mapping is for provider `openrouter`, whose model ids *are*
 * OpenRouter ids; a `:free` variant is priced as its paid equivalent.
 * Router aliases such as `openrouter/free` are never resolved to the model
 * that actually served the request.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { expandPath } from './config.js';
import type { Logger } from './logger.js';

export const DIRECTIONS = ['input', 'output', 'cache_read', 'cache_write'] as const;
export type Direction = (typeof DIRECTIONS)[number];
/** USD per 1M tokens, by direction. A missing direction means "unknown". */
export type PriceTable = Partial<Record<Direction, number>>;
export type PriceSource = 'file' | 'openrouter';

export const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

// ------------------------------------------------------------- schema --

const usdPerMillion = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000)
  .describe('USD per 1M tokens');

const PricesSchema = z
  .object({
    input: usdPerMillion,
    output: usdPerMillion,
    cacheRead: usdPerMillion,
    cacheWrite: usdPerMillion,
  })
  .partial()
  .strict();

const ModelEntrySchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(128)
      .describe('Provider exactly as in the provider label of omp_llm_tokens_total'),
    model: z
      .string()
      .min(1)
      .max(256)
      .describe('Model exactly as in the model label of omp_llm_tokens_total'),
    /** OpenRouter model id to take prices from, e.g. `qwen/qwen3.6-35b-a3b`. */
    openrouter: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('OpenRouter model id to take prices from, e.g. qwen/qwen3.6-35b-a3b'),
    /** Explicit prices, USD per 1M tokens. Override the catalog per direction. */
    prices: PricesSchema.optional().describe(
      'Explicit prices in USD per 1M tokens; override the catalog per direction'
    ),
  })
  .strict()
  .refine(m => m.openrouter !== undefined || m.prices !== undefined, {
    message: 'each model needs "openrouter" and/or "prices"',
  });

const ReferenceSchema = z.union([
  z.string().min(1).max(256),
  z
    .object({
      name: z.string().min(1).max(128),
      openrouter: z.string().min(1).max(256).optional(),
      prices: PricesSchema.optional(),
    })
    .strict()
    .refine(r => r.openrouter !== undefined || r.prices !== undefined, {
      message: 'each reference needs "openrouter" and/or "prices"',
    }),
]);

export const PricingFileSchema = z
  .object({
    $schema: z.string().optional(),
    openrouter: z
      .object({
        enabled: z
          .boolean()
          .describe(
            'Download public prices from the OpenRouter catalog (one GET, no usage data sent)'
          ),
        refreshHours: z
          .number()
          .positive()
          .max(24 * 30)
          .optional(),
        cacheFile: z.string().min(1).optional(),
        url: z.string().url().optional(),
        /** Price `openrouter/<id>` usage from the catalog without a mapping. */
        autoMap: z
          .boolean()
          .optional()
          .describe(
            'Price provider "openrouter" models from the catalog without a mapping (default true)'
          ),
      })
      .strict()
      .optional(),
    models: z.array(ModelEntrySchema).max(10_000).optional(),
    /** Models to compare the whole usage against ("what would it cost on X"). */
    references: z
      .array(ReferenceSchema)
      .max(100)
      .optional()
      .describe('Models to compare the whole usage against: OpenRouter ids or {name, prices}'),
  })
  .strict();

export type PricingFile = z.infer<typeof PricingFileSchema>;

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigError';
  }
}

export function parsePricingFile(text: string, file = 'pricing file'): PricingFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new PricingConfigError(`${file}: invalid JSON (${(err as Error).message})`);
  }
  const r = PricingFileSchema.safeParse(json);
  if (!r.success) {
    const issues = r.error.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new PricingConfigError(`${file}: ${issues}`);
  }
  const url = r.data.openrouter?.url;
  if (url !== undefined) assertSafeUrl(url);
  return r.data;
}

function assertSafeUrl(url: string): void {
  const u = new URL(url);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new PricingConfigError('openrouter.url must use https (http only for loopback)');
  }
}

function fromFilePrices(p: z.infer<typeof PricesSchema> | undefined): PriceTable {
  const t: PriceTable = {};
  if (!p) return t;
  if (p.input !== undefined) t.input = p.input;
  if (p.output !== undefined) t.output = p.output;
  if (p.cacheRead !== undefined) t.cache_read = p.cacheRead;
  if (p.cacheWrite !== undefined) t.cache_write = p.cacheWrite;
  return t;
}

// ------------------------------------------------------------ catalog --

/** USD-per-token string from OpenRouter → USD per 1M tokens, or undefined. */
export function perTokenToPerMillion(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const n = typeof value === 'number' ? value : Number(value.trim());
  // Negative values (e.g. "-1") mark routers with variable pricing.
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Number((n * 1_000_000).toPrecision(12));
}

const CatalogEntrySchema = z.object({
  id: z.string().min(1).max(256),
  pricing: z.record(z.string(), z.unknown()),
});

/**
 * Parses the OpenRouter `/api/v1/models` response. Invalid entries are
 * skipped. Tiered `overrides` (long-context prices) are ignored: the base
 * price is used.
 */
export function parseCatalog(json: unknown): Map<string, PriceTable> {
  const out = new Map<string, PriceTable>();
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('catalog: missing "data" array');
  for (const raw of data) {
    const r = CatalogEntrySchema.safeParse(raw);
    if (!r.success) continue;
    const p = r.data.pricing;
    const t: PriceTable = {};
    const set = (d: Direction, v: unknown) => {
      const n = perTokenToPerMillion(v);
      if (n !== undefined) t[d] = n;
    };
    set('input', p['prompt']);
    set('output', p['completion']);
    set('cache_read', p['input_cache_read']);
    set('cache_write', p['input_cache_write']);
    if (Object.keys(t).length > 0) out.set(r.data.id, t);
  }
  return out;
}

interface CatalogCache {
  version: 1;
  url: string;
  fetchedAt: number;
  models: Array<{ id: string; prices: PriceTable }>;
}

export interface CatalogOptions {
  url?: string;
  cacheFile: string;
  refreshMs: number;
  logger?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  userAgent?: string;
}

/**
 * OpenRouter catalog with a disk cache. Network access happens only when the
 * user enabled it, is a single unauthenticated GET, and sends no usage data.
 * A failed refresh keeps the previous prices.
 */
export class OpenRouterCatalog {
  readonly url: string;
  private models = new Map<string, PriceTable>();
  private fetchedAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private retryAt = 0;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  refreshErrors = 0;
  lastError: string | null = null;

  constructor(private readonly opts: CatalogOptions) {
    this.url = opts.url ?? DEFAULT_OPENROUTER_URL;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetch ?? fetch;
  }

  get size(): number {
    return this.models.size;
  }

  get updatedAt(): number | null {
    return this.fetchedAt;
  }

  get(id: string): PriceTable | undefined {
    return this.models.get(id);
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  /** Loads the disk cache, if present and for the same URL. */
  loadCache(): boolean {
    try {
      const st = lstatSync(this.opts.cacheFile);
      if (!st.isFile() || st.size > MAX_CATALOG_BYTES) return false;
      const c = JSON.parse(readFileSync(this.opts.cacheFile, 'utf8')) as CatalogCache;
      if (c.version !== 1 || c.url !== this.url || !Array.isArray(c.models)) return false;
      const models = new Map<string, PriceTable>();
      for (const m of c.models) {
        if (typeof m?.id !== 'string' || typeof m.prices !== 'object' || m.prices === null)
          continue;
        const t: PriceTable = {};
        for (const d of DIRECTIONS) {
          const v = (m.prices as Record<string, unknown>)[d];
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) t[d] = v;
        }
        models.set(m.id, t);
      }
      this.models = models;
      this.fetchedAt = typeof c.fetchedAt === 'number' ? c.fetchedAt : 0;
      return true;
    } catch {
      return false;
    }
  }

  isStale(): boolean {
    if (this.now() < this.retryAt) return false;
    return this.fetchedAt === null || this.now() - this.fetchedAt >= this.opts.refreshMs;
  }

  async refreshIfStale(): Promise<void> {
    if (this.isStale()) await this.refresh();
  }

  /** Fetches the catalog; concurrent calls share one request. */
  refresh(): Promise<void> {
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const res = await this.fetchFn(this.url, {
        headers: {
          accept: 'application/json',
          'user-agent': this.opts.userAgent ?? 'omp-usage-exporter',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_CATALOG_BYTES) throw new Error(`catalog too large (${len} bytes)`);
      const text = await res.text();
      if (text.length > MAX_CATALOG_BYTES) throw new Error('catalog too large');
      const models = parseCatalog(JSON.parse(text));
      if (models.size === 0) throw new Error('catalog contains no priced models');
      this.models = models;
      this.fetchedAt = this.now();
      this.lastError = null;
      this.retryAt = 0;
      this.writeCache();
      this.opts.logger?.info('OpenRouter price catalog updated', { models: models.size });
    } catch (err) {
      this.refreshErrors++;
      this.lastError = (err as Error).message;
      // Back off: 5 min, 10, 20, ... up to 6 h.
      this.retryAt =
        this.now() + Math.min(6 * 3_600_000, 300_000 * 2 ** Math.min(this.refreshErrors - 1, 7));
      this.opts.logger?.warn('OpenRouter price catalog refresh failed, keeping previous prices', {
        error: this.lastError,
        cachedModels: this.models.size,
      });
    }
  }

  private writeCache(): void {
    try {
      mkdirSync(dirname(this.opts.cacheFile), { recursive: true, mode: 0o700 });
      const cache: CatalogCache = {
        version: 1,
        url: this.url,
        fetchedAt: this.fetchedAt ?? this.now(),
        models: [...this.models].map(([id, prices]) => ({ id, prices })),
      };
      const tmp = `${this.opts.cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600, flag: 'w' });
      renameSync(tmp, this.opts.cacheFile);
    } catch (err) {
      this.opts.logger?.warn('could not write the price catalog cache', {
        file: this.opts.cacheFile,
        error: (err as Error).message,
      });
    }
  }
}

// ------------------------------------------------------------ resolve --

export interface ResolvedPrice {
  provider: string;
  model: string;
  direction: Direction;
  usdPerMillion: number;
  source: PriceSource;
}

export interface ResolvedMapping {
  provider: string;
  model: string;
  /** Catalog id the prices come from, if any. */
  openrouterId: string | null;
  /** How the mapping was obtained. */
  mapping: 'file' | 'auto';
  /** Directions with a known price. */
  directions: Direction[];
}

export interface ResolvedReference {
  name: string;
  direction: Direction;
  usdPerMillion: number;
  source: PriceSource;
}

export interface PricingSnapshot {
  prices: ResolvedPrice[];
  mappings: ResolvedMapping[];
  references: ResolvedReference[];
  /** Configured entries whose catalog id is unknown and that have no price. */
  unresolved: Array<{ kind: 'model' | 'reference'; name: string; openrouter: string | null }>;
}

const pairKey = (provider: string, model: string) => `${provider}\u0000${model}`;

function merge(
  catalog: PriceTable | undefined,
  explicit: PriceTable
): Array<[Direction, number, PriceSource]> {
  const out: Array<[Direction, number, PriceSource]> = [];
  for (const d of DIRECTIONS) {
    if (explicit[d] !== undefined) out.push([d, explicit[d], 'file']);
    else if (catalog?.[d] !== undefined) out.push([d, catalog[d], 'openrouter']);
  }
  return out;
}

/**
 * Resolves prices for the configured models, for the `openrouter` pairs seen
 * in the database (when autoMap is on) and for the reference models.
 */
export function resolvePricing(
  file: PricingFile,
  catalog: Pick<OpenRouterCatalog, 'get' | 'has'> | null,
  seenPairs: Array<{ provider: string; model: string }> = []
): PricingSnapshot {
  const snap: PricingSnapshot = { prices: [], mappings: [], references: [], unresolved: [] };
  const configured = new Set<string>();

  const add = (
    provider: string,
    model: string,
    openrouterId: string | null,
    explicit: PriceTable,
    mapping: 'file' | 'auto'
  ) => {
    const merged = merge(openrouterId && catalog ? catalog.get(openrouterId) : undefined, explicit);
    for (const [direction, usdPerMillion, source] of merged)
      snap.prices.push({ provider, model, direction, usdPerMillion, source });
    snap.mappings.push({
      provider,
      model,
      openrouterId,
      mapping,
      directions: merged.map(m => m[0]),
    });
    return merged.length;
  };

  for (const m of file.models ?? []) {
    const key = pairKey(m.provider, m.model);
    if (configured.has(key)) continue; // first entry wins
    configured.add(key);
    const n = add(m.provider, m.model, m.openrouter ?? null, fromFilePrices(m.prices), 'file');
    if (n === 0)
      snap.unresolved.push({
        kind: 'model',
        name: `${m.provider}/${m.model}`,
        openrouter: m.openrouter ?? null,
      });
  }

  const autoMap = file.openrouter?.enabled === true && file.openrouter.autoMap !== false;
  if (autoMap && catalog) {
    for (const p of seenPairs) {
      if (p.provider.toLowerCase() !== 'openrouter') continue;
      const key = pairKey(p.provider, p.model);
      if (configured.has(key)) continue;
      configured.add(key);
      const id = autoOpenRouterId(p.model, catalog);
      if (id) add(p.provider, p.model, id, {}, 'auto');
    }
  }

  for (const r of file.references ?? []) {
    const ref = typeof r === 'string' ? { name: r, openrouter: r, prices: undefined } : r;
    const merged = merge(
      ref.openrouter && catalog ? catalog.get(ref.openrouter) : undefined,
      fromFilePrices(ref.prices)
    );
    if (merged.length === 0) {
      snap.unresolved.push({
        kind: 'reference',
        name: ref.name,
        openrouter: ref.openrouter ?? null,
      });
      continue;
    }
    for (const [direction, usdPerMillion, source] of merged)
      snap.references.push({ name: ref.name, direction, usdPerMillion, source });
  }
  return snap;
}

/**
 * Catalog id for an OpenRouter model id. `vendor/model:free` maps to the paid
 * `vendor/model` (the equivalent cost of the free variant); any other id is
 * used as is. Router aliases keep their own catalog price (for
 * `openrouter/free` that is 0, for variable-price routers there is none).
 */
export function autoOpenRouterId(
  model: string,
  catalog: Pick<OpenRouterCatalog, 'has'>
): string | null {
  if (model.endsWith(':free')) {
    const paid = model.slice(0, -':free'.length);
    if (catalog.has(paid)) return paid;
  }
  return catalog.has(model) ? model : null;
}

// ------------------------------------------------------------ service --

export interface PricingServiceOptions {
  file: string;
  logger: Logger;
  userAgent?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How often to check the pricing file and the catalog age. */
  tickMs?: number;
  /** Default cache location when the file does not set one. */
  defaultCacheFile: string;
}

/** Loads the pricing file (reloaded when it changes) and the catalog. */
export class PricingService {
  private config: PricingFile;
  private mtimeMs = 0;
  private catalog: OpenRouterCatalog | null = null;
  private timer: NodeJS.Timeout | null = null;
  reloadErrors = 0;

  constructor(private readonly opts: PricingServiceOptions) {
    this.config = this.read(); // throws PricingConfigError on startup
    this.setupCatalog();
  }

  get file(): PricingFile {
    return this.config;
  }

  get openrouter(): OpenRouterCatalog | null {
    return this.catalog;
  }

  private read(): PricingFile {
    const path = this.opts.file;
    let text: string;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new PricingConfigError(`${path}: not a regular file`);
      if (st.size > 4 * 1024 * 1024) throw new PricingConfigError(`${path}: file too large`);
      this.mtimeMs = st.mtimeMs;
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if (err instanceof PricingConfigError) throw err;
      throw new PricingConfigError(`${path}: ${(err as Error).message}`);
    }
    return parsePricingFile(text, path);
  }

  private setupCatalog(): void {
    const or = this.config.openrouter;
    if (!or?.enabled) {
      this.catalog = null;
      return;
    }
    const url = or.url ?? DEFAULT_OPENROUTER_URL;
    const cacheFile = expandPath(or.cacheFile ?? this.opts.defaultCacheFile);
    if (this.catalog && this.catalog.url === url) return;
    this.catalog = new OpenRouterCatalog({
      url,
      cacheFile,
      refreshMs: (or.refreshHours ?? 24) * 3_600_000,
      logger: this.opts.logger,
      fetch: this.opts.fetch,
      now: this.opts.now,
      userAgent: this.opts.userAgent,
    });
    this.catalog.loadCache();
  }

  /** Re-reads the pricing file when its mtime changed. Keeps the old one on error. */
  reloadIfChanged(): boolean {
    let mtime: number;
    try {
      mtime = statSync(this.opts.file).mtimeMs;
    } catch {
      return false;
    }
    if (mtime === this.mtimeMs) return false;
    try {
      this.config = this.read();
      this.setupCatalog();
      this.opts.logger.info('pricing file reloaded', { file: this.opts.file });
      return true;
    } catch (err) {
      this.mtimeMs = mtime; // do not retry until it changes again
      this.reloadErrors++;
      this.opts.logger.error('invalid pricing file, keeping the previous prices', {
        error: (err as Error).message,
      });
      return false;
    }
  }

  /** First catalog refresh (if stale) and periodic checks. Never throws. */
  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 60_000);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    this.reloadIfChanged();
    await this.catalog?.refreshIfStale();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(seenPairs: Array<{ provider: string; model: string }> = []): PricingSnapshot {
    return resolvePricing(this.config, this.catalog, seenPairs);
  }
}
