# Prometheus Configuration

## Scrape Config

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: omp_usage
    static_configs:
      - targets: ['exporter.example.internal:9464']
        labels:
          environment: production
          host: exporter-primary
    scrape_interval: 30s
    scrape_timeout: 10s
    metrics_path: /metrics
```

### Multiple Exporters

```yaml
scrape_configs:
  - job_name: omp_usage
    static_configs:
      - targets: ['exporter-primary.internal:9464']
        labels:
          host: exporter-primary
          role: primary
      - targets: ['exporter-secondary.internal:9464']
        labels:
          host: exporter-secondary
          role: secondary
```

## Relabeling (Optional)

Add instance/host labels from target:

```yaml
scrape_configs:
  - job_name: omp_usage
    static_configs:
      - targets: ['exporter.example.internal:9464']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
        regex: '([^:]+):.*'
        replacement: '${1}'
```

## Example configuration, rules and alerts

[`examples/prometheus/`](https://github.com/tommasomarchionni/omp-usage/tree/main/examples/prometheus)
contains files that CI checks with `promtool`:

| File                         | Content                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prometheus.yml`             | Scrape config for job `omp_usage` and the existing llama.cpp job `llm` (example address).                                                                             |
| `rules/omp-usage.rules.yml`  | Optional recording rules: token, request, reported cost and equivalent cost rates, daily cost, error ratio.                                                           |
| `rules/omp-usage.alerts.yml` | Alerts: exporter down, import stale or failing, invalid records, label overflow, unresolved prices, stale price catalog, high error rate, daily spend, usage missing. |
| `tests/omp-usage.test.yml`   | `promtool test rules` unit tests for the alerts and the equivalent cost rule.                                                                                         |

```bash
promtool check rules examples/prometheus/rules/*.yml
promtool test rules examples/prometheus/tests/omp-usage.test.yml
```

Thresholds are starting points. `OmpLlmDailySpendHigh` uses 20 USD per day:
change it to your budget. The Grafana dashboards do not need the recording
rules; see [Grafana](grafana.md).

## Service Discovery (Optional)

For dynamic environments:

```yaml
scrape_configs:
  - job_name: omp_usage
    file_sd_configs:
      - files:
          - targets/omp_usage/*.json
        refresh_interval: 30s
```

Example target file (`targets/omp_usage/mac-mini.json`):

```json
[
  {
    "targets": ["exporter.example.internal:9464"],
    "labels": {
      "host": "exporter-primary",
      "environment": "production"
    }
  }
]
```

## Remote Write (Optional)

For long-term storage:

```yaml
remote_write:
  - url: https://prometheus.example.com/api/v1/write
    queue_config:
      max_samples_per_send: 10000
      max_shards: 200
      capacity: 25000
```

## Verification

Test scrape:

```bash
curl -s http://exporter.example.internal:9464/metrics | grep omp_llm
```

Check target status in Prometheus UI:

- Status → Targets → `omp_usage` job
- Should show `UP` with recent scrape

## Retention

Recommended retention for usage metrics:

- **Raw samples**: 14 days (enough for hourly/daily rates)
- **Downsampled (1h)**: 1 year (for trend analysis)

```yaml
# prometheus.yml
storage:
  tsdb:
    retention.time: 14d
    retention.size: 50GB
```

For longer retention, use remote write to Thanos, Cortex, or Mimir.
