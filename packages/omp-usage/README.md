# @tommasomarchionni/omp-usage

[Oh My Pi](https://github.com/can1357/oh-my-pi) extension that records **LLM usage metadata** (provider, model, tokens, reported cost, stop reason) as local JSONL files. Pair it with [`@tommasomarchionni/omp-usage-exporter`](https://www.npmjs.com/package/@tommasomarchionni/omp-usage-exporter) to get Prometheus metrics and Grafana dashboards.

## Install

```bash
omp plugin install @tommasomarchionni/omp-usage
```

Events are written to `~/.local/state/omp-usage/events/<sessionRunId>.jsonl` (override with `OMP_USAGE_EVENTS_DIR`).

## Privacy

Only whitelisted usage fields are written. Message content, tool input/output, headers and API keys are never recorded, and nothing is sent over the network.

## Reliability

- Events are written right after each `message_end`, and flushed synchronously on `session_shutdown`.
- Write failures are retried; anything dropped is counted in `/omp-usage status`.
- The plugin never throws into OMP.
- Retention is **off** by default. Use `omp-usage-exporter --retention-days N`, which only deletes files that are fully imported.

## Commands

```text
/omp-usage status
/omp-usage retention [N|off]
/omp-usage prune
```

Documentation: https://tommasomarchionni.github.io/omp-usage/plugin/ · License: MIT
