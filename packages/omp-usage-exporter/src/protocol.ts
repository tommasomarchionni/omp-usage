export const SCHEMA_VERSION = 1;

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cost: UsageCost;
}

export interface UsageEvent {
  schemaVersion: number;
  eventId: string;
  sessionRunId: string;
  timestamp: string;
  eventType: "assistant_message_end";
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | null;
  usage: Usage | null;
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  event?: UsageEvent;
  errors?: ValidationError[];
}

export interface ExporterConfig {
  eventsDir: string;
  dbPath: string;
  listen: string;
  maxLineLength: number;
  logLevel: "debug" | "info" | "warn" | "error";
  maxLabelCardinality: number;
}

export interface FileCursor {
  filePath: string;
  offset: number;
  fileSize: number;
  inode: number;
  device: number;
  mtimeMs: number;
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
  reportedCostUsd: number;
  usageMissing: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateEventShape(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { valid: false, errors: [{ path: "", message: "Event must be an object", code: "invalid_type" }] };
  }

  const event = value as Partial<UsageEvent>;
  if (typeof event.schemaVersion !== "number") {
    return { valid: false, errors: [{ path: "schemaVersion", message: "schemaVersion must be a number", code: "invalid_type" }] };
  }
  if (typeof event.eventId !== "string" || event.eventId.length === 0) {
    return { valid: false, errors: [{ path: "eventId", message: "eventId must be a non-empty string", code: "invalid_type" }] };
  }
  if (typeof event.sessionRunId !== "string" || event.sessionRunId.length === 0) {
    return { valid: false, errors: [{ path: "sessionRunId", message: "sessionRunId must be a non-empty string", code: "invalid_type" }] };
  }
  if (typeof event.timestamp !== "string" || event.timestamp.length === 0) {
    return { valid: false, errors: [{ path: "timestamp", message: "timestamp must be a non-empty string", code: "invalid_type" }] };
  }
  if (event.eventType !== "assistant_message_end") {
    return {
      valid: false,
      errors: [{ path: "eventType", message: "eventType must be assistant_message_end", code: "invalid_value" }],
    };
  }

  return { valid: true, event: event as UsageEvent };
}

export function validateJsonlLine(line: string): ValidationResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { valid: false, errors: [{ path: "", message: "Empty line", code: "empty_line" }] };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return validateEventShape(parsed);
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: "", message: error instanceof Error ? error.message : "Invalid JSON", code: "invalid_json" }],
    };
  }
}