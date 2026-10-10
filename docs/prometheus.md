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

## Recording Rules (Optional)

Pre-compute common queries:

```yaml
# rules/omp_usage.yml
groups:
  - name: omp_usage
    interval: 1m
    rules:
      - expr: sum by (provider) (rate(omp_llm_tokens_total[5m]))
        record: omp_usage:tokens_per_provider_per_second
      - expr: sum by (provider, model) (rate(omp_llm_requests_total[5m]))
        record: omp_usage:requests_per_model_per_second
      - expr: sum by (provider, model) (rate(omp_llm_reported_cost_usd_total[1h]))
        record: omp_usage:cost_per_model_per_hour
```

Include in `prometheus.yml`:

```yaml
rule_files:
  - 'rules/omp_usage.yml'
```

## Alerting Rules (Optional)

```yaml
# alerts/omp_usage.yml
groups:
  - name: omp_usage
    rules:
      - alert: OMPUsageExporterDown
        expr: up{job="omp_usage"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: 'OMP Usage Exporter down'
          description: 'Exporter {{ $labels.instance }} has been down for 2 minutes'

      - alert: OMPUsageImportErrors
        expr: increase(omp_usage_import_errors_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'High import error rate'
          description: '{{ $value }} import errors in last 5 minutes'

      - alert: OMPUsageLabelCardinalityHigh
        expr: omp_usage_label_cardinality > 800
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'Label cardinality approaching limit'
          description: 'Current cardinality: {{ $value }} (limit: 1000)'

      - alert: OMPUsageNoRecentImport
        expr: time() - omp_usage_last_import_timestamp_seconds > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'No recent import'
          description: 'Last import was {{ $value | humanizeDuration }} ago'
```

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
