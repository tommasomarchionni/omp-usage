import { UsageEventSchema, SCHEMA_VERSION, } from "./schema.js";
/**
 * Validates a single event with detailed error reporting.
 */
export function validateEvent(data) {
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
/**
 * Validates multiple events, collecting all valid ones and errors.
 */
export function validateEvents(data) {
    const valid = [];
    const invalid = [];
    for (let i = 0; i < data.length; i++) {
        const result = validateEvent(data[i]);
        if (result.valid && result.event) {
            valid.push(result.event);
        }
        else {
            invalid.push({ index: i, errors: result.errors ?? [] });
        }
    }
    return { valid, invalid };
}
/**
 * Validates a JSONL line (single line of JSON).
 * Returns null for empty/whitespace lines.
 */
export function validateJsonlLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
        return { valid: false, errors: [{ path: "", message: "Empty line", code: "empty_line" }] };
    }
    try {
        const parsed = JSON.parse(trimmed);
        return validateEvent(parsed);
    }
    catch (e) {
        return {
            valid: false,
            errors: [{ path: "", message: e instanceof Error ? e.message : "Invalid JSON", code: "invalid_json" }],
        };
    }
}
/**
 * Checks if an event has the expected schema version.
 */
export function checkSchemaVersion(event) {
    return event.schemaVersion === SCHEMA_VERSION;
}
/**
 * Sanitizes an event for logging (removes potentially sensitive data).
 * Currently a pass-through since events don't contain sensitive data,
 * but provides a hook for future extensions.
 */
export function sanitizeForLog(event) {
    return event;
}
/**
 * Creates a new event with generated fields.
 */
export function createEvent(input) {
    const now = new Date().toISOString();
    return {
        schemaVersion: SCHEMA_VERSION,
        eventId: crypto.randomUUID(),
        sessionRunId: crypto.randomUUID(),
        timestamp: input.timestamp ?? now,
        eventType: input.eventType,
        provider: input.provider,
        model: input.model,
        api: input.api,
        stopReason: input.stopReason,
        usage: input.usage,
    };
}
/**
 * Validates usage data for accounting rule compliance.
 * Returns warnings for questionable values but doesn't reject.
 */
export function validateUsageAccounting(usage) {
    const warnings = [];
    if (!usage) {
        return warnings;
    }
    // Check for negative or NaN values (should be caught by schema, but double-check)
    const checkNonNegative = (value, name) => {
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
    // Reasoning tokens should not exceed output
    if (usage.reasoningTokens !== undefined &&
        usage.output !== undefined &&
        usage.reasoningTokens > usage.output) {
        warnings.push(`reasoningTokens (${usage.reasoningTokens}) exceeds output (${usage.output})`);
    }
    // Total tokens should be >= input + output + cacheRead + cacheWrite
    const sumParts = (usage.input ?? 0) +
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
//# sourceMappingURL=validate.js.map