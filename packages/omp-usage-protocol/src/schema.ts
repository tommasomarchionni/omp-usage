import { z } from 'zod';

/**
 * Schema version for the event protocol.
 * Increment when making breaking changes to the event structure.
 */
export const SCHEMA_VERSION = 1 as const;

/**
 * Supported event types. Currently only one, but extensible.
 */
export const EventTypeSchema = z.enum(['assistant_message_end']);

/**
 * Stop reason from the OMP assistant message.
 * Matches the StopReason type from @oh-my-pi/pi-catalog/types.
 */
export const KNOWN_STOP_REASONS = ['stop', 'length', 'toolUse', 'error', 'aborted'] as const;

/**
 * Any short string is accepted so that a new stop reason introduced by OMP
 * does not make whole events invalid; the known values are listed above.
 */
export const StopReasonSchema = z.string().min(1).max(64);

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
  /**
   * Reported cost breakdown (USD). Optional: a provider that does not report
   * cost is recorded as "cost missing", never as zero.
   */
  cost: z
    .object({
      input: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional(),
      total: z.number().nonnegative().optional(),
    })
    .optional(),
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
  provider: z.string().max(256).nullable(),
  /** Model identifier as reported by OMP (e.g., "openrouter/free", "claude-3-opus") */
  model: z.string().max(256).nullable(),
  /** API transport used (e.g., "openrouter", "anthropic-messages") */
  api: z.string().max(256).nullable(),
  /** Why the generation stopped */
  stopReason: StopReasonSchema.nullable(),
  /** Usage data, or null if not reported by the provider */
  usage: UsageSchema.nullable(),
});

/**
 * TypeScript type inferred from the schema.
 */
export type UsageEvent = z.infer<typeof UsageEventSchema>;

/**
 * Input for creating a new event (without generated fields).
 */
export type UsageEventInput = Omit<
  UsageEvent,
  'schemaVersion' | 'eventId' | 'sessionRunId' | 'timestamp'
> & {
  timestamp?: string; // Optional, will be generated if not provided
};

/**
 * Validate an event object, returning parsed result or throwing.
 */
export function validateEvent(data: unknown): UsageEvent {
  return UsageEventSchema.parse(data);
}

/**
 * Safe validation that returns a result object instead of throwing.
 */
export function safeValidateEvent(
  data: unknown
): { success: true; data: UsageEvent } | { success: false; error: z.ZodError } {
  const result = UsageEventSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
