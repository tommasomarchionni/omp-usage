# Troubleshooting

## Plugin Issues

### No events being written

**Symptoms**: Events directory is empty or not created.

**Checks**:

1. Plugin loaded in OMP:
   ```
   # Check OMP logs for:
   [omp-usage] extension loaded
   ```
2. Events directory exists and writable:
   ```bash
   ls -la ~/.local/state/omp-usage/events/
   # Should be drwx------ (0o700)
   ```
3. OMP version ≥ 18.8.6:
   ```bash
   omp --version
   ```
4. File permissions:
   ```bash
   # Directory should be 0o700, files 0o600
   stat ~/.local/state/omp-usage/events/
   ```

**Common causes**:

- Plugin not in OMP config `extensions` array
- OMP version too old (hooks not available)
- Directory permissions prevent write
- Disk full

### Events missing fields (provider/model/api null)

**Symptoms**: Events have `null` for provider, model, or api.

**Explanation**: Some providers or OMP versions may not populate all fields. The plugin records whatever OMP provides — `null` means "not reported" not "zero".

**Action**: Check OMP version and provider. This is expected for some providers.

### High memory usage

**Symptoms**: OMP process memory grows.

**Causes**:

- Event queue filling up (slow disk, high event rate)
- Large events (very long responses)

**Fixes**:

```json
{
  "omp": {
    "extensions": ["./dist/index.js"],
    "config": {
      "@tommasomarchionni/omp-usage": {
        "maxQueueSize": 500,
        "flushIntervalMs": 500
      }
    }
  }
}
```

### Subagent / direct calls not captured

**Status**: Not verified. The plugin only hooks `message_end` from the main conversation. Subagents may use different event paths.

**Workaround**: Test your specific workflow and file an issue with details.

## Exporter Issues

### Exporter won't start

**Check**:

```bash
# Config validation
omp-usage-exporter --config-check

# Check binary
omp-usage-exporter --version

# Check dependencies
node -e "require('better-sqlite3'); require('@prometheus-io/client'); console.log('OK')"
```

**Common errors**:

- `better-sqlite3` not compiled: Run `npm rebuild better-sqlite3`
- Port in use: Change `OMP_USAGE_LISTEN` or kill existing process
- Database locked: Another exporter instance running

### Database locked

```bash
lsof ~/.local/state/omp-usage/exporter.db
# Kill other process or ensure single instance
```

### Import not working

**Symptoms**: `/metrics` shows no data or stale data.

**Checks**:

1. Health endpoint:
   ```bash
   curl http://127.0.0.1:9464/healthz
   # Check lastImport timestamp
   ```
2. Events directory has files:
   ```bash
   ls -la ~/.local/state/omp-usage/events/
   ```
3. Exporter logs for errors:
   ```bash
   tail -f /var/log/omp-usage-exporter.err.log
   ```

**Common causes**:

- Events directory path mismatch (plugin vs exporter)
- Files not `*.jsonl` extension
- Malformed JSONL lines (check with `head -n 1 file.jsonl | jq .`)

### Metrics missing for some models

**Cause**: Label cardinality limit reached (default 1000).

**Check**:

```bash
curl -s http://127.0.0.1:9464/metrics | grep omp_usage_label_cardinality
```

**Fix**: Increase `OMP_USAGE_MAX_LABEL_CARDINALITY` or aggregate less-frequent models.

### High CPU / memory

**Causes**:

- Very large events directory (many files)
- Frequent imports (default scans every 1s)
- Large `maxLineLength`

**Fixes**:

- Increase import interval (not directly configurable, but can reduce scan frequency by moving old files)
- Reduce `maxLineLength` if lines are small
- Archive old event files

## Prometheus Issues

### Target DOWN

**Checks**:

1. Exporter running: `curl http://host:9464/healthz`
2. Network: `telnet host 9464`
3. Prometheus config: `promtool check config prometheus.yml`

### No metrics in Prometheus

**Checks**:

1. Scrape interval > 0
2. Metrics path correct (`/metrics`)
3. Target labels match

### Cardinality explosion in Prometheus

**Cause**: Too many unique (provider, model) pairs.

**Fixes**:

- Increase exporter `maxLabelCardinality`
- Use recording rules to pre-aggregate
- Drop high-cardinality labels in Prometheus relabeling

## Common Error Messages

| Error                               | Meaning                       | Fix                                 |
| ----------------------------------- | ----------------------------- | ----------------------------------- |
| `EACCES: permission denied`         | Can't write events dir        | Fix directory permissions           |
| `SQLITE_BUSY: database is locked`   | Another process using DB      | Ensure single exporter instance     |
| `ENOENT: no such file or directory` | Events dir doesn't exist      | Create dir or fix path              |
| `Line too long`                     | JSONL line exceeds limit      | Increase `maxLineLength`            |
| `Unknown schema version`            | Event has unsupported version | Check plugin/exporter version match |

## Getting Help

1. Check exporter logs: `/var/log/omp-usage-exporter*.log`
2. Run with `--log-level=debug`
3. Validate config with `--config-check`
4. Test import with `--import-once`
5. Open GitHub issue with:
   - OMP version
   - Node.js version
   - Config (sanitized)
   - Relevant logs
   - Steps to reproduce
