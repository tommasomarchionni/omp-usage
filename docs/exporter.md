# Exporter

The Node.js exporter (`@tommasomarchionni/omp-usage-exporter`) imports JSONL event files, stores them in SQLite, and exposes Prometheus metrics.

## How It Works

1. **Scans events directory** — Finds all `*.jsonl` files
2. **Imports incrementally** — Tracks cursor per file (byte offset), only reads new lines
3. **Stores in SQLite** — Events, aggregates, and cursors in a local database
4. **Exposes `/metrics`** — Prometheus-compatible metrics endpoint
5. **Handles shutdown** — Graceful stop on SIGINT/SIGTERM

## Command Line Interface

```bash
omp-usage-exporter [options]

Options:
  --events-dir <path>           Events directory (env: OMP_USAGE_EVENTS_DIR)
  --db-path <path>              SQLite database path (env: OMP_USAGE_DB_PATH)
  --listen <host:port>          HTTP listen address (env: OMP_USAGE_LISTEN)
  --max-line-length <bytes>     Max line length (env: OMP_USAGE_MAX_LINE_LENGTH)
  --log-level <level>           Log level: debug, info, warn, error
  --max-label-cardinality <n>   Max (provider,model) pairs (env: OMP_USAGE_MAX_LABEL_CARDINALITY)
  --config-check                Validate config and exit
  --import-once                 Import all files once and exit
  -h, --help                    Show help
  -V, --version                 Show version
```

## Import Process

### File Discovery

- Scans `eventsDir` for `*.jsonl` files
- Processes files in alphabetical order
- Tracks cursor per file (byte offset, inode, device, mtime)

### Line Reading

- Reads only complete lines (terminated by `\n`)
- Preserves incomplete trailing line for next import
- Enforces `maxLineLength` (default 1 MiB) — longer lines are skipped

### Event Validation

Each line is validated against schema v1:
- Valid events → imported, aggregates updated
- Invalid JSON → skipped, `import_errors_malformed` incremented
- Unknown schema version → skipped, `import_errors_unknown_schema` incremented
- Line too long → skipped, `import_errors_line_too_long` incremented

### Deduplication

- `eventId` has UNIQUE constraint in SQLite
- Duplicate `eventId` → skipped, cursor still advanced
- Safe to re-import same files

### Transactional Import

Each batch (100 events) is atomic:
```
BEGIN IMMEDIATE;
  INSERT OR IGNORE INTO events ...
  UPDATE aggregates ...
  UPDATE cursors ...
COMMIT;
```

### File Handling

| File Change | Behavior |
|-------------|----------|
| Appended lines | New lines imported |
| Truncated | Cursor reset, re-read from start |
| Renamed | Detected via inode/device mismatch, treated as new file |
| Replaced | Detected via size/mtime change, treated as new file |
| Deleted | Cursor remains, no error |

## Database Schema

### `events` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | TEXT UNIQUE | Event UUID |
| `session_run_id` | TEXT | Session UUID |
| `timestamp` | TEXT | ISO 8601 |
| `event_type` | TEXT | Event type |
| `provider` | TEXT | Provider name |
| `model` | TEXT | Model identifier |
| `api` | TEXT | API transport |
| `stop_reason` | TEXT | Stop reason |
| `usage_*` | INTEGER/REAL | Flattened usage fields |
| `raw_json` | TEXT | Full event JSON |

### `cursors` table

| Column | Type | Description |
|--------|------|-------------|
| `file_path` | TEXT PK | Absolute file path |
| `offset` | INTEGER | Byte offset of last imported line |
| `file_size` | INTEGER | File size at last read |
| `inode` | INTEGER | Inode for rename detection |
| `device` | INTEGER | Device ID for rename detection |
| `mtime_ms` | INTEGER | Modification time (ms) |

### `aggregates` table

| Column | Type | Description |
|--------|------|-------------|
| `provider` | TEXT PK | Provider name |
| `model` | TEXT PK | Model identifier |
| `input_tokens` | INTEGER | Sum of input tokens |
| `output_tokens` | INTEGER | Sum of output tokens |
| `cache_read_tokens` | INTEGER | Sum of cache read tokens |
| `cache_write_tokens` | INTEGER | Sum of cache write tokens |
| `reasoning_tokens` | INTEGER | Sum of reasoning tokens |
| `requests_success` | INTEGER | Successful requests |
| `requests_error` | INTEGER | Error requests |
| `reported_cost_usd` | REAL | Sum of reported costs |
| `usage_missing` | INTEGER | Events with null usage |

### `operational_metrics` table

Key-value store for exporter metrics (import errors, last import timestamp, etc.)

## HTTP Endpoints

### `GET /metrics`

Prometheus metrics in text format. Includes:
- LLM metrics (tokens, requests, cost)
- Operational metrics (import errors, invalid records, last import)

### `GET /healthz`

Health check endpoint:
```json
{
  "status": "ok",
  "lastImport": "2026-01-15T10:30:00.000Z",
  "timestamp": "2026-01-15T10:30:00.000Z"
}
```

## Graceful Shutdown

On SIGINT/SIGTERM:
1. Stop accepting HTTP connections
2. Wait for in-flight requests (max 30s)
3. Stop importer (finish current batch)
4. Close SQLite database
5. Exit

## Single Instance Guarantee

The exporter uses SQLite's file locking. Running two exporters on the same database will cause the second to fail with "database is locked". Use a process manager (systemd, launchd) to ensure single instance.

## Performance Notes

- **Batch size**: 100 events per transaction
- **Flush interval**: 1 second (plugin side)
- **Import rate**: ~10,000 events/second on SSD
- **Database size**: ~1 KB per event (with raw JSON)
- **Memory**: ~50 MB baseline + queue

## Troubleshooting

### Database locked

```bash
# Check for other processes
lsof ~/.local/state/omp-usage/exporter.db
```

### Import stuck

Check logs for:
- Large files (increase `maxLineLength`)
- Malformed lines (check source)
- Disk space

### High memory

Reduce batch size or increase flush frequency.

### Missing metrics

- Check `/healthz` for last import timestamp
- Verify events directory has new files
- Check exporter logs for errors