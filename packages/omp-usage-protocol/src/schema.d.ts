import { z } from "zod";
/**
 * Schema version for the event protocol.
 * Increment when making breaking changes to the event structure.
 */
export declare const SCHEMA_VERSION: 1;
/**
 * Supported event types. Currently only one, but extensible.
 */
export declare const EventTypeSchema: z.ZodEnum<["assistant_message_end"]>;
/**
 * Stop reason from the OMP assistant message.
 * Matches the StopReason type from @oh-my-pi/pi-catalog/types.
 */
export declare const StopReasonSchema: z.ZodEnum<["stop", "length", "toolUse", "error", "aborted"]>;
/**
 * Usage data as reported by OMP.
 * Based on the Usage type from @oh-my-pi/pi-catalog/types.
 * All fields are optional to distinguish absent from zero.
 */
export declare const UsageSchema: z.ZodObject<{
    /** Non-cached conversation input tokens */
    input: z.ZodOptional<z.ZodNumber>;
    /** Total conversation output tokens including thinking */
    output: z.ZodOptional<z.ZodNumber>;
    /** Conversation tokens read from prompt cache */
    cacheRead: z.ZodOptional<z.ZodNumber>;
    /** Conversation tokens written to prompt cache */
    cacheWrite: z.ZodOptional<z.ZodNumber>;
    /** Sum of input + output + cacheRead + cacheWrite + orchestration */
    totalTokens: z.ZodOptional<z.ZodNumber>;
    /** Provider-reported occupied context tokens */
    contextTokens: z.ZodOptional<z.ZodNumber>;
    /** Orchestration tokens (billed but not conversation) */
    orchestration: z.ZodOptional<z.ZodObject<{
        input: z.ZodOptional<z.ZodNumber>;
        cacheRead: z.ZodOptional<z.ZodNumber>;
        output: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
    }, {
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
    }>>;
    /** Copilot premium-request counter */
    premiumRequests: z.ZodOptional<z.ZodNumber>;
    /** Reasoning/thinking tokens included in output */
    reasoningTokens: z.ZodOptional<z.ZodNumber>;
    /** Cache-write TTL breakdown (Anthropic only) */
    cttl: z.ZodOptional<z.ZodObject<{
        ephemeral5m: z.ZodOptional<z.ZodNumber>;
        ephemeral1h: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        ephemeral5m?: number | undefined;
        ephemeral1h?: number | undefined;
    }, {
        ephemeral5m?: number | undefined;
        ephemeral1h?: number | undefined;
    }>>;
    /** Server-side tool invocations */
    server: z.ZodOptional<z.ZodObject<{
        webSearch: z.ZodOptional<z.ZodNumber>;
        webFetch: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        webSearch?: number | undefined;
        webFetch?: number | undefined;
    }, {
        webSearch?: number | undefined;
        webFetch?: number | undefined;
    }>>;
    /** Provider-reported credit meter values */
    credits: z.ZodOptional<z.ZodObject<{
        cost: z.ZodOptional<z.ZodNumber>;
        committedCost: z.ZodOptional<z.ZodNumber>;
        acuCost: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        cost?: number | undefined;
        committedCost?: number | undefined;
        acuCost?: number | undefined;
    }, {
        cost?: number | undefined;
        committedCost?: number | undefined;
        acuCost?: number | undefined;
    }>>;
    /** Reported cost breakdown */
    cost: z.ZodObject<{
        input: z.ZodNumber;
        output: z.ZodNumber;
        cacheRead: z.ZodNumber;
        cacheWrite: z.ZodNumber;
        total: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    }, {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    }>;
}, "strip", z.ZodTypeAny, {
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    totalTokens?: number | undefined;
    contextTokens?: number | undefined;
    orchestration?: {
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
    } | undefined;
    premiumRequests?: number | undefined;
    reasoningTokens?: number | undefined;
    cttl?: {
        ephemeral5m?: number | undefined;
        ephemeral1h?: number | undefined;
    } | undefined;
    server?: {
        webSearch?: number | undefined;
        webFetch?: number | undefined;
    } | undefined;
    credits?: {
        cost?: number | undefined;
        committedCost?: number | undefined;
        acuCost?: number | undefined;
    } | undefined;
}, {
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    totalTokens?: number | undefined;
    contextTokens?: number | undefined;
    orchestration?: {
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
    } | undefined;
    premiumRequests?: number | undefined;
    reasoningTokens?: number | undefined;
    cttl?: {
        ephemeral5m?: number | undefined;
        ephemeral1h?: number | undefined;
    } | undefined;
    server?: {
        webSearch?: number | undefined;
        webFetch?: number | undefined;
    } | undefined;
    credits?: {
        cost?: number | undefined;
        committedCost?: number | undefined;
        acuCost?: number | undefined;
    } | undefined;
}>;
/**
 * Full event schema v1.
 * All fields required except those explicitly optional.
 */
