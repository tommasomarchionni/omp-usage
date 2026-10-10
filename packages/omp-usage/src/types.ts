export interface OmpApi {
  on(event: "message_end", handler: (event: { message: AssistantMessage }) => void): void;
  on(event: "shutdown", handler: () => void | Promise<void>): void;
  registerCommand?(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
    },
  ): void;
}

export interface ExtensionCommandContext {
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

export interface AssistantMessage {
  role: "assistant";
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: StopReason | null;
  usage: Usage | null;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type UsageEventType = "assistant_message_end";

export interface UsageEvent {
  schemaVersion: number;
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
  flushIntervalMs: number;
  fileMode: number;
  dirMode: number;
  retentionDays: number | null;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  eventsDir: "",
  maxQueueSize: 1000,
  flushIntervalMs: 1000,
  fileMode: 0o600,
  dirMode: 0o700,
  retentionDays: 30,
};

export interface AssistantMessageEvent {
  provider: string | null;
  model: string | null;
  api: string | null;
  stopReason: StopReason | null;
  usage: Usage | null;
}

export interface WriterConfig {
  eventsDir: string;
  maxQueueSize: number;
  flushIntervalMs: number;
  fileMode: number;
  dirMode: number;
  retentionDays: number | null;
}

export interface PluginCleanup {
  (): Promise<void>;
}