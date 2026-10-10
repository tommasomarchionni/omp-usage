# omp-usage

[![CI](https://github.com/tommasomarchionni/omp-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/tommasomarchionni/omp-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OMP usage tracking plugin and Prometheus exporter for [Oh My Pi](https://github.com/can1357/oh-my-pi).

Live documentation: https://tommasomarchionni.github.io/omp-usage/

## Packages

| Package | Description |
|---------|-------------|
| `@tommasomarchionni/omp-usage` | OMP plugin that collects usage events |
| `@tommasomarchionni/omp-usage-exporter` | Node.js service that imports events and exposes Prometheus metrics |

## Quick Start

### 1. Install the plugin

Install with OMP CLI:

```bash
omp plugin install @tommasomarchionni/omp-usage --scope=user
omp plugin list
```

Uninstall when needed:

```bash
omp plugin uninstall @tommasomarchionni/omp-usage --scope=user
```

Project-scoped install (writes into the current project plugin scope):

```bash
omp plugin install @tommasomarchionni/omp-usage --scope=project
```

If you prefer manual configuration, add to your OMP config:

```json
{
  "omp": {
    "extensions": ["@tommasomarchionni/omp-usage"]
  }
}
```

Or for local development:

```json
{
  "omp": {
    "extensions": ["./packages/omp-usage/dist/index.js"]
  }
}
```

### 2. Run the exporter

```bash
npx @tommasomarchionni/omp-usage-exporter
# or locally
npm run build && node packages/omp-usage-exporter/dist/cli.js
```

Global install/uninstall example:

```bash
npm install -g @tommasomarchionni/omp-usage-exporter
omp-usage-exporter
npm uninstall -g @tommasomarchionni/omp-usage-exporter
```

The exporter starts on `http://127.0.0.1:9464` with:
- `GET /metrics` — Prometheus metrics
- `GET /healthz` — Health check

### 3. Configure Prometheus

```yaml
scrape_configs:
  - job_name: omp_usage
    static_configs:
      - targets: ['exporter.example.internal:9464']
```

### 4. Import the Grafana dashboard

See `docs/grafana.md` for the dashboard JSON.

## Documentation

| Topic | Link |
|-------|------|
| Installation | [docs/installation.md](docs/installation.md) |
| Configuration | [docs/configuration.md](docs/configuration.md) |
| Plugin | [docs/plugin.md](docs/plugin.md) |
| Exporter | [docs/exporter.md](docs/exporter.md) |
| Metrics | [docs/metrics.md](docs/metrics.md) |
| Prometheus | [docs/prometheus.md](docs/prometheus.md) |
| Grafana | [docs/grafana.md](docs/grafana.md) |
| launchd (macOS) | [docs/launchd.md](docs/launchd.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Persistence & Recovery | [docs/persistence.md](docs/persistence.md) |
| Shutdown | [docs/shutdown.md](docs/shutdown.md) |
| Testing | [docs/testing.md](docs/testing.md) |

## Release and Publishing

- Versioning and release notes are automated with `release-please`.
- GitHub Releases are created automatically from merged release PRs.
- npm publishing uses npm Trusted Publishing (OIDC) first, with `NPM_TOKEN` fallback configured in CI.

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

[MIT](LICENSE) © Tommaso Marchionni