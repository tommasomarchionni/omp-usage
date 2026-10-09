import { UsageEvent, UsageEventInput } from "./schema.js";
/**
 * Validation result with detailed error information.
 */
export interface ValidationResult {
    valid: boolean;
    event?: UsageEvent;
    errors?: ValidationError[];
}
/**
 * Structured validation error.
 */
export interface ValidationError {
    path: string;
    message: string;
    code: string;
}
/**
 * Validates a single event with detailed error reporting.
 */
export declare function validateEvent(data: unknown): ValidationResult;
/**
 * Validates multiple events, collecting all valid ones and errors.
 */
export declare function validateEvents(data: unknown[]): {
    valid: UsageEvent[];
    invalid: {
        index: number;
        errors: ValidationError[];
    }[];
};
/**
 * Validates a JSONL line (single line of JSON).
 * Returns null for empty/whitespace lines.
 */
export declare function validateJsonlLine(line: string): ValidationResult;
/**
 * Checks if an event has the expected schema version.
 */
export declare function checkSchemaVersion(event: UsageEvent): boolean;
/**
 * Sanitizes an event for logging (removes potentially sensitive data).
 * Currently a pass-through since events don't contain sensitive data,
 * but provides a hook for future extensions.
 */
export declare function sanitizeForLog(event: UsageEvent): UsageEvent;
/**
 * Creates a new event with generated fields.
 */
export declare function createEvent(input: UsageEventInput): UsageEvent;
/**
 * Validates usage data for accounting rule compliance.
 * Returns warnings for questionable values but doesn't reject.
 */
export declare function validateUsageAccounting(usage: UsageEvent["usage"]): string[];
export { UsageEventSchema, SCHEMA_VERSION } from "./schema.js";
export type { UsageEvent, UsageEventInput } from "./schema.js";
//# sourceMappingURL=validate.d.ts.map