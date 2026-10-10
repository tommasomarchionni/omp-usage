# Metrics Reference

All metrics carry the default label `app="omp-usage-exporter"`; Prometheus adds `job` and `instance`.

LLM counters are computed from the SQLite aggregates on every scrape. They are monotonic, survive exporter restarts and never double count re-imported files.

## LLM metrics

| Metric                            | Type    | Labels                             | Meaning                                                                                               |
| --------------------------------- | ------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `omp_llm_tokens_total`            | counter | `provider`, `model`, `direction`   | Tokens by direction: `input`, `output`, `cache_read`, `cache_write`                                   |
| `omp_llm_reasoning_tokens_total`  | counter | `provider`, `model`                | Reasoning/thinking tokens. **Subset of `output`**, never add them to output                           |
| `omp_llm_requests_total`          | counter | `provider`, `model`, `status`      | Assistant messages: `success`, `error` (`stopReason=error`), `aborted`                                |
| `omp_llm_stop_reasons_total`      | counter | `provider`, `model`, `stop_reason` | Assistant messages by raw stop reason (`stop`, `length`, `toolUse`, `error`, `aborted`, `unknown`, …) |
| `omp_llm_reported_cost_usd_total` | counter | `provider`, `model`                | Cost reported by the provider through OMP, in USD                                                     |
| `omp_llm_usage_missing_total`     | counter | `provider`, `model`                | Messages without usage (`usage: null`)                                                                |
| `omp_llm_cost_missing_total`      | counter | `provider`, `model`                | Messages with usage but without a reported cost                                                       |

### Accounting rules

| Rule                                  | Implementation                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Reasoning ⊆ output                    | `reasoningTokens` is exported separately and never added to `output`                     |
| No `totalTokens` double count         | `totalTokens` is stored but not exported                                                 |
| Error is a failed attempt             | `stopReason="error"` → `status="error"`; tokens reported with an error are still counted |
| Missing ≠ zero                        | `usage: null` increments `usage_missing`, a missing cost increments `cost_missing`       |
| Reported cost ≠ invoice               | Free tiers report 0; routers may report estimates                                        |
| Router aliases                        | `openrouter/free` is exported as `openrouter/free`; the underlying model is not guessed  |
| `increase()` follows scrapes          | Prometheus attributes increments to scrape time, not to the original event timestamp     |
| Importing old JSONL is not a backfill | Old events appear as a step at the time they are first imported                          |
| OMP vs llama.cpp                      | Local generations may appear in both; never sum the two                                  |

### Label values

Label values are exported verbatim: `openrouter/free`, `qwen3.6-35b-a3b:Q4_K_M` and `llama.cpp` are all valid Prometheus label values. Control characters are replaced with `_` and values are truncated to 128 characters.

Upgrading from 0.2.x: older versions replaced `/`, `-` and `.` with `_` (`openrouter/free` → `openrouter_free`). Dashboards or rules matching the old values must be updated. Prometheus treats the new values as new series.

### Cardinality limit

At most `--max-label-cardinality` (default 1000) distinct `(provider, model)` pairs are exported, in first-seen order. Usage of additional pairs is still stored and counted, folded into `provider="_other", model="_other"`. Watch `omp_usage_label_overflow_pairs > 0`.

## Operational metrics

| Metric                                      | Type    | Labels                    | Meaning                                                                                                                |
| ------------------------------------------- | ------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `omp_usage_events_imported_total`           | counter |                           | Events stored in the database                                                                                          |
| `omp_usage_invalid_records_total`           | counter | `reason`                  | Skipped lines: `invalid_json`, `invalid_schema`, `unknown_schema_version`, `line_too_long`, `invalid_utf8` (persisted) |
| `omp_usage_import_errors_total`             | counter | `reason`                  | Failed file imports since process start: `io`, `database`, `other`                                                     |
| `omp_usage_file_resets_total`               | counter | `reason`                  | Files re-read from offset 0: `replaced`, `truncated`, `rewritten`                                                      |
| `omp_usage_last_import_timestamp_seconds`   | gauge   |                           | Unix time of the last successful cycle (0 before the first)                                                            |
| `omp_usage_last_import_success`             | gauge   |                           | 1 if the last cycle had no file errors                                                                                 |
| `omp_usage_last_import_duration_seconds`    | gauge   |                           | Duration of the last cycle                                                                                             |
| `omp_usage_files_tracked`                   | gauge   |                           | Files with a cursor                                                                                                    |
| `omp_usage_label_cardinality`               | gauge   |                           | Exported `(provider, model)` pairs                                                                                     |
| `omp_usage_label_overflow_pairs`            | gauge   |                           | Pairs folded into `_other`                                                                                             |
| `omp_usage_build_info`                      | gauge   | `version`, `node_version` | Always 1                                                                                                               |
| `omp_usage_process_*`, `omp_usage_nodejs_*` | various |                           | Standard Node.js process metrics                                                                                       |

`omp_usage_last_import_timestamp` (without `_seconds`) from 0.2.x was renamed.

## PromQL examples

```promql
# Tokens per model over the selected Grafana range
sum by (model) (increase(omp_llm_tokens_total[$__range]))

# Input vs output rate
sum by (direction) (rate(omp_llm_tokens_total[5m]))

# Error ratio per provider
sum by (provider) (rate(omp_llm_requests_total{status="error"}[15m]))
  / sum by (provider) (rate(omp_llm_requests_total[15m]))

# Prompt cache hit ratio
sum(rate(omp_llm_tokens_total{direction="cache_read"}[1h]))
  / sum(rate(omp_llm_tokens_total{direction=~"input|cache_read"}[1h]))

# Reported cost in the last 24 hours
sum(increase(omp_llm_reported_cost_usd_total[24h]))

# Exporter freshness
time() - omp_usage_last_import_timestamp_seconds
```
