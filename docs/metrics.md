# Metrics Reference

## LLM Metrics

All LLM metrics are **Counters** (monotonically increasing).

### `omp_llm_tokens_total`

Total tokens by provider, model, and direction.

| Label | Values |
|-------|--------|
| `provider` | Provider name (sanitized) |
| `model` | Model identifier (sanitized) |
| `direction` | `input`, `output`, `cache_read`, `cache_write` |

**Accounting rules:**
- `input` = non-cached conversation input tokens
- `output` = total conversation output tokens (includes reasoning)
- `cache_read` = tokens read from prompt cache
- `cache_write` = tokens written to prompt cache
- Reasoning tokens are **not** added to output again (already included)

### `omp_llm_reasoning_tokens_total`

Total reasoning/thinking tokens by provider and model.

| Label | Values |
|-------|--------|
| `provider` | Provider name |
| `model` | Model identifier |

Only incremented when provider reports `reasoningTokens`.

### `omp_llm_requests_total`

Total requests by provider, model, and status.

| Label | Values |
|-------|--------|
| `provider` | Provider name |
| `model` | Model identifier |
| `status` | `success`, `error` |

**Accounting rules:**
- `stopReason = "error"` → `status="error"`
- `stopReason = "stop" | "length" | "toolUse" | "aborted"` → `status="success"`
- Error with non-zero usage: tokens counted + error request counted

### `omp_llm_reported_cost_usd_total`

Total reported cost in USD by provider and model.

| Label | Values |
|-------|--------|
| `provider` | Provider name |
| `model` | Model identifier |

**Note:** Reported cost ≠ invoice. Do not use for billing without verification.

### `omp_llm_usage_missing_total`

Count of events where usage was not reported (null).

| Label | Values |
|-------|--------|
| `provider` | Provider name |
| `model` | Model identifier |

## Operational Metrics

### `omp_usage_import_errors_total`

Total import errors by reason.

| Label | Values |
|-------|--------|
| `reason` | `malformed`, `unknown_schema`, `line_too_long`, `io` |

### `omp_usage_invalid_records_total`

Total invalid records by reason.

| Label | Values |
|-------|--------|
| `reason` | `schema_validation`, `negative_value`, `nan_value` |

### `omp_usage_last_import_timestamp`

Unix timestamp of last successful import (Gauge).

### `omp_usage_label_cardinality`

Current number of unique (provider, model) label pairs (Gauge).

## Cardinality Management

The exporter limits unique (provider, model) label pairs to `maxLabelCardinality` (default 1000).

- **Under limit**: Each pair gets its own label set
- **Over limit**: Excess pairs aggregated into `_other` bucket
- **Events NOT dropped**: All events stored in SQLite, only label cardinality limited
- **Alert**: Monitor `omp_usage_label_cardinality` approaching limit

## Label Sanitization

Prometheus label values must match `[a-zA-Z0-9_:]`. The exporter:
1. Replaces invalid chars with `_`
2. Trims leading/trailing `_`
3. Truncates to 256 characters

Example: `openrouter/free` → `openrouter_free`

## PromQL Examples

### Total tokens by provider
```promql
sum by (provider) (rate(omp_llm_tokens_total[5m]))
```

### Total tokens by model (input vs output)
```promql
sum by (model, direction) (rate(omp_llm_tokens_total[5m]))
```

### Error rate by provider
```promql
sum by (provider) (rate(omp_llm_requests_total{status="error"}[5m]))
/
sum by (provider) (rate(omp_llm_requests_total[5m]))
```

### Cost per model
```promql
rate(omp_llm_reported_cost_usd_total[1h])
```

### Missing usage rate
```promql
rate(omp_llm_usage_missing_total[5m])
```

### Import health
```promql
# Errors in last 5 minutes
increase(omp_usage_import_errors_total[5m])

# Time since last import
time() - omp_usage_last_import_timestamp
```

## Accounting Rules Summary

| Rule | Implementation |
|------|----------------|
| Reasoning ⊆ output | `reasoningTokens` never added to `output` |
| No totalTokens double-count | `totalTokens` not summed into input/output |
| Error counts as request | `stopReason="error"` → `requests_error++` |
| Missing usage ≠ zero | `usage=null` → `usage_missing++`, tokens not counted |
| Error with usage | Tokens counted + error request counted |
| Reported cost ≠ invoice | Stored separately, no automatic tariff |
| `increase()` aligns to scrape | Not event timestamp (Prometheus semantics) |
| Historical import ≠ backfill | Prometheus doesn't reconstruct history |
| OMP + llama.cpp | Don't double-count; separate tracking |

## Cost Interpretation

| Cost Field | Meaning |
|------------|---------|
| `reported_cost_usd` | What the provider reported (may be $0 for free tiers) |
| `equivalent_cost_usd` | Computed from tokens × tariff (not implemented in v1) |

**v1 does not implement automatic tariff application.** Use reported cost as lower bound; compute equivalent cost externally if needed.