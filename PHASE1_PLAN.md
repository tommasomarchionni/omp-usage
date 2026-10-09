# Phase 1 Plan: omp-usage Repository Structure & Design

## Reference Repository Conventions (from `tommasomarchionni/github-runner`)

| Convention | Implementation |
|------------|----------------|
| Configuration via environment | `.env.example` with all vars documented |
| Documentation | `docs/` with MkDocs; operational, troubleshooting, testing, security, shutdown, persistence docs |
| Tests & CI | GitHub Actions: lint, typecheck, unit tests, build, smoke test; local `./tests/run-tests.sh` |
| Changelog | `CHANGELOG.md` (Keep a Changelog format) |
| Contributing | `CONTRIBUTING.md` with PR checklist |
| Security | `SECURITY.md` with private reporting flow |
| Code of Conduct | `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) |
| License | MIT with correct attribution |
| Graceful shutdown | SIGINT/SIGTERM handling, cleanup before exit |
| Persistence & recovery | Documented procedures, self-healing patterns |

## Project Structure (npm workspaces)

```
omp-usage/
├── package.json                 # Root: private, workspaces, scripts
├── tsconfig.base.json           # Shared TS config
├── .eslintrc.cjs                # Shared ESLint config
├── .prettierrc                  # Shared Prettier config
├── .gitignore
├── .env.example                 # All env vars documented
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── LICENSE                      # MIT © Tommaso Marchionni
├── README.md
├── docs/
│   ├── index.md
│   ├── installation.md
│   ├── configuration.md
│   ├── plugin.md
│   ├── exporter.md
│   ├── metrics.md
│   ├── prometheus.md
│   ├── grafana.md
│   ├── launchd.md
│   ├── troubleshooting.md
│   ├── persistence.md
│   ├── shutdown.md
│   └── testing.md
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── publish.yml         # Disabled initially
│   │   └── smoke-test.yml
│   ├── dependabot.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── ISSUE_TEMPLATE/
├── packages/
│   ├── omp-usage/               # @tommasomarchionni/omp-usage
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts         # Plugin entry point
│   │   │   ├── events.ts        # Event schema & validation
│   │   │   ├── writer.ts        # JSONL writer with queue/flush
│   │   │   ├── lifecycle.ts     # OMP lifecycle hooks
│   │   │   └── types.ts         # Shared protocol types
│   │   ├── tests/
│   │   └── .npmignore
│   ├── omp-usage-protocol/      # Internal protocol package (not published separately)
│   │   ├── package.json         # Private, version tied to root
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── schema.ts        # Zod/ArkType schema v1
│   │   │   ├── types.ts         # TypeScript types
│   │   │   └── validate.ts      # Runtime validation
│   │   └── tests/
│   └── omp-usage-exporter/      # @tommasomarchionni/omp-usage-exporter
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── cli.ts           # CLI entry (--help, --version)
│       │   ├── config.ts        # Config from env + flags
│       │   ├── server.ts        # HTTP server (/metrics, /healthz)
│       │   ├── importer.ts      # JSONL → SQLite import
│       │   ├── database.ts      # SQLite schema, migrations, cursors
│       │   ├── metrics.ts       # prom-client metrics
│       │   ├── shutdown.ts      # Graceful shutdown
│       │   └── types.ts
│       ├── tests/
│       └── .npmignore
└── tests/                       # Integration tests
    └── e2e.test.ts
