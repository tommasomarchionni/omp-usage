# Plugin

The OMP plugin (`@tommasomarchionni/omp-usage`) runs inside Oh My Pi and collects usage events from assistant messages.

## How It Works

1. **Loads on OMP startup**: the plugin registers handlers through the OMP extension API.
2. **Listens for `message_end`**: when an assistant message completes, the plugin copies **only usage metadata** from the payload. Content, tool input/output, headers and unknown fields are never written.
3. **Writes JSONL immediately**: events are appended as soon as the current OMP handler returns, with one write per batch of complete lines, to a file named `<sessionRunId>.jsonl`.
4. **Flushes on `session_shutdown`**: OMP gives shutdown handlers a 2-second budget, and the flush is synchronous. A synchronous flush on process `exit` is the last resort.
5. **Never affects the agent**: handler errors are caught and counted, and the plugin never throws into OMP.

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

| Field           | Type         | Description                                                                                                                                             |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | integer      | Protocol version (currently 1)                                                                                                                          |
| `eventId`       | UUID v4      | Unique identifier for this event                                                                                                                        |
| `sessionRunId`  | UUID v4      | Same for all events in one OMP startup                                                                                                                  |
| `timestamp`     | ISO 8601 UTC | When the event was created                                                                                                                              |
| `eventType`     | string       | Always `"assistant_message_end"`                                                                                                                        |
| `provider`      | string/null  | Provider name (e.g., `"openrouter"`, `"anthropic"`)                                                                                                     |
| `model`         | string/null  | Model identifier as reported by OMP                                                                                                                     |
| `api`           | string/null  | API transport (e.g., `"openrouter"`, `"anthropic-messages"`)                                                                                            |
| `stopReason`    | string/null  | Why generation stopped: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`; values added by newer OMP versions are passed through (max 64 chars) |
| `usage`         | object/null  | Usage data, or `null` if not reported                                                                                                                   |

### Usage Fields

| Field             | Type             | Description                                                                |
| ----------------- | ---------------- | -------------------------------------------------------------------------- |
| `input`           | integer          | Non-cached conversation input tokens                                       |
| `output`          | integer          | Total conversation output tokens (includes reasoning)                      |
| `cacheRead`       | integer          | Tokens read from prompt cache                                              |
| `cacheWrite`      | integer          | Tokens written to prompt cache                                             |
| `totalTokens`     | integer          | Sum of all token buckets                                                   |
| `reasoningTokens` | integer          | Reasoning/thinking tokens (subset of `output`)                             |
| `cost`            | object, optional | Reported cost breakdown (USD); absent when the provider does not report it |

Every numeric field is validated individually: negative, `NaN`, infinite or non-integer token counts are **dropped** (and counted in `/omp-usage status` as `sanitizedFields`) rather than making the whole event invalid. A missing field is never replaced with zero.

## File Layout

```
~/.local/state/omp-usage/events/
├── 550e8400-e29b-41d4-a716-446655440000.jsonl
├── 660e8400-e29b-41d4-a716-446655440001.jsonl
└── ...
```

Each file contains one JSON object per line (JSONL format).

## Write Behavior

| Aspect    | Behavior                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Latency   | Written at the end of the current tick (microtask), not on a timer                                                                  |
| Atomicity | Each batch is one `write()` of complete `\n`-terminated lines; the exporter ignores a trailing partial line                         |
| File open | `O_APPEND \| O_CREAT \| O_NOFOLLOW` by path for each batch: a deleted file is re-created, a planted symlink is refused              |
| Failure   | Events stay queued (max `OMP_USAGE_MAX_QUEUE_SIZE`, default 1000) and are retried every `OMP_USAGE_FLUSH_INTERVAL_MS` (default 1 s) |
| Overflow  | New events are dropped and counted (`dropped` in `/omp-usage status`)                                                               |
| Replays   | A message carrying the same OMP timestamp, model and token counts is recorded only once per session                                 |

## Retention

**Off by default.** The plugin cannot know whether the exporter has already imported a file, so deleting by age can lose data (for example if the exporter was stopped for longer than the retention period).

Recommended: let the exporter delete files it has fully imported:

```bash
omp-usage-exporter --retention-days 30
```

The plugin retention is still available as an explicit opt-in (`OMP_USAGE_RETENTION_DAYS=14` or `/omp-usage retention 14`). It deletes regular `*.jsonl` files older than N days, except the current session file and symlinks.

### Runtime commands

```text
/omp-usage status          # file, written, queued, dropped, writeErrors, duplicatesSkipped, ...
/omp-usage retention       # show
/omp-usage retention 14    # enable for this session (warning shown)
/omp-usage retention off
/omp-usage prune
```

`status` is shown as a warning when events were dropped or writes failed.

## Permissions

- Directory: `0o700` (owner only)
- Files: `0o600` (owner read/write only)

## Data Loss Scenarios

| Scenario                         | Events lost                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| OMP killed (`SIGKILL`) or crash  | Only events of the handler that was running; earlier events are already on disk (covered by an e2e test) |
| Disk full / unwritable directory | None while the queue has room; retried every second, then counted as `dropped`                           |
| Queue full (1000 events pending) | New events, counted as `dropped`                                                                         |
| `session_shutdown` exceeds 2 s   | Not expected (synchronous local write); the `exit` hook flushes again                                    |

## Verified Provider Coverage

| Provider       | Verified            |
| -------------- | ------------------- |
| OpenRouter     | ✅ Yes (OMP 18.8.6) |
| Anthropic      | ❓ Not tested       |
| GitHub Copilot | ❓ Not tested       |
| OpenAI         | ❓ Not tested       |
| Google         | ❓ Not tested       |
| Ollama         | ❓ Not tested       |

## Subagents

The [OMP extension documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) states that factories are **rebound to every subagent session** (task tool, `agent()`, clones) with a fresh API. Each binding gets its own `sessionRunId` and its own JSONL file, so subagent usage is recorded once, in its own file.

Not verified yet on a real OMP: whether restricted children and direct model calls made by other plugins emit `message_end`. Check with `/omp-usage status` in a subagent and report the result.

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
