/**
 * Event protocol used by the exporter.
 *
 * The schema lives in the internal `@tommasomarchionni/omp-usage-protocol`
 * workspace package and is bundled into `dist/cli.js` at build time, so the
 * published exporter has a single source of truth for validation and does not
 * depend on an unpublished package at runtime.
 */
import {
  SCHEMA_VERSION,
  UsageEventSchema,
  type UsageEvent,
} from '@tommasomarchionni/omp-usage-protocol';

export { SCHEMA_VERSION, UsageEventSchema, type UsageEvent };

export type InvalidReason =
  'invalid_json' | 'invalid_schema' | 'unknown_schema_version' | 'line_too_long' | 'invalid_utf8';

export type ParseResult =
  { ok: true; event: UsageEvent } | { ok: false; reason: InvalidReason; message: string };

/**
 * Parses and validates one JSONL line (without the trailing newline).
 * Never throws.
 */
export function parseEventLine(line: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid_json',
      message: e instanceof Error ? e.message : 'Invalid JSON',
    };
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schemaVersion' in parsed &&
    typeof (parsed as { schemaVersion: unknown }).schemaVersion === 'number' &&
    (parsed as { schemaVersion: number }).schemaVersion !== SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: 'unknown_schema_version',
      message: `Unsupported schemaVersion ${(parsed as { schemaVersion: number }).schemaVersion}`,
    };
  }

  const result = UsageEventSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      reason: 'invalid_schema',
      message: issue
        ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
        : 'Schema validation failed',
    };
  }
  return { ok: true, event: result.data };
}

export interface FileCursor {
  filePath: string;
  /** Byte offset just after the last fully processed line. */
  offset: number;
  fileSize: number;
  inode: number;
  device: number;
  mtimeMs: number;
  /** sha256 of up to 256 bytes preceding `offset`; detects in-place rewrites. */
  tailHash?: string | null;
}

export interface AggregatedMetrics {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requestsSuccess: number;
  requestsError: number;
  requestsAborted: number;
  reportedCostUsd: number;
  usageMissing: number;
  costMissing: number;
}

export interface StopReasonAggregate {
  provider: string;
  model: string;
  stopReason: string;
  count: number;
}