```

## Package Details

### 1. `@tommasomarchionni/omp-usage` (Plugin)

**Manifest** (`package.json` `omp.extensions`):
```json
{ "omp": { "extensions": ["./dist/index.js"] } }
```

**Entry point** (`src/index.ts`):
```typescript
export default function extension(api: OmpApi): void
```

**OMP Types** (from `@oh-my-pi/pi-catalog/types`):
- `Usage`: input, output, cacheRead, cacheWrite, totalTokens, reasoningTokens, cost
- `AssistantMessage`: provider, model, api, stopReason, usage
- `StopReason`: "stop" | "length" | "toolUse" | "error" | "aborted"

**Event Schema v1** (validated at runtime):
```typescript
interface UsageEvent {
  schemaVersion: 1;
  eventId: string;           // UUID v4
  sessionRunId: string;      // UUID v4 per OMP start
  timestamp: string;         // ISO 8601 UTC
  eventType: "assistant_message_end";
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: StopReason | null;
  usage: Usage | null;       // Null = absent, not zero
}
```

**Writer** (`src/writer.ts`):
- Configurable directory: `OMP_USAGE_EVENTS_DIR` (default `~/.local/state/omp-usage/events`)
- One file per session: `<sessionRunId>.jsonl`
- Append-only, complete JSON lines, ordered
- In-memory queue with configurable max (default 1000)
- Non-blocking: drop/queue full → log warning, don't block agent turn
- Restrictive permissions: dir 0o700, files 0o600
- Flush on: interval (1s), queue threshold, OMP shutdown hook
- Document: crash between flushes loses unflushed events

**Lifecycle** (`src/lifecycle.ts`):
- Use verified OMP hooks only (no invented events)
- `api.on("shutdown", ...)` if exists, else `process.on("exit")`
- Verify subagent/direct plugin coverage; document findings

### 2. `@tommasomarchionni/omp-usage-protocol` (Internal)

- Zod schema for v1 events
- TypeScript types exported
- Runtime validation with detailed errors
- Version negotiation ready for future

### 3. `@tommasomarchionni/omp-usage-exporter` (Node.js Service)

**Node.js Version**: 20 LTS (Iron) — supported until 2026-10, then 22 LTS

**CLI** (`src/cli.ts`):
```bash
omp-usage-exporter --help
omp-usage-exporter --version
omp-usage-exporter --config-check
```

**Config** (`src/config.ts`): flags > env > defaults
| Flag | Env | Default |
|------|-----|---------|
| `--events-dir` | `OMP_USAGE_EVENTS_DIR` | `~/.local/state/omp-usage/events` |
| `--db-path` | `OMP_USAGE_DB_PATH` | `~/.local/state/omp-usage/exporter.db` |
| `--listen` | `OMP_USAGE_LISTEN` | `127.0.0.1:9464` |
| `--max-line-length` | `OMP_USAGE_MAX_LINE_LENGTH` | `1048576` (1 MiB) |
| `--log-level` | `OMP_USAGE_LOG_LEVEL` | `info` |

**HTTP Server** (`src/server.ts`):
- `GET /metrics` — Prometheus metrics (prom-client)
- `GET /healthz` — `{ status: "ok", lastImport: ISO8601 | null }`
- No event file exposure
- Bind 127.0.0.1 default; LAN bind requires explicit config

**Database** (`src/database.ts`):
- SQLite (better-sqlite3)
- Tables: `events`, `cursors`, `aggregates`
- `eventId` UNIQUE constraint
- Import transaction: INSERT event + UPDATE aggregates + UPDATE cursor
- WAL mode, busy_timeout 5000
- Single-writer: advisory lock or `PRAGMA locking_mode=EXCLUSIVE`

**Importer** (`src/importer.ts`):
- Scan events dir for `*.jsonl`
- Track cursor per file (byte offset)
- Read only complete lines; preserve partial tail
- Handle: renamed, truncated, replaced files
- Unknown schema version → log, skip, continue
- Malformed line → log, increment `omp_usage_import_errors_total`, continue
- Batch commits (e.g., 100 events)

**Metrics** (`src/metrics.ts`):

| Metric | Type | Labels |
|--------|------|--------|
| `omp_llm_tokens_total` | Counter | provider, model, direction (input/output/cache_read/cache_write) |
| `omp_llm_reasoning_tokens_total` | Counter | provider, model |
| `omp_llm_requests_total` | Counter | provider, model, status (success/error) |
| `omp_llm_reported_cost_usd_total` | Counter | provider, model |
| `omp_llm_usage_missing_total` | Counter | provider, model |
| `omp_usage_import_errors_total` | Counter | reason (schema/malformed/io) |
| `omp_usage_invalid_records_total` | Counter | reason |
| `omp_usage_last_import_timestamp` | Gauge | — |

**Cardinality limits**:
- Max unique (provider, model) pairs: 1000 (configurable)
- Excess: aggregate into `_other` bucket, log warning
- Events NOT dropped from DB; only label cardinality limited

**Accounting Rules** (enforced in importer):
- Reasoning ⊆ output: never add to output again
- Never sum totalTokens into input/output
- error stopReason → requests{status="error"}
- usage null ≠ zero; missing → `omp_llm_usage_missing_total`
- error with non-zero usage → count tokens + error request
- Reported cost ≠ invoice; separate from computed equivalent cost
- No automatic tariff in v1
- Document: `increase()` aligns to scrape, not event timestamp
- Historical import ≠ Prometheus backfill
- OMP + llama.cpp: don't double-count; document separation

**Shutdown** (`src/shutdown.ts`):
- SIGINT/SIGTERM: stop HTTP, finish pending import batch, close DB
- Timeout: 30s then force exit

**Launchd** (example):
```xml
<!-- ~/Library/LaunchAgents/com.tommasomarchionni.omp-usage-exporter.plist -->
<key>Label</key><string>com.tommasomarchionni.omp-usage-exporter</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/omp-usage-exporter</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/var/log/omp-usage-exporter.log</string>
<key>StandardErrorPath</key><string>/var/log/omp-usage-exporter.err.log</string>
```

## Dependencies

| Package | Dependencies |
|---------|--------------|
| Root | typescript, eslint, prettier, vitest, @types/node, npm-run-all |
| omp-usage | zod (or arktype), uuid, @oh-my-pi/pi-catalog (types only, peer) |
| omp-usage-protocol | zod, typescript |
| omp-usage-exporter | better-sqlite3, prom-client, zod, uuid, commander |

**Native deps**: `better-sqlite3` (needs Python + build tools on macOS arm64/Linux)

## Risks & Unknowns

| Risk | Mitigation |
|------|------------|
| OMP types not on npm | Use `npm link` or local tarball; vendor types if needed |
| OMP lifecycle hooks unverified | Test on OMP 18.8.6; document actual hooks |
| Subagent coverage unknown | Test with subagent calls; document gap |
| better-sqlite3 build failures | Document Python/build-tool requirements; test CI on ubuntu-latest + macos-latest |
| Cardinality explosion | Configurable limit + `_other` bucket; alert on threshold |
| Network filesystem (events dir) | Document symlink/NFS caveats; use local disk |

## Test Criteria (Phase 1)

| Test | Method |
|------|--------|
| Plugin loads on OMP 18.8.6 | Manual + probe |
| Events written to JSONL | File inspection |
| Schema validation rejects invalid | Unit test |
| Writer queue non-blocking | Stress test |
| File permissions 0o600/0o700 | Stat check |
| Exporter CLI --help/--version | Unit test |
| Config precedence (flag > env > default) | Unit test |
| SQLite UNIQUE constraint | Unit test |
| Import idempotent (same eventId) | Unit test |
| Partial line handling | Unit test |
| Metrics exposed on /metrics | HTTP test |
| Graceful shutdown | Signal test |

## What Could NOT Be Verified

- [ ] OMP 18.8.6 exact lifecycle hook names (only `message_end` verified via probe)
- [ ] Subagent / direct plugin call coverage
- [ ] GitHub Copilot / other provider event shapes
- [ ] npm package name availability (`@tommasomarchionni/omp-usage*`)
- [ ] Port 9464 availability on target Mac (192.168.188.50)
- [ ] better-sqlite3 build on macOS arm64 without Xcode CLI tools
- [ ] Prometheus scrape interval vs `increase()` semantics in practice

## Next Steps (Phase 2)

After approval:
1. Initialize repo with root package.json, workspaces, configs
2. Create protocol package with schema v1
3. Implement plugin with writer, lifecycle, tests
4. Verify on OMP 18.8.6