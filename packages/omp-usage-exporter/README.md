# @tommasomarchionni/omp-usage-exporter

Prometheus exporter for the usage events written by the [`@tommasomarchionni/omp-usage`](https://www.npmjs.com/package/@tommasomarchionni/omp-usage) OMP plugin. It imports the JSONL files into SQLite and serves the totals at `/metrics`. Imports are idempotent, crash-safe and transactional.

## Run

```bash
npx @tommasomarchionni/omp-usage-exporter            # 127.0.0.1:9464
omp-usage-exporter --listen 0.0.0.0:9464              # expose to a Prometheus on the LAN
omp-usage-exporter --import-once                      # import and exit
omp-usage-exporter --backup ./omp-usage-backup.db     # online backup
omp-usage-exporter --retention-days 30                # delete fully imported files after 30 days
```

Requires Node.js 22 or later. `omp-usage-exporter --help` lists every flag and its environment variable.

## Endpoints

| Path           | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| `GET /metrics` | Prometheus text format                                         |
| `GET /healthz` | `200` when the last import succeeded recently, `503` otherwise |

## Main metrics

`omp_llm_tokens_total{provider,model,direction}`, `omp_llm_requests_total{provider,model,status}`, `omp_llm_reported_cost_usd_total`, `omp_llm_reasoning_tokens_total`, `omp_llm_usage_missing_total`, `omp_llm_cost_missing_total`, `omp_llm_stop_reasons_total`, plus `omp_usage_*` health metrics.

Documentation, Prometheus configuration and Grafana dashboards: https://tommasomarchionni.github.io/omp-usage/ · License: MIT
