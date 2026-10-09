# Testing

## Test Suite Overview

```bash
# Run all tests
npm run test

# Run specific package tests
npm run test --workspace=@tommasomarchionni/omp-usage
npm run test --workspace=@tommasomarchionni/omp-usage-protocol
npm run test --workspace=@tommasomarchionni/omp-usage-exporter

# Run with coverage
npm run test -- --coverage
```

## Test Categories

### Unit Tests (Vitest)

Located in `src/**/*.test.ts` alongside source files.

| Package | Tests |
|---------|-------|
| Protocol | Schema validation, event creation, accounting rules |
| Plugin | Writer queue/flush, event extraction, lifecycle |
| Exporter | Config, database, importer, metrics, server |

### Integration Tests

Located in `tests/` at repo root.

```bash
# Run integration tests
npm run test:integration
```

**Integration test scenarios**:
1. **End-to-end**: Plugin → JSONL → Exporter → Prometheus
2. **Restart recovery**: Exporter restart re-imports correctly
3. **File rotation**: Handles renamed/truncated/replaced files
4. **Concurrent OMP sessions**: Multiple JSONL files
4. **Schema evolution**: Unknown version handling

### Manual Testing

#### Plugin Verification

```bash
# 1. Build plugin
npm run build --workspace=@tommasomarchionni/omp-usage

# 2. Add to OMP config
cat > ~/.omp/config.json <<EOF
{
  "omp": {
    "extensions": ["/path/to/omp-usage/packages/omp-usage/dist/index.js"]
  }
}
EOF

# 3. Start OMP and generate messages
omp

# 4. Check events
ls ~/.local/state/omp-usage/events/
cat ~/.local/state/omp-usage/events/*.jsonl | head -5
```

#### Exporter Verification

```bash
# 1. Build exporter
npm run build --workspace=@tommasomarchionni/omp-usage-exporter

# 2. Start exporter
node packages/omp-usage-exporter/dist/cli.js --import-once

# 3. Check metrics
curl -s http://127.0.0.1:9464/metrics | grep omp_llm

# 4. Check health
curl -s http://127.0.0.1:9464/healthz | jq .
```

## Test Scenarios (Required)

Per spec, these scenarios MUST pass:

| Scenario | Test Location |
|----------|---------------|
| Successful event with input/output | `protocol/schema.test.ts` |
| Error event with zero tokens | `protocol/schema.test.ts` |
| Error event with non-zero usage | `protocol/schema.test.ts` |
| Missing usage (null) | `protocol/schema.test.ts` |
| Reasoning tokens (no double-count) | `protocol/validate.test.ts` |
| Cache read/write separate | `protocol/schema.test.ts` |
| Duplicate eventId import | `exporter/database.test.ts` |
| Exporter restart | `tests/e2e.test.ts` |
| Incomplete line then completed | `exporter/importer.test.ts` |
| Malformed record between valid | `exporter/importer.test.ts` |
| Unknown schema version | `exporter/importer.test.ts` |
| File truncation/rotation/replace | `tests/e2e.test.ts` |
| Two OMP sessions (two files) | `tests/e2e.test.ts` |
| Crash/rollback during import | `tests/e2e.test.ts` |
| Restore metrics from SQLite | `tests/e2e.test.ts` |
| Label escaping | `exporter/metrics.test.ts` |
| HTTP endpoints + shutdown | `exporter/server.test.ts` |
| npm pack + install | CI: `package-smoke` job |

## Running Tests in CI

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run build
      - run: npm run test
```

## Better-sqlite3 Native Dependency

Tests require `better-sqlite3` compiled for the platform.

### macOS
```bash
# Requires Xcode Command Line Tools
xcode-select --install
npm install
```

### Linux (CI)
```bash
# Ubuntu/Debian
apt-get update && apt-get install -y python3 make g++
npm install
```

### Troubleshooting Build Failures

```bash
# Rebuild native modules
npm rebuild better-sqlite3

# Or delete node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

## Test Data Generators

Helper functions in `tests/fixtures/` (if needed):

```typescript
// tests/fixtures/events.ts
export function createValidEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    sessionRunId: "660e8400-e29b-41d4-a716-446655440001",
    timestamp: new Date().toISOString(),
    eventType: "assistant_message_end",
    provider: "openrouter",
    model: "openrouter/free",
    api: "openrouter",
    stopReason: "stop",
    usage: {
      input: 1000,
      output: 500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...overrides.usage,
    },
    ...overrides,
  };
}
```

## Performance Benchmarks

```bash
# Run benchmarks (if implemented)
npm run bench
```

Expected performance:
- Import: > 10,000 events/second (SSD)
- Metrics generation: < 50ms per scrape
- Database size: ~1 KB/event

## Debugging Tests

```bash
# Run single test file
npx vitest run packages/omp-usage/src/writer.test.ts

# Run with debug output
DEBUG=* npx vitest run packages/omp-usage/src/writer.test.ts

# Watch mode
npx vitest watch
```

## CI Matrix

Test on multiple platforms:

```yaml
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ["20", "22"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: "npm"
      - run: npm ci
      - run: npm run test
```

## Pre-commit Checks

```bash
# Husky runs on commit
npm run lint
npm run typecheck
npm run test
```

## Test Coverage Goals

| Package | Target |
|---------|--------|
| Protocol | 100% (critical schema validation) |
| Plugin | 90% (writer, lifecycle) |
| Exporter | 85% (database, importer, metrics) |

Run coverage:
```bash
npm run test -- --coverage
```

## Publishing Verification

Before publishing, verify:

```bash
# Dry-run pack
npm pack --dry-run --workspaces

# Install from tarball
cd /tmp
npm install /path/to/omp-usage/packages/omp-usage/omp-usage-0.1.0.tgz
npm install /path/to/omp-usage/packages/omp-usage-exporter/omp-usage-exporter-0.1.0.tgz

# Verify CLI
omp-usage-exporter --version
omp-usage-exporter --help
omp-usage-exporter --config-check
```