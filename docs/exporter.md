# Exporter

The Node.js exporter (`@tommasomarchionni/omp-usage-exporter`) imports the JSONL event files written by the plugin, stores them in SQLite and exposes Prometheus metrics.

## How it works

1. **Continuous import**: an import cycle runs at startup and then every `--poll-interval-ms` (default 5 s). On filesystems that support it, `fs.watch` triggers a cycle shortly after a file changes. Polling is always active because `fs.watch` is unreliable on network filesystems and some containers (`--no-watch` disables the watcher).
2. **Incremental reads**: a per-file cursor stores the byte offset after the last processed line, so each cycle reads only new bytes.
3. **Atomic batches**: events, aggregates, invalid-record counters and the cursor are committed in one SQLite transaction (500 lines per batch).
4. **Metrics at scrape time**: `/metrics` reads the aggregates from SQLite on every scrape. Counters always match the database, survive restarts and are never double counted.
5. **Graceful shutdown**: on SIGINT/SIGTERM the exporter stops HTTP, finishes the in-flight batch, checkpoints and closes SQLite. See [Shutdown](shutdown.md).

## Command line

```text
omp-usage-exporter [options]

  --events-dir <path>            directory containing event JSONL files [env OMP_USAGE_EVENTS_DIR]
  --db-path <path>               SQLite database path [env OMP_USAGE_DB_PATH]
  --listen <addr>                host:port, [ipv6]:port or :port [env OMP_USAGE_LISTEN]
  --max-line-length <bytes>      maximum JSONL line length [env OMP_USAGE_MAX_LINE_LENGTH]
  --log-level <level>            debug | info | warn | error [env OMP_USAGE_LOG_LEVEL]
  --max-label-cardinality <n>    maximum exported (provider, model) pairs [env OMP_USAGE_MAX_LABEL_CARDINALITY]
  --poll-interval-ms <ms>        interval between import cycles [env OMP_USAGE_POLL_INTERVAL_MS]
  --shutdown-timeout-ms <ms>     graceful shutdown budget [env OMP_USAGE_SHUTDOWN_TIMEOUT_MS]
  --no-watch                     polling only (network filesystems)
  --config-check                 validate configuration, print it as JSON and exit
  --import-once                  run a single import cycle and exit
  --backup <file>                online backup of the database, safe while the service runs
  --rebuild-aggregates           recompute aggregates from stored events and exit
  -V, --version                  print the version
  -h, --help                     show help
```

Exit codes: `0` success, `1` runtime failure (locked database, listen error, import errors with `--import-once`, shutdown timeout), `2` invalid configuration or arguments.

## Import guarantees

| Situation | Behavior |
|---|---|
| Lines appended | Only the new bytes are read |
| Trailing line without `\n` | Left in place; imported once the writer completes it |
| Invalid JSON, schema violation, unknown `schemaVersion`, invalid UTF-8 | Skipped, counted once in `omp_usage_invalid_records_total{reason}`, cursor advances |
| Line longer than `--max-line-length` | Skipped without being loaded in memory, counted as `line_too_long` |
| Blank line | Ignored |
| File truncated (`size < offset`) | Re-read from offset 0 |
| File replaced (different inode/device) | Re-read from offset 0 |
| File rewritten in place (bytes before the cursor changed) | Detected with a SHA-256 of the 256 bytes before the cursor and re-read from 0 |
| File renamed | Treated as a new path, re-read from 0 |
| File deleted | Cursor kept, no error |
| Symlink or non-regular file inside the events directory | Ignored with a warning (opened with `O_NOFOLLOW`) |

Every re-read is safe: `eventId` has a `UNIQUE` constraint and duplicates never update aggregates. Re-reads are counted in `omp_usage_file_resets_total{reason}`.

The events directory itself may be a symlink chosen by you; only entries inside it are restricted.

## Single writer

On startup the exporter takes an OS-level exclusive lock on `<db-path>.lock`, through SQLite with `locking_mode=EXCLUSIVE`. A second exporter on the same database exits with code 1 and the message `locked by another process`. The OS releases the lock if the process crashes, so a stale lock never needs manual cleanup.

The main database stays readable while the exporter runs, for example with `sqlite3` or `--backup`.

## Database schema

`PRAGMA user_version` stores the schema version (currently `2`). Migrations run automatically at startup inside a transaction. A database written by a newer exporter is refused instead of being modified.

| Table | Content |
|---|---|
| `events` | One row per event (`event_id` UNIQUE), flattened usage fields, validated JSON |
| `cursors` | `file_path`, `offset`, `file_size`, `inode`, `device`, `mtime_ms`, `tail_hash` |
| `aggregates` | Per `(provider, model)`: tokens, reasoning, requests by status, reported cost, usage/cost missing |
| `stop_reason_aggregates` | Per `(provider, model, stop_reason)` counts |
| `invalid_records` | Skipped lines by reason |

Events without a provider or model are aggregated under the label value `unknown`. The `events` row keeps `NULL`.

Upgrading from 0.2.x: the v2 migration rebuilds aggregates from `events` and resets cursors. Offsets written by 0.2.x were wrong, so every file is read once more and deduplicated by `eventId`.

## HTTP endpoints

Only `GET`/`HEAD` on two paths are served; every other path returns 404 and other methods return 405. Nothing exposes event files or database content.

### `/metrics`

Prometheus text format. See [Metrics](metrics.md).

### `/healthz`

```json
{
  "status": "ok",
  "database": true,
  "lastImport": "2026-10-10T10:30:00.000Z",
  "lastImportOk": true,
  "lastError": null,
  "timestamp": "2026-10-10T10:30:02.000Z"
}
```

| `status` | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | Database reachable, last cycle succeeded recently |
| `degraded` | 503 | Last cycle had file errors, or no success for `max(3 × poll interval, 60 s)` |
| `unavailable` | 503 | Database not usable |

## Network exposure

The default listener is `127.0.0.1:9464`. Binding any non-loopback address logs a warning at startup. When Prometheus runs on another host, bind the LAN address explicitly (`--listen 192.168.1.50:9464`). Avoid `0.0.0.0` and restrict the port with the macOS firewall or your network. The endpoint has no authentication, but it only exposes aggregated counters labelled by provider and model.

## Performance

| Aspect | Value |
|---|---|
| Batch size | 500 lines per transaction, yielding to the event loop between batches |
| Read buffer | 64 KiB; memory per line bounded by `--max-line-length` |
| Scrape cost | One aggregate query per scrape (one row per provider/model) |
| Database size | ~1 KB per event |

## Troubleshooting

- `locked by another process`: another exporter (often the launchd service) is running. Use `launchctl list | grep omp-usage`.
- Metrics not updating: check `/healthz`, `omp_usage_last_import_timestamp_seconds` and the logs (`--log-level debug`).
- `omp_usage_invalid_records_total` growing: run with `--log-level debug` to see file and byte offset of each skipped line.
