# omp-usage

OMP usage tracking plugin and Prometheus exporter for [Oh My Pi](https://github.com/can1357/oh-my-pi).

## Overview

This project provides two npm packages:

| Package | Description |
|---------|-------------|
| `@tommasomarchionni/omp-usage` | OMP plugin that collects usage events |
| `@tommasomarchionni/omp-usage-exporter` | Node.js service that imports events and exposes Prometheus metrics |

## Architecture

```
┌─────────────┐    JSONL files    ┌─────────────┐    HTTP    ┌─────────────┐
│   OMP       │ ────────────────▶ │  Exporter   │ ─────────▶ │ Prometheus  │
│  (plugin)   │  ~/.local/state/  │  (Node.js)  │  /metrics  │             │
└─────────────┘  omp-usage/events │             │            └─────────────┘
                            ▲      └─────────────┘
                            │
                            │  SQLite
                            ▼
                       ┌─────────────┐
                       │  exporter.db │
                       └─────────────┘
```

- **Plugin**: Runs inside OMP, writes one JSONL file per session to a configurable directory. No HTTP calls.
- **Exporter**: Independent Node.js service. Scans the events directory, imports into SQLite, serves `/metrics`.
- **No direct communication** between plugin and exporter.

## Quick Start

### 1. Install the plugin

Add to your OMP configuration:

```json
{
  "omp": {
    "extensions": ["@tommasomarchionni/omp-usage"]
  }
}
```

### 2. Run the exporter

```bash
npx @tommasomarchionni/omp-usage-exporter
```

The exporter starts on `http://127.0.0.1:9464` with:
- `GET /metrics` — Prometheus metrics
- `GET /healthz` — Health check

### 3. Configure Prometheus

```yaml
scrape_configs:
  - job_name: omp_usage
    static_configs:
      - targets: ['192.168.188.50:9464']
```

### 4. Import the Grafana dashboard

See [Grafana](grafana.md) for the dashboard JSON.

## Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `omp_llm_tokens_total` | Counter | provider, model, direction |
| `omp_llm_reasoning_tokens_total` | Counter | provider, model |
| `omp_llm_requests_total` | Counter | provider, model, status |
| `omp_llm_reported_cost_usd_total` | Counter | provider, model |
| `omp_llm_usage_missing_total` | Counter | provider, model |

Plus operational metrics: import errors, invalid records, last import timestamp.

## Requirements

- Node.js 20+ (LTS)
- OMP 18.8.6+ (tested)
- SQLite (via `better-sqlite3`, native build required)

## License

[MIT](../LICENSE) © Tommaso Marchionni