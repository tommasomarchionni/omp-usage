# Graceful Shutdown

## Plugin Shutdown

The plugin listens for OMP's `session_shutdown` event (handlers run concurrently with a **2-second budget**, see the [OMP extension docs](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)). It writes any pending events synchronously, then stops accepting new ones.

Versions up to 0.3.1 registered a handler for `shutdown`, an event OMP never emits. Their final flush only happened if the 1-second timer fired before exit.

Because events are written right after each `message_end` handler, the shutdown flush normally has nothing left to do. A synchronous flush on process `exit` covers the remaining case.

## Exporter Shutdown

On `SIGINT` or `SIGTERM` the exporter runs these steps in order, once:

1. **HTTP**: stop accepting connections, close idle keep-alive sockets immediately (Prometheus keeps them open), let in-flight scrapes finish, destroy remaining sockets after `min(5 s, timeout/2)`.
2. **Importer**: stop timers and the file watcher, then wait for the in-flight batch to commit. No transaction is left open, and the cursor always points just after the last committed line.
3. **Database**: `wal_checkpoint(TRUNCATE)`, close SQLite, release the `.lock` file.
4. Exit with code 0.

If the sequence exceeds `--shutdown-timeout-ms` (default 10 s) the process exits with code 1. A second signal during shutdown forces an immediate exit.

`uncaughtException` triggers the same sequence and exits with code 1.

### Crash safety

`SIGKILL`, power loss or a crash never corrupts counts:

- A batch is committed atomically or not at all (SQLite WAL, `synchronous=NORMAL`).
- After restart the importer resumes from the last committed cursor.
- Lines re-read after a crash are deduplicated by `eventId`.

The integration suite kills the exporter with `SIGTERM` and `SIGKILL` during a 20 000-event import. It then checks that the totals after restart are exact.

## Verification

### Check Clean Shutdown

```bash
# Exporter logs
grep -E "(Shutdown|Shutdown complete)" /var/log/omp-usage-exporter.log

# Database integrity
sqlite3 ~/.local/state/omp-usage/exporter.db "PRAGMA integrity_check;"
# Should return "ok"
```

### Check Plugin Flush

```bash
# Last event timestamp in file
tail -n 1 ~/.local/state/omp-usage/events/*.jsonl | jq .timestamp

# Compare to OMP shutdown time
```

## Best Practices

1. **Always use graceful shutdown** (SIGTERM, not SIGKILL)
2. **Allow more than `--shutdown-timeout-ms`** in process managers
3. **Monitor shutdown duration** in logs
4. **Test shutdown** regularly in staging
5. **Don't kill -9** unless process is truly stuck

## Process Manager Config

### systemd
```ini
[Service]
KillSignal=SIGTERM
TimeoutStopSec=20
```

### launchd
```xml
<key>RunAtLoad</key><true/>
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
</dict>
```

### Docker
```dockerfile
STOPSIGNAL SIGTERM
# Default stop timeout is 10s, increase if needed
# docker stop --time=30 container
```

## What Gets Lost on Forced Shutdown

| Component | Data at Risk |
|-----------|--------------|
| Plugin | Only events of the handler running at kill time (pending retries if the disk was failing) |
| Exporter batch | Nothing: uncommitted lines are re-read after restart |
| SQLite WAL | Uncheckpointed pages (recovered on next open) |
| HTTP requests | In-flight `/metrics` responses (client gets error) |

**Events in SQLite**: Never lost (durable after commit).