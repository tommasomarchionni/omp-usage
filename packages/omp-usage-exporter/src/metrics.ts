import client, { Registry, Counter, Gauge } from "@prometheus-io/client";
import type { AggregatedMetrics } from "@tommasomarchionni/omp-usage-protocol";

export function createRegistry(): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ app: "omp-usage-exporter" });
  client.collectDefaultMetrics({ register: registry, prefix: "omp_usage_" });
  return registry;
}

export interface LlmMetrics {
  tokensTotal: Counter<string>;
  reasoningTokensTotal: Counter<string>;
  requestsTotal: Counter<string>;
  reportedCostUsdTotal: Counter<string>;
  usageMissingTotal: Counter<string>;
}

export function createLlmMetrics(registry: Registry, _maxLabelCardinality: number): LlmMetrics {
  const tokensTotal = new Counter({
    name: "omp_llm_tokens_total",
    help: "Total tokens by provider, model, and direction",
    labelNames: ["provider", "model", "direction"],
    registers: [registry],
  });

  const reasoningTokensTotal = new Counter({
    name: "omp_llm_reasoning_tokens_total",
    help: "Total reasoning/thinking tokens by provider and model",
    labelNames: ["provider", "model"],
    registers: [registry],
  });

  const requestsTotal = new Counter({
    name: "omp_llm_requests_total",
    help: "Total requests by provider, model, and status",
    labelNames: ["provider", "model", "status"],
    registers: [registry],
  });

  const reportedCostUsdTotal = new Counter({
    name: "omp_llm_reported_cost_usd_total",
    help: "Total reported cost in USD by provider and model",
    labelNames: ["provider", "model"],
    registers: [registry],
  });

  const usageMissingTotal = new Counter({
    name: "omp_llm_usage_missing_total",
    help: "Total events with missing usage data by provider and model",
    labelNames: ["provider", "model"],
    registers: [registry],
  });

  return { tokensTotal, reasoningTokensTotal, requestsTotal, reportedCostUsdTotal, usageMissingTotal };
}

export interface OperationalMetrics {
  importErrorsTotal: Counter<string>;
  invalidRecordsTotal: Counter<string>;
  lastImportTimestamp: Gauge<never>;
  labelCardinalityGauge: Gauge<never>;
}

export function createOperationalMetrics(registry: Registry): OperationalMetrics {
  const importErrorsTotal = new Counter({
    name: "omp_usage_import_errors_total",
    help: "Total import errors by reason",
    labelNames: ["reason"],
    registers: [registry],
  });

  const invalidRecordsTotal = new Counter({
    name: "omp_usage_invalid_records_total",
    help: "Total invalid records by reason",
    labelNames: ["reason"],
    registers: [registry],
  });

  const lastImportTimestamp = new Gauge({
    name: "omp_usage_last_import_timestamp",
    help: "Unix timestamp of last successful import",
    registers: [registry],
  });

  const labelCardinalityGauge = new Gauge({
    name: "omp_usage_label_cardinality",
    help: "Current number of unique (provider, model) label pairs",
    registers: [registry],
  });

  return { importErrorsTotal, invalidRecordsTotal, lastImportTimestamp, labelCardinalityGauge };
}

export interface AllMetrics {
  llm: LlmMetrics;
  operational: OperationalMetrics;
  registry: Registry;
}

export function createAllMetrics(maxLabelCardinality: number): AllMetrics {
  const registry = createRegistry();
  const llm = createLlmMetrics(registry, maxLabelCardinality);
  const operational = createOperationalMetrics(registry);
  return { llm, operational, registry };
}

export function sanitizeLabel(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_:]/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 256);
}

export function updateLlmMetricsFromAggregates(
  metrics: LlmMetrics,
  aggregates: AggregatedMetrics[],
  maxCardinality: number,
): number {
  let cardinality = 0;

  for (const agg of aggregates) {
    if (cardinality >= maxCardinality) {
      updateLlmMetrics(metrics, "_other", "_other", agg);
    } else {
      updateLlmMetrics(metrics, agg.provider, agg.model, agg);
      cardinality++;
    }
  }

  return cardinality;
}

function updateLlmMetrics(
  metrics: LlmMetrics,
  provider: string,
  model: string,
  agg: AggregatedMetrics,
): void {
  const p = sanitizeLabel(provider);
  const m = sanitizeLabel(model);

  if (agg.inputTokens > 0) {
    metrics.tokensTotal.inc({ provider: p, model: m, direction: "input" }, agg.inputTokens);
  }
  if (agg.outputTokens > 0) {
    metrics.tokensTotal.inc({ provider: p, model: m, direction: "output" }, agg.outputTokens);
  }
  if (agg.cacheReadTokens > 0) {
    metrics.tokensTotal.inc({ provider: p, model: m, direction: "cache_read" }, agg.cacheReadTokens);
  }
  if (agg.cacheWriteTokens > 0) {
    metrics.tokensTotal.inc({ provider: p, model: m, direction: "cache_write" }, agg.cacheWriteTokens);
  }
  if (agg.reasoningTokens > 0) {
    metrics.reasoningTokensTotal.inc({ provider: p, model: m }, agg.reasoningTokens);
  }
  if (agg.requestsSuccess > 0) {
    metrics.requestsTotal.inc({ provider: p, model: m, status: "success" }, agg.requestsSuccess);
  }
  if (agg.requestsError > 0) {
    metrics.requestsTotal.inc({ provider: p, model: m, status: "error" }, agg.requestsError);
  }
  if (agg.reportedCostUsd > 0) {
    metrics.reportedCostUsdTotal.inc({ provider: p, model: m }, agg.reportedCostUsd);
  }
  if (agg.usageMissing > 0) {
    metrics.usageMissingTotal.inc({ provider: p, model: m }, agg.usageMissing);
  }
}