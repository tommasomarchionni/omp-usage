import client, { Counter, Gauge, Registry } from '@prometheus-io/client';
import type { ExporterDatabase } from './database.js';
import type { PricingService, PricingSnapshot } from './pricing.js';
import type { AggregatedMetrics } from './protocol.js';

/** Label value used when the (provider, model) cardinality limit is exceeded. */
export const OVERFLOW_LABEL = '_other';
const MAX_LABEL_VALUE_LENGTH = 128;

export interface ExporterState {
  /** Unix ms of the last import cycle that completed without file errors. */
  lastSuccessMs: number | null;
  /** Unix ms of the last import cycle, successful or not. */
  lastAttemptMs: number | null;
  lastCycleOk: boolean;
  lastDurationMs: number;
  lastError: string | null;
  filesTracked: number;
}

export function createExporterState(): ExporterState {
  return {
    lastSuccessMs: null,
    lastAttemptMs: null,
    lastCycleOk: true,
    lastDurationMs: 0,
    lastError: null,
    filesTracked: 0,
  };
}

/**
 * Prometheus label values may contain any UTF-8 text, so provider and model
 * names are preserved verbatim (e.g. `openrouter/free`, `qwen3.6-35b-a3b`).
 * Only control characters are replaced and very long values are truncated.
 */
export function normalizeLabelValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '_');
  return cleaned.length > MAX_LABEL_VALUE_LENGTH
    ? cleaned.slice(0, MAX_LABEL_VALUE_LENGTH)
    : cleaned;
}

/**
 * Maps every (provider, model) pair to the label pair that will be exported.
 * The first `maxCardinality` pairs (in first-seen order) keep their names;
 * the rest are folded into `_other/_other` so their usage is still counted.
 */
export function buildLabelMap(
  pairs: Array<{ provider: string; model: string }>,
  maxCardinality: number
): { map: Map<string, { provider: string; model: string }>; exported: number; overflow: number } {
  const map = new Map<string, { provider: string; model: string }>();
  let exported = 0;
  let overflow = 0;
  for (const p of pairs) {
    const key = pairKey(p.provider, p.model);
    if (map.has(key)) continue;
    if (exported < maxCardinality) {
      map.set(key, {
        provider: normalizeLabelValue(p.provider),
        model: normalizeLabelValue(p.model),
      });
      exported++;
    } else {
      map.set(key, { provider: OVERFLOW_LABEL, model: OVERFLOW_LABEL });
      overflow++;
    }
  }
  return { map, exported, overflow };
}

function pairKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

export interface MetricsOptions {
  maxLabelCardinality: number;
  version: string;
  /** Collect Node.js process metrics (prefixed `omp_usage_`). */
  collectProcessMetrics?: boolean;
  /** Optional price tables (--pricing-file). */
  pricing?: PricingService | null;
}

export interface ExporterMetrics {
  registry: Registry;
  importErrorsTotal: Counter<'reason'>;
  fileResetsTotal: Counter<'reason'>;
  filesDeletedTotal: Counter;
}

/**
 * Creates the registry. LLM counters are computed from the SQLite aggregates
 * at scrape time, so they are always consistent with the database, survive
 * restarts and are never double counted.
 */
