# Configuration

All configuration is done via environment variables or CLI flags. CLI flags take precedence over environment variables, which take precedence over defaults.

## Plugin Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OMP_USAGE_EVENTS_DIR` | `~/.local/state/omp-usage/events` | Directory where event JSONL files are written |
| `OMP_USAGE_MAX_QUEUE_SIZE` | `1000` | Maximum in-memory events before new events are dropped |
| `OMP_USAGE_FLUSH_INTERVAL_MS` | `1000` | Flush cadence to append queued events to JSONL |
| `OMP_USAGE_RETENTION_DAYS` | `30` | Retention period for `.jsonl` files; set `off` or `0` to disable |

Example:
```bash
export OMP_USAGE_EVENTS_DIR=/custom/path/events
export OMP_USAGE_MAX_QUEUE_SIZE=2000
export OMP_USAGE_FLUSH_INTERVAL_MS=500
export OMP_USAGE_RETENTION_DAYS=14
```

Or via OMP config (if supported by your OMP version):
```json
{
  "omp": {
    "extensions": ["./dist/index.js"],
    "config": {
      "@tommasomarchionni/omp-usage": {
        "eventsDir": "/custom/path/events"
      }
    }
  }
}
```

## Runtime Commands

The plugin registers `/omp-usage` commands for runtime operations:

```text
/omp-usage status
/omp-usage retention
/omp-usage retention 14
/omp-usage retention off
/omp-usage prune
```

- `status`: shows current queue/file/retention state.
- `retention`: reads or updates retention without restarting OMP.
- `prune`: immediately runs retention cleanup.

## Exporter Configuration

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `--events-dir` | `OMP_USAGE_EVENTS_DIR` | `~/.local/state/omp-usage/events` | Directory to scan for event JSONL files |
| `--db-path` | `OMP_USAGE_DB_PATH` | `~/.local/state/omp-usage/exporter.db` | SQLite database path |
| `--listen` | `OMP_USAGE_LISTEN` | `127.0.0.1:9464` | HTTP listen address (host:port) |
| `--max-line-length` | `OMP_USAGE_MAX_LINE_LENGTH` | `1048576` | Maximum line length for JSONL parsing (bytes) |
| `--log-level` | `OMP_USAGE_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `--max-label-cardinality` | `OMP_USAGE_MAX_LABEL_CARDINALITY` | `1000` | Maximum unique (provider, model) pairs for metrics |

## Configuration Examples

### Development
```bash
export OMP_USAGE_EVENTS_DIR=~/omp-usage/events
export OMP_USAGE_DB_PATH=~/omp-usage/exporter.db
export OMP_USAGE_LISTEN=127.0.0.1:9464
export OMP_USAGE_LOG_LEVEL=debug
omp-usage-exporter
```

### Production (LAN accessible)
```bash
export OMP_USAGE_EVENTS_DIR=/var/lib/omp-usage/events
export OMP_USAGE_DB_PATH=/var/lib/omp-usage/exporter.db
export OMP_USAGE_LISTEN=0.0.0.0:9464
export OMP_USAGE_LOG_LEVEL=info
omp-usage-exporter
```

### Production (localhost only, with custom cardinality)
```bash
export OMP_USAGE_EVENTS_DIR=/var/lib/omp-usage/events
export OMP_USAGE_DB_PATH=/var/lib/omp-usage/exporter.db
export OMP_USAGE_LISTEN=127.0.0.1:9464
export OMP_USAGE_MAX_LABEL_CARDINALITY=500
omp-usage-exporter
```

## Configuration Validation

Validate your configuration without starting the server:

```bash
omp-usage-exporter --config-check
```

Output:
```
Configuration valid:
{
  "eventsDir": "/home/user/.local/state/omp-usage/events",
  "dbPath": "/home/user/.local/state/omp-usage/exporter.db",
  "listen": "127.0.0.1:9464",
  "maxLineLength": 1048576,
  "logLevel": "info",
  "maxLabelCardinality": 1000
}
```

## One-time Import

Import all events and exit without starting the HTTP server:

```bash
omp-usage-exporter --import-once
```

Useful for:
- Backfilling historical data
- Cron jobs
- Testing