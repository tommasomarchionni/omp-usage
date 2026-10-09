import { z } from "zod";
/**
 * Schema version for the event protocol.
 * Increment when making breaking changes to the event structure.
 */
export const SCHEMA_VERSION = 1;
/**
 * Supported event types. Currently only one, but extensible.
 */
export const EventTypeSchema = z.enum(["assistant_message_end"]);
/**
 * Stop reason from the OMP assistant message.
 * Matches the StopReason type from @oh-my-pi/pi-catalog/types.
 */
export const StopReasonSchema = z.enum(["stop", "length", "toolUse", "error", "aborted"]);
/**
 * Usage data as reported by OMP.
 * Based on the Usage type from @oh-my-pi/pi-catalog/types.
 * All fields are optional to distinguish absent from zero.
 */
export const UsageSchema = z.object({
    /** Non-cached conversation input tokens */
    input: z.number().int().nonnegative().optional(),
    /** Total conversation output tokens including thinking */
    output: z.number().int().nonnegative().optional(),
    /** Conversation tokens read from prompt cache */
    cacheRead: z.number().int().nonnegative().optional(),
    /** Conversation tokens written to prompt cache */
    cacheWrite: z.number().int().nonnegative().optional(),
    /** Sum of input + output + cacheRead + cacheWrite + orchestration */
    totalTokens: z.number().int().nonnegative().optional(),
    /** Provider-reported occupied context tokens */
    contextTokens: z.number().int().nonnegative().optional(),
    /** Orchestration tokens (billed but not conversation) */
    orchestration: z
        .object({
        input: z.number().int().nonnegative().optional(),
        cacheRead: z.number().int().nonnegative().optional(),
        output: z.number().int().nonnegative().optional(),
    })
        .optional(),
    /** Copilot premium-request counter */
    premiumRequests: z.number().int().nonnegative().optional(),
    /** Reasoning/thinking tokens included in output */
    reasoningTokens: z.number().int().nonnegative().optional(),
    /** Cache-write TTL breakdown (Anthropic only) */
    cttl: z
        .object({
        ephemeral5m: z.number().int().nonnegative().optional(),
        ephemeral1h: z.number().int().nonnegative().optional(),
    })
        .optional(),
    /** Server-side tool invocations */
    server: z
        .object({
        webSearch: z.number().int().nonnegative().optional(),
        webFetch: z.number().int().nonnegative().optional(),
    })
        .optional(),
    /** Provider-reported credit meter values */
    credits: z
        .object({
        cost: z.number().nonnegative().optional(),
        committedCost: z.number().nonnegative().optional(),
        acuCost: z.number().nonnegative().optional(),
    })
        .optional(),
    /** Reported cost breakdown */
    cost: z.object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
        total: z.number().nonnegative(),
    }),
});
/**
 * Full event schema v1.
 * All fields required except those explicitly optional.
 */
export const UsageEventSchema = z.object({
    /** Protocol schema version */
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Unique event identifier (UUID v4) */
    eventId: z.string().uuid(),
    /** Session run identifier (UUID v4), same for all events in one OMP startup */
    sessionRunId: z.string().uuid(),
    /** Event timestamp in UTC ISO 8601 */
    timestamp: z.string().datetime({ offset: true }),
    /** Event type discriminator */
    eventType: EventTypeSchema,
    /** Provider name (e.g., "openrouter", "anthropic") */
    provider: z.string().nullable(),
    /** Model identifier as reported by OMP (e.g., "openrouter/free", "claude-3-opus") */
    model: z.string().nullable(),
    /** API transport used (e.g., "openrouter", "anthropic-messages") */
    api: z.string().nullable(),
    /** Why the generation stopped */
    stopReason: StopReasonSchema.nullable(),
    /** Usage data, or null if not reported by the provider */
    usage: UsageSchema.nullable(),
});
/**
 * Validate an event object, returning parsed result or throwing.
 */
export function validateEvent(data) {
    return UsageEventSchema.parse(data);
}
/**
 * Safe validation that returns a result object instead of throwing.
 */
export function safeValidateEvent(data) {
    const result = UsageEventSchema.safeParse(data);
    if (result.success) {
        return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
}
//# sourceMappingURL=schema.js.map