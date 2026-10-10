# Configuration

All configuration is done via environment variables or CLI flags. CLI flags take precedence over environment variables, which take precedence over defaults.

## Plugin Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OMP_USAGE_EVENTS_DIR` | `~/.local/state/omp-usage/events` | Directory where event JSONL files are written |
| `OMP_USAGE_MAX_QUEUE_SIZE` | `1000` | Maximum pending events (only grows while writes fail) before new events are dropped |
| `OMP_USAGE_FLUSH_INTERVAL_MS` | `1000` | Retry interval after a failed write (successful writes are immediate) |
| `OMP_USAGE_RETENTION_DAYS` | `off` | Opt-in deletion of `.jsonl` files older than N days. Prefer the exporter's `--retention-days`, which deletes only fully imported files |

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

Flags take precedence over environment variables, which take precedence over defaults. Empty environment variables are ignored. Numeric values must be plain positive integers (`10abc`, `1e3` or `-1` are rejected with exit code 2).

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `--events-dir` | `OMP_USAGE_EVENTS_DIR` | `~/.local/state/omp-usage/events` | Directory to scan for event JSONL files |
| `--db-path` | `OMP_USAGE_DB_PATH` | `~/.local/state/omp-usage/exporter.db` | SQLite database path (a `<db-path>.lock` file is created next to it) |
| `--listen` | `OMP_USAGE_LISTEN` | `127.0.0.1:9464` | `host:port`, `[ipv6]:port` or `:port` (all interfaces) |
| `--max-line-length` | `OMP_USAGE_MAX_LINE_LENGTH` | `1048576` | Maximum JSONL line length in bytes |
| `--log-level` | `OMP_USAGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `--max-label-cardinality` | `OMP_USAGE_MAX_LABEL_CARDINALITY` | `1000` | Maximum exported `(provider, model)` pairs |
| `--poll-interval-ms` | `OMP_USAGE_POLL_INTERVAL_MS` | `5000` | Interval between import cycles (minimum 100) |
| `--shutdown-timeout-ms` | `OMP_USAGE_SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown budget before exiting with code 1 |
| `--no-watch` | | watcher on | Disable `fs.watch` and rely on polling |
| `--retention-days` | `OMP_USAGE_EXPORTER_RETENTION_DAYS` | off | Delete event files that are **fully imported** and unmodified for N days (checked hourly). Events stay in SQLite |

## Configuration Examples

### Development
```bash
export OMP_USAGE_EVENTS_DIR=~/omp-usage/events
export OMP_USAGE_DB_PATH=~/omp-usage/exporter.db
export OMP_USAGE_LOG_LEVEL=debug
omp-usage-exporter
```

### Prometheus on another host (LAN)

Bind the LAN address of the machine explicitly instead of `0.0.0.0`:

```bash
export OMP_USAGE_LISTEN=192.168.1.50:9464
omp-usage-exporter
```

## Configuration Validation

```bash
omp-usage-exporter --config-check
```

Prints the resolved configuration as JSON on stdout and exits with code 0, or prints `Configuration error: ...` on stderr and exits with code 2.

## One-time Import

```bash
omp-usage-exporter --import-once
```

Runs one import cycle without the HTTP server and exits (code 1 if any file failed). Do not run it while the service is running: the database lock makes it exit with code 1.
