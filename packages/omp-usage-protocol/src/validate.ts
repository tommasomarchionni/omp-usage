import {
  UsageEventSchema,
  UsageEvent,
  UsageEventInput,
  SCHEMA_VERSION,
} from "./schema.js";
import { randomUUID } from "crypto";
export interface ValidationResult {
  valid: boolean;
  event?: UsageEvent;
  errors?: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export function validateEventDetailed(data: unknown): ValidationResult {
  const result = UsageEventSchema.safeParse(data);
  if (result.success) {
    return { valid: true, event: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  };
}

export function validateEvents(
  data: unknown[],
): { valid: UsageEvent[]; invalid: { index: number; errors: ValidationError[] }[] } {
  const valid: UsageEvent[] = [];
  const invalid: { index: number; errors: ValidationError[] }[] = [];

  for (let i = 0; i < data.length; i++) {
    const result = validateEventDetailed(data[i]);
    if (result.valid && result.event) {
      valid.push(result.event);
    } else {
      invalid.push({ index: i, errors: result.errors ?? [] });
    }
  }

  return { valid, invalid };
}

export function validateJsonlLine(line: string): ValidationResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { valid: false, errors: [{ path: "", message: "Empty line", code: "empty_line" }] };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return validateEventDetailed(parsed);
  } catch (e) {
    return {
      valid: false,
      errors: [{ path: "", message: e instanceof Error ? e.message : "Invalid JSON", code: "invalid_json" }],
    };
  }
}

export function checkSchemaVersion(event: UsageEvent): boolean {
  return event.schemaVersion === SCHEMA_VERSION;
}

export function sanitizeForLog(event: UsageEvent): UsageEvent {
  return event;
}

export function createEvent(input: UsageEventInput): UsageEvent {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: randomUUID(),
    sessionRunId: randomUUID(),
    timestamp: input.timestamp ?? now,
    eventType: input.eventType,
    provider: input.provider,
    model: input.model,
    api: input.api,
    stopReason: input.stopReason,
    usage: input.usage,
  };
}

export function validateUsageAccounting(usage: UsageEvent["usage"]): string[] {
  const warnings: string[] = [];

  if (!usage) {
    return warnings;
  }

  const checkNonNegative = (value: number | undefined, name: string) => {
    if (value !== undefined && (value < 0 || Number.isNaN(value) || !Number.isFinite(value))) {
      warnings.push(`${name} has invalid value: ${value}`);
    }
  };

  checkNonNegative(usage.input, "usage.input");
  checkNonNegative(usage.output, "usage.output");
  checkNonNegative(usage.cacheRead, "usage.cacheRead");
  checkNonNegative(usage.cacheWrite, "usage.cacheWrite");
  checkNonNegative(usage.totalTokens, "usage.totalTokens");
  checkNonNegative(usage.reasoningTokens, "usage.reasoningTokens");
  checkNonNegative(usage.cost?.input, "usage.cost.input");
  checkNonNegative(usage.cost?.output, "usage.cost.output");
  checkNonNegative(usage.cost?.cacheRead, "usage.cost.cacheRead");
  checkNonNegative(usage.cost?.cacheWrite, "usage.cost.cacheWrite");
  checkNonNegative(usage.cost?.total, "usage.cost.total");

  if (
    usage.reasoningTokens !== undefined &&
    usage.output !== undefined &&
    usage.reasoningTokens > usage.output
  ) {
    warnings.push(`reasoningTokens (${usage.reasoningTokens}) exceeds output (${usage.output})`);
  }

  const sumParts =
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0) +
    (usage.orchestration?.input ?? 0) +
    (usage.orchestration?.cacheRead ?? 0) +
    (usage.orchestration?.output ?? 0);
  if (usage.totalTokens !== undefined && usage.totalTokens < sumParts) {
    warnings.push(`totalTokens (${usage.totalTokens}) less than sum of parts (${sumParts})`);
  }

  return warnings;
}

export { UsageEventSchema, SCHEMA_VERSION } from "./schema.js";
export type { UsageEvent, UsageEventInput } from "./schema.js";