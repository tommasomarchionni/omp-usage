/**
 * Minimal structural view of the OMP ExtensionAPI used by this plugin.
 * Verified against OMP 18.8.6 and the public extension docs:
 * https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
 *
 * Only the members used here are declared so the plugin keeps working if
 * OMP adds members; unknown payload fields are ignored.
 */
export interface OmpApi {
  on(event: 'message_end', handler: (event: MessageEndEvent) => void | Promise<void>): void;
  /** Runs concurrently with other extensions, with a 2-second budget. */
  on(event: 'session_shutdown', handler: () => void | Promise<void>): void;
  registerCommand?(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
    }
  ): void;
}

export interface MessageEndEvent {
  /** Detached snapshot of the message (OMP docs). Shape is not trusted. */
  message: unknown;
}

export interface ExtensionCommandContext {
  ui?: {
    notify?: (message: string, type?: 'info' | 'warning' | 'error') => void;
  };
}

/** Stop reasons observed in OMP; other strings are passed through. */
export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | (string & {});

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  contextTokens?: number;
  premiumRequests?: number;
  orchestration?: { input?: number; cacheRead?: number; output?: number };
  cttl?: { ephemeral5m?: number; ephemeral1h?: number };
  server?: { webSearch?: number; webFetch?: number };
  credits?: { cost?: number; committedCost?: number; acuCost?: number };
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export type UsageEventType = 'assistant_message_end';

export interface UsageEvent {
  schemaVersion: 1;
  eventId: string;
  sessionRunId: string;
  timestamp: string;
  eventType: UsageEventType;
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: StopReason | null;
  usage: Usage | null;
}

export interface PluginConfig {
  eventsDir: string;
  maxQueueSize: number;
  /** Retry cadence for failed writes; successful writes happen immediately. */
  flushIntervalMs: number;
  fileMode: number;
  dirMode: number;
  /**
   * Delete this plugin's JSONL files older than N days. `null` (default)
   * disables deletion: the plugin cannot know whether the exporter already
   * imported a file. Prefer the exporter's `--retention-days`.
   */
  retentionDays: number | null;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  eventsDir: '',
  maxQueueSize: 1000,
  flushIntervalMs: 1000,
  fileMode: 0o600,
  dirMode: 0o700,
  retentionDays: null,
};

export interface AssistantMessageEvent {
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: StopReason | null;
  usage: Usage | null;
  /** OMP message timestamp (ms), used only for in-process de-duplication. */
  messageTimestamp: number | null;
  /** Number of usage fields dropped because they were not valid numbers. */
  droppedFields: number;
}

export type WriterConfig = PluginConfig;

export interface PluginCleanup {
  (): Promise<void>;
}

export interface WriterStats {
  queued: number;
  written: number;
  dropped: number;
  writeErrors: number;
  bytesWritten: number;
  lastError: string | null;
}