export declare const UsageEventSchema: z.ZodObject<{
    /** Protocol schema version */
    schemaVersion: z.ZodLiteral<1>;
    /** Unique event identifier (UUID v4) */
    eventId: z.ZodString;
    /** Session run identifier (UUID v4), same for all events in one OMP startup */
    sessionRunId: z.ZodString;
    /** Event timestamp in UTC ISO 8601 */
    timestamp: z.ZodString;
    /** Event type discriminator */
    eventType: z.ZodEnum<["assistant_message_end"]>;
    /** Provider name (e.g., "openrouter", "anthropic") */
    provider: z.ZodNullable<z.ZodString>;
    /** Model identifier as reported by OMP (e.g., "openrouter/free", "claude-3-opus") */
    model: z.ZodNullable<z.ZodString>;
    /** API transport used (e.g., "openrouter", "anthropic-messages") */
    api: z.ZodNullable<z.ZodString>;
    /** Why the generation stopped */
    stopReason: z.ZodNullable<z.ZodEnum<["stop", "length", "toolUse", "error", "aborted"]>>;
    /** Usage data, or null if not reported by the provider */
    usage: z.ZodNullable<z.ZodObject<{
        /** Non-cached conversation input tokens */
        input: z.ZodOptional<z.ZodNumber>;
        /** Total conversation output tokens including thinking */
        output: z.ZodOptional<z.ZodNumber>;
        /** Conversation tokens read from prompt cache */
        cacheRead: z.ZodOptional<z.ZodNumber>;
        /** Conversation tokens written to prompt cache */
        cacheWrite: z.ZodOptional<z.ZodNumber>;
        /** Sum of input + output + cacheRead + cacheWrite + orchestration */
        totalTokens: z.ZodOptional<z.ZodNumber>;
        /** Provider-reported occupied context tokens */
        contextTokens: z.ZodOptional<z.ZodNumber>;
        /** Orchestration tokens (billed but not conversation) */
        orchestration: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodNumber>;
            cacheRead: z.ZodOptional<z.ZodNumber>;
            output: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            input?: number | undefined;
            output?: number | undefined;
            cacheRead?: number | undefined;
        }, {
            input?: number | undefined;
            output?: number | undefined;
            cacheRead?: number | undefined;
        }>>;
        /** Copilot premium-request counter */
        premiumRequests: z.ZodOptional<z.ZodNumber>;
        /** Reasoning/thinking tokens included in output */
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        /** Cache-write TTL breakdown (Anthropic only) */
        cttl: z.ZodOptional<z.ZodObject<{
            ephemeral5m: z.ZodOptional<z.ZodNumber>;
            ephemeral1h: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            ephemeral5m?: number | undefined;
            ephemeral1h?: number | undefined;
        }, {
            ephemeral5m?: number | undefined;
            ephemeral1h?: number | undefined;
        }>>;
        /** Server-side tool invocations */
        server: z.ZodOptional<z.ZodObject<{
            webSearch: z.ZodOptional<z.ZodNumber>;
            webFetch: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            webSearch?: number | undefined;
            webFetch?: number | undefined;
        }, {
            webSearch?: number | undefined;
            webFetch?: number | undefined;
        }>>;
        /** Provider-reported credit meter values */
        credits: z.ZodOptional<z.ZodObject<{
            cost: z.ZodOptional<z.ZodNumber>;
            committedCost: z.ZodOptional<z.ZodNumber>;
            acuCost: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            cost?: number | undefined;
            committedCost?: number | undefined;
            acuCost?: number | undefined;
        }, {
            cost?: number | undefined;
            committedCost?: number | undefined;
            acuCost?: number | undefined;
        }>>;
        /** Reported cost breakdown */
        cost: z.ZodObject<{
            input: z.ZodNumber;
            output: z.ZodNumber;
            cacheRead: z.ZodNumber;
            cacheWrite: z.ZodNumber;
            total: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        }, {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        }>;
    }, "strip", z.ZodTypeAny, {
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
        totalTokens?: number | undefined;
        contextTokens?: number | undefined;
        orchestration?: {
            input?: number | undefined;
            output?: number | undefined;
            cacheRead?: number | undefined;
        } | undefined;
        premiumRequests?: number | undefined;
        reasoningTokens?: number | undefined;
        cttl?: {
            ephemeral5m?: number | undefined;
            ephemeral1h?: number | undefined;
        } | undefined;
        server?: {
            webSearch?: number | undefined;
            webFetch?: number | undefined;
        } | undefined;
        credits?: {
            cost?: number | undefined;
            committedCost?: number | undefined;
            acuCost?: number | undefined;
        } | undefined;
    }, {
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
        totalTokens?: number | undefined;
        contextTokens?: number | undefined;
        orchestration?: {
            input?: number | undefined;
            output?: number | undefined;
            cacheRead?: number | undefined;
        } | undefined;
        premiumRequests?: number | undefined;
        reasoningTokens?: number | undefined;
        cttl?: {
            ephemeral5m?: number | undefined;
            ephemeral1h?: number | undefined;
        } | undefined;
        server?: {
            webSearch?: number | undefined;
            webFetch?: number | undefined;
        } | undefined;
        credits?: {
            cost?: number | undefined;
            committedCost?: number | undefined;
            acuCost?: number | undefined;
        } | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: 1;
    eventId: string;
    sessionRunId: string;
    timestamp: string;
    eventType: "assistant_message_end";
    provider: string | null;
    model: string | null;
    api: string | null;
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | null;
    usage: {
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
        totalTokens?: number | undefined;
        contextTokens?: number | undefined;
        orchestration?: {
            input?: number | undefined;
            output?: number | undefined;
            cacheRead?: number | undefined;
        } | undefined;
        premiumRequests?: number | undefined;
        reasoningTokens?: number | undefined;
        cttl?: {
            ephemeral5m?: number | undefined;
            ephemeral1h?: number | undefined;
        } | undefined;
        server?: {
            webSearch?: number | undefined;
            webFetch?: number | undefined;
        } | undefined;
        credits?: {
            cost?: number | undefined;
            committedCost?: number | undefined;
            acuCost?: number | undefined;
        } | undefined;
    } | null;
}, {
    schemaVersion: 1;
    eventId: string;
    sessionRunId: string;
    timestamp: string;
    eventType: "assistant_message_end";
    provider: string | null;
    model: string | null;
    api: string | null;
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | null;
    usage: {
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
        totalTokens?: number | undefined;
        contextTokens?: number | undefined;
        orchestration?: {
            input?: number | undefined;
            output?: number | undefined;
            cacheRead?: number | undefined;
        } | undefined;
        premiumRequests?: number | undefined;
        reasoningTokens?: number | undefined;
        cttl?: {
            ephemeral5m?: number | undefined;
            ephemeral1h?: number | undefined;
        } | undefined;
        server?: {
            webSearch?: number | undefined;
            webFetch?: number | undefined;
        } | undefined;
        credits?: {
            cost?: number | undefined;
            committedCost?: number | undefined;
            acuCost?: number | undefined;
        } | undefined;
    } | null;
}>;
/**
 * TypeScript type inferred from the schema.
 */
export type UsageEvent = z.infer<typeof UsageEventSchema>;
/**
 * Input for creating a new event (without generated fields).
 */
export type UsageEventInput = Omit<UsageEvent, "schemaVersion" | "eventId" | "sessionRunId" | "timestamp"> & {
    timestamp?: string;
};
/**
 * Validate an event object, returning parsed result or throwing.
 */
export declare function validateEvent(data: unknown): UsageEvent;
/**
 * Safe validation that returns a result object instead of throwing.
 */
export declare function safeValidateEvent(data: unknown): {
    success: true;
    data: UsageEvent;
} | {
    success: false;
    error: z.ZodError;
};
//# sourceMappingURL=schema.d.ts.map