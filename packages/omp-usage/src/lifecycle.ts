import type { OmpApi } from "./types.js";
import { EventWriter, createPluginConfig } from "./writer.js";
import { createUsageEvent, extractAssistantMessageData } from "./events.js";
import { randomUUID } from "node:crypto";

/**
 * Plugin state for lifecycle management.
 */
interface PluginState {
  sessionRunId: string;
  writer: EventWriter;
  config: ReturnType<typeof createPluginConfig>;
}

/**
 * Initializes the plugin and registers OMP event handlers.
 * Returns cleanup function for shutdown.
 */
export function initializePlugin(api: OmpApi, userConfig: Partial<PluginConfig> = {}): () => Promise<void> {
  const config = createPluginConfig(userConfig);
  const sessionRunId = randomUUID();
  const writer = new EventWriter(sessionRunId, config);

  const state: PluginState = { sessionRunId, writer, config };

  // Handle assistant message end
  api.on("message_end", (event) => {
    handleMessageEnd(event, state);
  });

  // Handle shutdown
  api.on("shutdown", () => {
    handleShutdown(state);
  });

  // Return cleanup function
  return async () => {
    await handleShutdown(state);
  };
}

/**
 * Handles the message_end event from OMP.
 */
function handleMessageEnd(event: { message: unknown }, state: PluginState): void {
  const data = extractAssistantMessageData(event.message);
  if (!data) {
    return; // Not an assistant message
  }

  const usageEvent = createUsageEvent(state.sessionRunId, data);
  const ok = state.writer.write(usageEvent);
  if (!ok) {
    // Queue full - event dropped
    // Could emit a warning metric here in the future
  }
}

/**
 * Handles shutdown - flushes writer and closes.
 */
async function handleShutdown(state: PluginState): Promise<void> {
  await state.writer.close();
}

import type { PluginConfig } from "./types.js";