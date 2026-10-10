# Installation

## Prerequisites

- Node.js 20 LTS or later
- OMP 18.8.6 or later (tested version)
- macOS, Linux, or Windows with WSL2

## Plugin Installation

### From npm (when published)

```bash
omp plugin install @tommasomarchionni/omp-usage
omp plugin list
```

Uninstall:

```bash
omp plugin uninstall @tommasomarchionni/omp-usage
```

Note: `--scope` is currently supported by OMP only for marketplace installs (`name@marketplace`), not npm package specs.

Then add to your OMP configuration:

```json
{
  "omp": {
    "extensions": ["@tommasomarchionni/omp-usage"]
  }
}
```

### From local build

```bash
git clone https://github.com/tommasomarchionni/omp-usage.git
cd omp-usage
npm install
npm run build
```

Then add to your OMP configuration:

```json
{
  "omp": {
    "extensions": ["/path/to/omp-usage/packages/omp-usage/dist/index.js"]
  }
}
```

Optional local-link workflow with OMP CLI:

```bash
omp plugin link /path/to/omp-usage/packages/omp-usage/dist/index.js
omp plugin uninstall /path/to/omp-usage/packages/omp-usage/dist/index.js
```

## Exporter Installation

### From npm (when published)

```bash
npm install -g @tommasomarchionni/omp-usage-exporter
omp-usage-exporter
npm uninstall -g @tommasomarchionni/omp-usage-exporter
```

### From local build

```bash
cd omp-usage
npm run build
node packages/omp-usage-exporter/dist/cli.js
```

### As a system service (macOS launchd)

See [launchd](launchd.md) for macOS service setup.

### As a system service (Linux systemd)

```ini
# /etc/systemd/system/omp-usage-exporter.service
[Unit]
Description=OMP Usage Exporter
After=network.target

[Service]
Type=simple
User=omp
Environment=OMP_USAGE_EVENTS_DIR=/var/lib/omp-usage/events
Environment=OMP_USAGE_DB_PATH=/var/lib/omp-usage/exporter.db
Environment=OMP_USAGE_LISTEN=127.0.0.1:9464
ExecStart=/usr/local/bin/omp-usage-exporter
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now omp-usage-exporter
```

## Verifying Installation

1. Start OMP with the plugin enabled
2. Generate some assistant messages
3. Check the events directory:

```bash
ls ~/.local/state/omp-usage/events/
# Should show files like: 550e8400-e29b-41d4-a716-446655440000.jsonl
```

4. Start the exporter and check metrics:

```bash
curl http://127.0.0.1:9464/metrics
# Should show omp_llm_* metrics
```

5. Check health endpoint:

```bash
curl http://127.0.0.1:9464/healthz
# {"status":"ok","lastImport":"2026-01-15T10:30:00.000Z","timestamp":"2026-01-15T10:30:00.000Z"}
```