export function createMetrics(
  db: ExporterDatabase,
  state: ExporterState,
  options: MetricsOptions
): ExporterMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'omp-usage-exporter' });
  if (options.collectProcessMetrics !== false) {
    client.collectDefaultMetrics({ register: registry, prefix: 'omp_usage_' });
  }

  // Snapshot shared by all LLM collectors within a single scrape. The
  // registry collects metrics in registration order, so the first collector
  // (omp_llm_tokens_total) refreshes it and the others reuse it: one query
  // per scrape and consistent values across metrics.
  let snapshot: { aggs: AggregatedMetrics[]; labels: ReturnType<typeof buildLabelMap> } | null =
    null;
  const refreshSnapshot = () => {
    const aggs = db.isClosed() ? [] : db.getAggregates();
    snapshot = { aggs, labels: buildLabelMap(aggs, options.maxLabelCardinality) };
    return snapshot;
  };
  const getSnapshot = () => snapshot ?? refreshSnapshot();
  const labelsFor = (provider: string, model: string) =>
    getSnapshot().labels.map.get(pairKey(provider, model)) ?? {
      provider: OVERFLOW_LABEL,
      model: OVERFLOW_LABEL,
    };

  new Counter({
    name: 'omp_llm_tokens_total',
    help: 'Tokens reported by OMP, by provider, model and direction (input, output, cache_read, cache_write). Reasoning tokens are part of output.',
    labelNames: ['provider', 'model', 'direction'],
    registers: [registry],
    collect() {
      this.reset();
      for (const a of refreshSnapshot().aggs) {
        const l = labelsFor(a.provider, a.model);
        this.inc({ ...l, direction: 'input' }, a.inputTokens);
        this.inc({ ...l, direction: 'output' }, a.outputTokens);
        this.inc({ ...l, direction: 'cache_read' }, a.cacheReadTokens);
        this.inc({ ...l, direction: 'cache_write' }, a.cacheWriteTokens);
      }
    },
  });

  new Counter({
    name: 'omp_llm_reasoning_tokens_total',
    help: 'Reasoning/thinking tokens (a subset of output tokens, do not add to output)',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const a of getSnapshot().aggs)
        this.inc(labelsFor(a.provider, a.model), a.reasoningTokens);
    },
  });

  new Counter({
    name: 'omp_llm_requests_total',
    help: 'Assistant messages by status: success, error (stopReason=error) or aborted',
    labelNames: ['provider', 'model', 'status'],
    registers: [registry],
    collect() {
      this.reset();
      for (const a of getSnapshot().aggs) {
        const l = labelsFor(a.provider, a.model);
        this.inc({ ...l, status: 'success' }, a.requestsSuccess);
        this.inc({ ...l, status: 'error' }, a.requestsError);
        this.inc({ ...l, status: 'aborted' }, a.requestsAborted);
      }
    },
  });

  new Counter({
    name: 'omp_llm_stop_reasons_total',
    help: 'Assistant messages by stop reason as reported by OMP',
    labelNames: ['provider', 'model', 'stop_reason'],
    registers: [registry],
    collect() {
      this.reset();
      if (db.isClosed()) return;
      for (const s of db.getStopReasonAggregates()) {
        this.inc(
          { ...labelsFor(s.provider, s.model), stop_reason: normalizeLabelValue(s.stopReason) },
          s.count
        );
      }
    },
  });

  new Counter({
    name: 'omp_llm_reported_cost_usd_total',
    help: 'Cost reported by the provider through OMP, in USD. Not an invoice.',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const a of getSnapshot().aggs)
        this.inc(labelsFor(a.provider, a.model), a.reportedCostUsd);
    },
  });

  new Counter({
    name: 'omp_llm_usage_missing_total',
    help: 'Assistant messages without usage data (missing is not zero)',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const a of getSnapshot().aggs) this.inc(labelsFor(a.provider, a.model), a.usageMissing);
    },
  });

  new Counter({
    name: 'omp_llm_cost_missing_total',
    help: 'Assistant messages with usage but without a reported cost (missing is not zero)',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const a of getSnapshot().aggs) this.inc(labelsFor(a.provider, a.model), a.costMissing);
    },
  });

  // ------------------------------------------------------------ pricing --
  // Prices are exported as gauges; equivalent costs are computed in PromQL
  // (tokens × price / 1e6) so they follow the selected time range and are
  // never mixed with the reported cost.
  const pricing = options.pricing ?? null;
  let pricingSnap: PricingSnapshot | null = null;
  const getPricing = (): PricingSnapshot | null => {
    if (!pricing) return null;
    pricingSnap ??= pricing.snapshot(getSnapshot().aggs);
    return pricingSnap;
  };
  /** Same label values as the token counters, so `on(provider, model)` joins match. */
  const priceLabels = (provider: string, model: string) => {
    const l = getSnapshot().labels.map.get(pairKey(provider, model));
    return l && l.provider !== OVERFLOW_LABEL
      ? l
      : { provider: normalizeLabelValue(provider), model: normalizeLabelValue(model) };
  };

  if (pricing) {
    new Gauge({
      name: 'omp_llm_price_usd_per_million_tokens',
      help: 'Configured price in USD per 1M tokens, by provider, model and direction (source: file or openrouter). Use for equivalent cost: tokens * price / 1e6',
      labelNames: ['provider', 'model', 'direction', 'source'],
      registers: [registry],
      collect() {
        this.reset();
        pricingSnap = null; // one resolution per scrape
        for (const p of getPricing()?.prices ?? [])
          this.set(
            { ...priceLabels(p.provider, p.model), direction: p.direction, source: p.source },
            p.usdPerMillion
          );
      },
    });

    new Gauge({
      name: 'omp_llm_reference_price_usd_per_million_tokens',
      help: 'Price of a reference model in USD per 1M tokens, to compare the whole usage against it',
      labelNames: ['reference_model', 'direction', 'source'],
      registers: [registry],
      collect() {
        this.reset();
        for (const r of getPricing()?.references ?? [])
          this.set(
            {
              reference_model: normalizeLabelValue(r.name),
              direction: r.direction,
              source: r.source,
            },
            r.usdPerMillion
          );
      },
    });

    new Gauge({
      name: 'omp_llm_pricing_info',
      help: 'Price mapping per provider/model (openrouter_id is empty for explicit prices); value is the number of priced directions',
      labelNames: ['provider', 'model', 'openrouter_id', 'mapping'],
      registers: [registry],
      collect() {
        this.reset();
        for (const m of getPricing()?.mappings ?? [])
          this.set(
            {
              ...priceLabels(m.provider, m.model),
              openrouter_id: normalizeLabelValue(m.openrouterId ?? ''),
              mapping: m.mapping,
            },
            m.directions.length
          );
      },
    });

    new Gauge({
      name: 'omp_usage_pricing_unresolved',
      help: 'Configured models or references without any price (unknown OpenRouter id or catalog not loaded)',
      labelNames: ['kind', 'name'],
      registers: [registry],
      collect() {
        this.reset();
        for (const u of getPricing()?.unresolved ?? [])
          this.set({ kind: u.kind, name: normalizeLabelValue(u.name) }, 1);
      },
    });

    new Gauge({
      name: 'omp_usage_pricing_catalog_models',
      help: 'Models with prices in the OpenRouter catalog (0 when disabled or not loaded)',
      registers: [registry],
      collect() {
        this.set(pricing.openrouter?.size ?? 0);
      },
    });

    new Gauge({
      name: 'omp_usage_pricing_catalog_updated_timestamp_seconds',
      help: 'Unix time of the last successful OpenRouter catalog download',
      registers: [registry],
      collect() {
        const t = pricing.openrouter?.updatedAt;
        if (t) this.set(t / 1000);
      },
    });

    new Counter({
      name: 'omp_usage_pricing_errors_total',
      help: 'Failed catalog refreshes and rejected pricing file reloads since process start',
      labelNames: ['kind'],
      registers: [registry],
      collect() {
        this.reset();
        this.inc({ kind: 'catalog_refresh' }, pricing.openrouter?.refreshErrors ?? 0);
        this.inc({ kind: 'file_reload' }, pricing.reloadErrors);
      },
    });
  }

  // ------------------------------------------------------- operational --

  new Counter({
    name: 'omp_usage_invalid_records_total',
    help: 'Lines skipped by the importer, by reason (persisted across restarts)',
    labelNames: ['reason'],
    registers: [registry],
    collect() {
      this.reset();
      if (db.isClosed()) return;
      for (const [reason, count] of Object.entries(db.getInvalidRecordCounts()))
        this.inc({ reason }, count);
    },
  });

  new Counter({
    name: 'omp_usage_events_imported_total',
    help: 'Events stored in the exporter database',
    registers: [registry],
    collect() {
      this.reset();
      if (!db.isClosed()) this.inc(db.countEvents());
    },
  });

  const importErrorsTotal = new Counter({
    name: 'omp_usage_import_errors_total',
    help: 'Import failures since process start, by reason (io, database)',
    labelNames: ['reason'],
    registers: [registry],
  });

  const fileResetsTotal = new Counter({
    name: 'omp_usage_file_resets_total',
    help: 'Event files re-read from the start since process start, by reason (replaced, truncated, rewritten)',
    labelNames: ['reason'],
    registers: [registry],
  });

  const filesDeletedTotal = new Counter({
    name: 'omp_usage_files_deleted_total',
    help: 'Fully imported event files deleted by --retention-days since process start',
    registers: [registry],
  });

  new Gauge({
    name: 'omp_usage_last_import_timestamp_seconds',
    help: 'Unix time of the last successful import cycle',
    registers: [registry],
    collect() {
      if (state.lastSuccessMs !== null) this.set(state.lastSuccessMs / 1000);
    },
  });

  new Gauge({
    name: 'omp_usage_last_import_success',
    help: '1 if the last import cycle completed without file errors, 0 otherwise',
    registers: [registry],
    collect() {
      this.set(state.lastCycleOk ? 1 : 0);
    },
  });

  new Gauge({
    name: 'omp_usage_last_import_duration_seconds',
    help: 'Duration of the last import cycle',
    registers: [registry],
    collect() {
      this.set(state.lastDurationMs / 1000);
    },
  });

  new Gauge({
    name: 'omp_usage_files_tracked',
    help: 'Event files with a stored read cursor',
    registers: [registry],
    collect() {
      this.set(state.filesTracked);
    },
  });

  new Gauge({
    name: 'omp_usage_label_cardinality',
    help: 'Distinct (provider, model) pairs exported with their own labels',
    registers: [registry],
    collect() {
      this.set(getSnapshot().labels.exported);
    },
  });

  new Gauge({
    name: 'omp_usage_label_overflow_pairs',
    help: 'Distinct (provider, model) pairs folded into _other because of --max-label-cardinality',
    registers: [registry],
    collect() {
      this.set(getSnapshot().labels.overflow);
    },
  });

  const buildInfo = new Gauge({
    name: 'omp_usage_build_info',
    help: 'Build information',
    labelNames: ['version', 'node_version'],
    registers: [registry],
  });
  buildInfo.set({ version: options.version, node_version: process.version }, 1);

  return { registry, importErrorsTotal, fileResetsTotal, filesDeletedTotal };
}
