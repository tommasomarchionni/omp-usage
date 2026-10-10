# Pricing & Equivalent Cost

OMP reports a cost for each request (`omp_llm_reported_cost_usd_total`). For local models (llama.cpp, Ollama, LM Studio), free OpenRouter variants and router aliases, that cost is **0 or missing**. The exporter can also export **price tables**, so dashboards can answer:

- What would my local usage have cost on OpenRouter for the same model? (savings)
- What would my whole usage cost on Claude Sonnet, GPT-5 or another reference model?
- What would a model cost at the prices I choose myself?

The exporter **never multiplies tokens by prices** and never changes the reported cost. It exports prices as gauges, and Grafana/PromQL computes `tokens × price / 1e6` for the selected time range. Reported cost and equivalent cost stay separate series.

## Enable

```bash
omp-usage-exporter --pricing-file ~/.config/omp-usage/pricing.json
# or
export OMP_USAGE_PRICING_FILE=~/.config/omp-usage/pricing.json
```

Without a pricing file, nothing changes: no price metrics and no network access.

## Pricing file

A complete example lives at [`examples/pricing/pricing.json`](https://github.com/tommasomarchionni/omp-usage/blob/main/examples/pricing/pricing.json). A [JSON Schema](https://github.com/tommasomarchionni/omp-usage/blob/main/examples/pricing/pricing.schema.json) gives editor autocompletion through `"$schema"`.

```json
{
  "$schema": "https://raw.githubusercontent.com/tommasomarchionni/omp-usage/main/examples/pricing/pricing.schema.json",
  "openrouter": { "enabled": true, "refreshHours": 24 },
  "models": [
    { "provider": "llama.cpp", "model": "qwen3.6-35b-a3b", "openrouter": "qwen/qwen3.6-35b-a3b" },
    {
      "provider": "ollama",
      "model": "my-finetune",
      "prices": { "input": 0.1, "output": 0.4, "cacheRead": 0.01, "cacheWrite": 0 }
    }
  ],
  "references": ["anthropic/claude-sonnet-4.5", "openai/gpt-5"]
}
```

| Key                                   | Meaning                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `openrouter.enabled`                  | Download the public [OpenRouter model catalog](https://openrouter.ai/api/v1/models). Default `false`                                   |
| `openrouter.refreshHours`             | Catalog refresh interval, default `24`                                                                                                 |
| `openrouter.cacheFile`                | Disk cache, default `~/.local/state/omp-usage/openrouter-models.json` (mode 0600). Used at startup and when offline                    |
| `openrouter.autoMap`                  | Price provider `openrouter` usage from the catalog without listing each model. Default `true`                                          |
| `models[].provider`, `models[].model` | Exactly the `provider` and `model` labels of `omp_llm_tokens_total`                                                                    |
| `models[].openrouter`                 | OpenRouter id to take the prices from                                                                                                  |
| `models[].prices`                     | Explicit prices, **USD per 1M tokens**: `input`, `output`, `cacheRead`, `cacheWrite`. They override the catalog direction by direction |
| `references[]`                        | OpenRouter ids, or `{ "name", "prices" }`, to compare the whole usage against                                                          |

The file is validated at startup, and an invalid file stops the exporter with exit code 2. It is re-read within a minute when it changes; an invalid edit is rejected and the previous prices are kept.

Find the exact provider/model names with:

```bash
curl -s http://127.0.0.1:9464/metrics | grep '^omp_llm_requests_total'
```

### Mapping rules

- **Explicit only.** A local model is priced only if you map it. The exporter never guesses that `llama.cpp/qwen3.6-35b-a3b` is `qwen/qwen3.6-35b-a3b`, because quantization, context and provider routing differ.
- **Provider `openrouter`** (with `autoMap`): the model id is used as is. A `:free` variant (`vendor/model:free`) is priced as its paid `vendor/model`, which is the equivalent cost of the free usage.
- **Router aliases** such as `openrouter/free` keep their own catalog price (0). OMP does not say which model served the request, so the exporter does not invent one. Variable-price routers (catalog price `-1`, such as `openrouter/auto`) have no price.
- Catalog `prompt` → `input`, `completion` → `output`, `input_cache_read` → `cache_read`, `input_cache_write` → `cache_write`. A direction without a price is **not** priced (not 0), so the equivalent cost of that direction is missing rather than wrong.
- Long-context tier prices (`overrides`, e.g. above 200k prompt tokens) are ignored: the base price is used.

### Privacy

With `openrouter.enabled`, the exporter makes **one unauthenticated GET** to the catalog URL at most every `refreshHours`, with `User-Agent: omp-usage-exporter/<version>` and no usage data, prompts or keys. Redirects are refused and the response size is capped. Failures keep the previous prices, with exponential back-off from 5 minutes to 6 hours.

## Check

```bash
omp-usage-exporter --pricing-file pricing.json --print-prices
```

The command prints every resolved price with its source, the mappings and the references. It also lists the **pairs in the database that have no price** and any unresolved entries, and exits with status `3` when a configured entry cannot be priced.

## Metrics

| Metric                                                | Labels                                          | Meaning                                                            |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `omp_llm_price_usd_per_million_tokens`                | `provider`, `model`, `direction`, `source`      | Price used for equivalent cost. `source` is `file` or `openrouter` |
| `omp_llm_reference_price_usd_per_million_tokens`      | `reference_model`, `direction`, `source`        | Prices of the reference models                                     |
| `omp_llm_pricing_info`                                | `provider`, `model`, `openrouter_id`, `mapping` | Mapping (`file` or `auto`); value = number of priced directions    |
| `omp_usage_pricing_unresolved`                        | `kind`, `name`                                  | Configured entries without any price                               |
| `omp_usage_pricing_catalog_models`                    |                                                 | Models in the loaded catalog                                       |
| `omp_usage_pricing_catalog_updated_timestamp_seconds` |                                                 | Last successful download                                           |
| `omp_usage_pricing_errors_total`                      | `kind`                                          | `catalog_refresh`, `file_reload`                                   |

## PromQL

Equivalent cost per model over the dashboard range:

```promql
sum by (provider, model) (
  increase(omp_llm_tokens_total{job="omp_usage"}[$__range])
  * on (provider, model, direction) group_left
  max by (provider, model, direction) (omp_llm_price_usd_per_million_tokens{job="omp_usage"})
) / 1e6
```

`max by (...)` drops the `source` label, so the join is one-to-one.

Savings (equivalent cost minus what was actually reported):

```promql
(
  sum by (provider, model) (
    increase(omp_llm_tokens_total{job="omp_usage"}[$__range])
    * on (provider, model, direction) group_left
    max by (provider, model, direction) (omp_llm_price_usd_per_million_tokens{job="omp_usage"})
  ) / 1e6
)
- on (provider, model)
sum by (provider, model) (increase(omp_llm_reported_cost_usd_total{job="omp_usage"}[$__range]))
```

All usage priced at a reference model:

```promql
sum by (reference_model) (
  sum by (direction) (increase(omp_llm_tokens_total{job="omp_usage"}[$__range]))
  * on (direction) group_right
  max by (reference_model, direction) (omp_llm_reference_price_usd_per_million_tokens{job="omp_usage"})
) / 1e6
```

Pairs with tokens but no price (coverage check):

```promql
sum by (provider, model) (increase(omp_llm_tokens_total{job="omp_usage"}[$__range])) > 0
unless on (provider, model)
max by (provider, model) (omp_llm_price_usd_per_million_tokens{job="omp_usage"})
```

Ready-made Grafana dashboards are described in [Grafana](grafana.md).

## Limits

- Prices change. The equivalent cost uses **current** prices for the whole range, not the price in force when each token was used.
- The OpenRouter price of a model is the price of the routed provider, which may differ from the price a direct API charges. It is not an invoice.
- `increase()` attributes tokens to the scrape that saw them, not to the original event time (see [Metrics](metrics.md)).
