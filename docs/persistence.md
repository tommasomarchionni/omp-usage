# Persistence & Recovery

## Data Storage

### Events Directory (Plugin)

```
~/.local/state/omp-usage/events/
├── <sessionRunId>.jsonl
└── ...
```

- **Format**: JSONL (one JSON object per line)
- **One file per OMP session** (identified by `sessionRunId`)
- **Append-only**: Plugin never modifies existing lines
- **Permissions**: `0o700` directory, `0o600` files

### SQLite Database (Exporter)

```
~/.local/state/omp-usage/exporter.db
├── events table
├── cursors table
├── aggregates table
├── operational_metrics table
└── schema_info table
```

- **WAL mode** for concurrent read/write
- **Foreign keys**: Not enforced (single writer)
- **Indexes**: On `session_run_id`, `timestamp`, `provider,model`

## Backup

### Events Directory

```bash
# Simple copy (plugin only appends, safe to copy)
cp -r ~/.local/state/omp-usage/events ~/backups/omp-usage-events-$(date +%Y%m%d)

# Or rsync for incremental
rsync -av ~/.local/state/omp-usage/events/ /backup/omp-usage-events/
```

### SQLite Database

```bash
# Online backup (safe while exporter running)
sqlite3 ~/.local/state/omp-usage/exporter.db ".backup /backup/exporter-$(date +%Y%m%d).db"

# Or use sqlite3 backup API (recommended for production)
```

### Automated Backup (cron)

```bash
# /etc/cron.daily/omp-usage-backup
#!/bin/bash
set -euo pipefail
DATE=$(date +%Y%m%d)
BACKUP_DIR="/backup/omp-usage"
mkdir -p "$BACKUP_DIR"

# Events
rsync -av ~/.local/state/omp-usage/events/ "$BACKUP_DIR/events-$DATE/"

# Database (online backup)
sqlite3 ~/.local/state/omp-usage/exporter.db ".backup $BACKUP_DIR/exporter-$DATE.db"

# Retain last 30 days
find "$BACKUP_DIR" -type f -name "exporter-*.db" -mtime +30 -delete
find "$BACKUP_DIR" -type d -name "events-*" -mtime +30 -exec rm -rf {} +
```

## Recovery

### Restore Events Directory

```bash
# Stop plugin (close OMP) and exporter
# Restore from backup
rm -rf ~/.local/state/omp-usage/events
cp -r ~/backups/omp-usage-events-20260115 ~/.local/state/omp-usage/events

# Restart exporter (will re-import from cursors=0)
```

### Restore Database

```bash
# Stop exporter
# Restore database
cp ~/backups/exporter-20260115.db ~/.local/state/omp-usage/exporter.db

# Restart exporter
```

### Point-in-Time Recovery

Not supported in v1 (no WAL archiving). For PITR, use filesystem snapshots (APFS, ZFS, LVM).

## Filesystem Considerations

### Network Filesystems (NFS, SMB)

**Not recommended** for events directory or database:
- File locking unreliable
- Cursor tracking (inode/device) breaks
- Performance issues

**If required**:
- Use local storage for events and database
- Sync to network storage via cron/rsync

### Symlinks

Events directory and database path **can be symlinks**:
```bash
ln -s /mnt/fast-ssd/omp-events ~/.local/state/omp-usage/events
ln -s /mnt/fast-ssd/exporter.db ~/.local/state/omp-usage/exporter.db
```

**Caveats**:
- Cursor inode/device tracking follows symlink target
- Ensure target filesystem supports inode/device
- Permissions apply to target, not symlink

### macOS Specific

- **APFS snapshots**: Use `tmutil` for point-in-time recovery
- **Time Machine**: Automatically backs up `~/.local/state/`
- **iCloud**: Do NOT use iCloud-synced folder for database (locking issues)

## Retention

### Events Files

Plugin creates one file per OMP session. No automatic cleanup.

**Manual cleanup**:
```bash
# Delete events older than 30 days
find ~/.local/state/omp-usage/events -name "*.jsonl" -mtime +30 -delete
```

**Recommended**: Keep at least 7 days for exporter re-import capability.

### Database

Exporter never deletes events or aggregates. Database grows over time.

**Size estimate**: ~1 KB per event (with raw JSON)

| Events/day | DB size/month |
|------------|---------------|
| 1,000 | ~30 MB |
| 10,000 | ~300 MB |
| 100,000 | ~3 GB |

**Manual cleanup** (advanced):
```sql
-- Delete events older than 90 days (keep aggregates)
DELETE FROM events WHERE timestamp < datetime('now', '-90 days');

-- Vacuum to reclaim space
VACUUM;
```

## Migration

### Schema Upgrades

Exporter tracks schema version in `schema_info` table. On startup:
1. Checks `PRAGMA user_version`
2. Runs migrations if needed
3. Updates version

**Adding columns**: Use `ALTER TABLE` in migration.
**Breaking changes**: Increment `SCHEMA_VERSION`, write migration.

### Moving to New Machine

1. Copy events directory and database
2. Install exporter on new machine
3. Start exporter (resumes from cursors)

## Disaster Recovery Checklist

- [ ] Events directory backed up daily
- [ ] Database backed up daily (online backup)
- [ ] Backup retention ≥ 30 days
- [ ] Restore procedure tested quarterly
- [ ] Monitoring alerts for:
  - Exporter down
  - Import errors > threshold
  - Disk space < 10%
  - Label cardinality > 80%