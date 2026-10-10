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
├── stop_reason_aggregates table
├── invalid_records table
└── operational_metrics / schema_info tables
~/.local/state/omp-usage/exporter.db.lock   (single-writer lock)
```

- **WAL mode**: readers (sqlite3 CLI, backups) never block the exporter
- **Single writer**: enforced by an OS lock on `exporter.db.lock`, released automatically on crash
- **Schema version**: `PRAGMA user_version`, migrated automatically at startup
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
# Online backup (safe while the exporter is running, file created with mode 0600)
omp-usage-exporter --backup /backup/exporter-$(date +%Y%m%d).db

# Equivalent with the sqlite3 CLI
sqlite3 ~/.local/state/omp-usage/exporter.db ".backup /backup/exporter-$(date +%Y%m%d).db"
```

Never copy `exporter.db` with `cp` while the exporter runs: the WAL file may hold committed transactions that are not yet in the main file.

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
omp-usage-exporter --backup "$BACKUP_DIR/exporter-$DATE.db"

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

# Restart the exporter. Files without a cursor are read from offset 0;
# events already in the database are deduplicated by eventId.
```

### Restore Database

```bash
# Stop the exporter (launchctl bootout ...), then:
rm -f ~/.local/state/omp-usage/exporter.db-wal ~/.local/state/omp-usage/exporter.db-shm
cp ~/backups/exporter-20260115.db ~/.local/state/omp-usage/exporter.db
chmod 600 ~/.local/state/omp-usage/exporter.db
# Restart the exporter: it resumes from the restored cursors and imports
# anything written after the backup.
```

### Rebuild from JSONL

The JSONL files are the source of truth. If the database is lost, delete it and start the exporter: every file is re-imported. Prometheus counters drop and restart from the re-imported totals, which `increase()` handles as a counter reset.

### Rebuild aggregates only

```bash
omp-usage-exporter --rebuild-aggregates   # with the service stopped
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
- Keep the database on local storage (SQLite locking over NFS/SMB is not reliable)
- Run the exporter with `--no-watch` (polling only)
- Expect re-reads if the server changes inode numbers; they are deduplicated

### Symlinks

- The **events directory itself** may be a symlink (it is resolved once per cycle).
- **Entries inside** the events directory that are symlinks, directories, FIFOs or devices are **ignored** with a warning. Files are opened with `O_NOFOLLOW`, so another local user cannot point a `.jsonl` entry at an arbitrary file.
- The database path may be a symlink; keep it on a local filesystem.

### macOS Specific

- **APFS snapshots**: Use `tmutil` for point-in-time recovery
- **Time Machine**: Automatically backs up `~/.local/state/`
- **iCloud**: Do NOT use iCloud-synced folder for database (locking issues)

## Retention

### Events Files

The plugin creates one file per OMP session binding. Nothing is deleted by default.

**Recommended**: `omp-usage-exporter --retention-days 30`. The exporter deletes a file only when its cursor matches the file's inode and device, every byte has been imported, and the file has not been modified for 30 days. Unimported data is never deleted.

Avoid `find ... -mtime +30 -delete`: it does not know whether the exporter imported the files.

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