# Plugin

The OMP plugin (`@tommasomarchionni/omp-usage`) runs inside Oh My Pi and collects usage events from assistant messages.

## How It Works

1. **Loads on OMP startup** — The plugin registers event handlers via OMP's extension API.
2. **Listens for `message_end`** — When an assistant message completes, the plugin extracts usage data.
3. **Writes JSONL events** — One file per OMP session (`<sessionRunId>.jsonl`) in the configured directory.
4. **Flushes on shutdown** — Ensures all queued events are written before OMP exits.

## Event Schema (v1)

Each event is a JSON object with these fields:

```json
{
  "schemaVersion": 1,
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "sessionRunId": "660e8400-e29b-41d4-a716-446655440001",
  "timestamp": "2026-01-15T10:30:00.000Z",
  "eventType": "assistant_message_end",
  "provider": "openrouter",
  "model": "openrouter/free",
  "api": "openrouter",
  "stopReason": "stop",
  "usage": {
    "input": 11351,
    "output": 83,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 11434,
    "reasoningTokens": 71,
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 0
    }
  }
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | integer | Protocol version (currently 1) |
| `eventId` | UUID v4 | Unique identifier for this event |
| `sessionRunId` | UUID v4 | Same for all events in one OMP startup |
| `timestamp` | ISO 8601 UTC | When the event was created |
| `eventType` | string | Always `"assistant_message_end"` |
| `provider` | string/null | Provider name (e.g., `"openrouter"`, `"anthropic"`) |
| `model` | string/null | Model identifier as reported by OMP |
| `api` | string/null | API transport (e.g., `"openrouter"`, `"anthropic-messages"`) |
| `stopReason` | string/null | Why generation stopped: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"` |
| `usage` | object/null | Usage data, or `null` if not reported |

### Usage Fields

| Field | Type | Description |
|-------|------|-------------|
| `input` | integer | Non-cached conversation input tokens |
| `output` | integer | Total conversation output tokens (includes reasoning) |
| `cacheRead` | integer | Tokens read from prompt cache |
| `cacheWrite` | integer | Tokens written to prompt cache |
| `totalTokens` | integer | Sum of all token buckets |
| `reasoningTokens` | integer | Reasoning/thinking tokens (subset of `output`) |
| `cost` | object | Reported cost breakdown |

## File Layout

```
~/.local/state/omp-usage/events/
├── 550e8400-e29b-41d4-a716-446655440000.jsonl
├── 660e8400-e29b-41d4-a716-446655440001.jsonl
└── ...
```

Each file contains one JSON object per line (JSONL format).

## Queue & Flush Behavior

- **In-memory queue** (default 1000 events)
- **Periodic flush** (default every 1 second)
- **Non-blocking**: If queue is full, new events are dropped (logged as warning)
- **Graceful shutdown**: Flushes queue on OMP shutdown

## Permissions

- Directory: `0o700` (owner only)
- Files: `0o600` (owner read/write only)

## Data Loss Scenarios

| Scenario | Events Lost |
|----------|-------------|
| OMP crashes between flushes | Up to 1 second of events (default) |
| Queue full (1000 events) | New events dropped until flush |
| Disk full | Events not written, logged as error |
| Process killed (SIGKILL) | Unflushed queue lost |

## Verified Provider Coverage

| Provider | Verified |
|----------|----------|
| OpenRouter | ✅ Yes (OMP 18.8.6) |
| Anthropic | ❓ Not tested |
| GitHub Copilot | ❓ Not tested |
| OpenAI | ❓ Not tested |
| Google | ❓ Not tested |
| Ollama | ❓ Not tested |

## Subagent / Direct Plugin Calls

Current status: **Not verified**. The plugin only intercepts `message_end` events from the main OMP conversation. Subagent invocations and direct plugin calls may or may not emit this event. Test and document your specific use case.

## Troubleshooting

### No events written

1. Check plugin loaded: Look for `[omp-usage] extension loaded` in OMP logs
2. Check events directory exists and is writable
3. Verify OMP version is 18.8.6+
4. Check file permissions

### Events missing fields

Some providers may not report all usage fields. The plugin records `null` for missing fields — this is expected behavior.

### High memory usage

Reduce `maxQueueSize` and/or `flushIntervalMs` in plugin config.