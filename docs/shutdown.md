# Graceful Shutdown

## Plugin Shutdown

The plugin registers an OMP `shutdown` handler that:
1. Stops accepting new events
2. Flushes the in-memory queue to disk
3. Closes the file handle

```typescript
// In lifecycle.ts
api.on("shutdown", () => {
  await writer.close();
});
```

### Timing

- **Flush interval**: 1 second (default)
- **Max events at risk**: `maxQueueSize` (default 1000)
- **Worst-case loss**: Events in queue at crash time

### OMP Lifecycle Events

Verified on OMP 18.8.6:
- `message_end` — Assistant message completed
- `shutdown` — OMP shutting down

Not verified:
- `session_end` — May not exist
- `extension_unload` — May not exist

## Exporter Shutdown

The exporter handles `SIGINT` and `SIGTERM`:

```
SIGINT/SIGTERM received
        │
        ▼
┌───────────────────┐
│ Stop HTTP server  │ ──▶ Stop accepting new connections
│ (30s timeout)     │     Finish in-flight requests
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Stop Importer     │ ──▶ Finish current batch
│                   │     Don't start new files
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Close Database    │ ──▶ Flush WAL
│                   │     Close file handles
└───────────────────┘
        │
        ▼
   Exit 0
```

### Shutdown Timeout

- **Default**: 30 seconds
- **Configurable**: Not in v1 (hardcoded)
- **Force exit**: After timeout, process exits with code 1

### Signal Handling

```bash
# Graceful stop (SIGTERM)
kill <pid>
# Or
launchctl stop com.tommasomarchionni.omp-usage-exporter
# Or
systemctl stop omp-usage-exporter

# Force stop (SIGKILL) - avoid if possible
kill -9 <pid>
```

### In-Flight Request Handling

- `/metrics` requests: Allowed to complete (typically < 100ms)
- `/healthz` requests: Allowed to complete
- New requests: Rejected after server stop

### Database Integrity

- SQLite WAL mode ensures durability
- `PRAGMA synchronous = NORMAL` (balance of safety/performance)
- On clean shutdown: WAL checkpointed, database consistent
- On crash: WAL replay on next open (automatic)

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
2. **Allow 30s for shutdown** in process managers
3. **Monitor shutdown duration** in logs
4. **Test shutdown** regularly in staging
5. **Don't kill -9** unless process is truly stuck

## Process Manager Config

### systemd
```ini
[Service]
ExecStop=/usr/local/bin/omp-usage-exporter --shutdown
TimeoutStopSec=30
KillSignal=SIGTERM
SendSIGKILL=yes
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
| Plugin queue | Up to `maxQueueSize` events (default 1000) |
| Exporter batch | Current batch (≤ 100 events) |
| SQLite WAL | Uncheckpointed pages (recovered on next open) |
| HTTP requests | In-flight `/metrics` responses (client gets error) |

**Events in SQLite**: Never lost (durable after commit).