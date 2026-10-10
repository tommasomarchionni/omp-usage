# launchd (macOS)

Run the exporter as a managed background service on macOS using launchd.

## Plist Configuration

Create `~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tommasomarchionni.omp-usage-exporter</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/omp-usage-exporter</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>StandardOutPath</key>
    <string>/var/log/omp-usage-exporter.log</string>

    <key>StandardErrorPath</key>
    <string>/var/log/omp-usage-exporter.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>OMP_USAGE_EVENTS_DIR</key>
        <string>/Users/yourname/.local/state/omp-usage/events</string>
        <key>OMP_USAGE_DB_PATH</key>
        <string>/Users/yourname/.local/state/omp-usage/exporter.db</string>
        <key>OMP_USAGE_LISTEN</key>
        <string>127.0.0.1:9464</string>
        <key>OMP_USAGE_LOG_LEVEL</key>
        <string>info</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>/Users/yourname</string>

    <key>ProcessType</key>
    <string>Background</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

### Customize These Values

| Key                                     | Change To                                                          |
| --------------------------------------- | ------------------------------------------------------------------ |
| `ProgramArguments`                      | Full path to `omp-usage-exporter` (run `which omp-usage-exporter`) |
| `OMP_USAGE_EVENTS_DIR`                  | Your events directory                                              |
| `OMP_USAGE_DB_PATH`                     | Your database path                                                 |
| `OMP_USAGE_LISTEN`                      | Your listen address (keep `127.0.0.1` for security)                |
| `WorkingDirectory`                      | Your home directory                                                |
| `StandardOutPath` / `StandardErrorPath` | Your preferred log location                                        |

## Installation

```bash
# Create log directory
sudo mkdir -p /var/log
sudo touch /var/log/omp-usage-exporter.log /var/log/omp-usage-exporter.err.log
sudo chown $(whoami) /var/log/omp-usage-exporter.log /var/log/omp-usage-exporter.err.log

# Install plist
mkdir -p ~/Library/LaunchAgents
cp com.tommasomarchionni.omp-usage-exporter.plist ~/Library/LaunchAgents/

# Load service
launchctl load ~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist

# Start now
launchctl start com.tommasomarchionni.omp-usage-exporter
```

## Management Commands

```bash
# Check status
launchctl list | grep omp-usage

# View logs
tail -f /var/log/omp-usage-exporter.log
tail -f /var/log/omp-usage-exporter.err.log

# Stop
launchctl stop com.tommasomarchionni.omp-usage-exporter

# Unload (persistent)
launchctl unload ~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist

# Reload after plist changes
launchctl unload ~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist
launchctl load ~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist
```

## Auto-start on Login

The `RunAtLoad: true` ensures the exporter starts when you log in. For system-wide (boot-time) service, use `/Library/LaunchDaemons` instead (requires root).

## Troubleshooting

### Service won't start

```bash
# Check plist syntax
plutil -lint ~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist

# Check launchd logs
log show --predicate 'subsystem == "com.apple.launchd"' --last 1h
```

### Permission denied on logs

```bash
sudo chown $(whoami) /var/log/omp-usage-exporter.log /var/log/omp-usage-exporter.err.log
```

### Binary not found

```bash
# Use full path in ProgramArguments
which omp-usage-exporter
# Or if installed via npm:
ls -la $(npm root -g)/@tommasomarchionni/omp-usage-exporter/bin/
```

### Port already in use

```bash
lsof -i :9464
# Kill existing process or change OMP_USAGE_LISTEN
```

## Alternative: launchctl CLI

For ad-hoc runs without plist:

```bash
# Run once (exits after import)
launchctl submit -l omp-usage-exporter -- /usr/local/bin/omp-usage-exporter --import-once

# Run as service (requires plist for proper management)
```

## Security Notes

- Default binds to `127.0.0.1:9464` (localhost only)
- No authentication on `/metrics` — ensure network access is controlled
- Logs may contain file paths — restrict log file permissions if needed
- Database file contains usage history — restrict `exporter.db` permissions
