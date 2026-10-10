import type { ExtensionCommandContext, OmpApi } from "./types.js";
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

  registerPluginCommands(api, state);

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

function registerPluginCommands(api: OmpApi, state: PluginState): void {
  if (!api.registerCommand) {
    return;
  }

  api.registerCommand("omp-usage", {
    description: "Manage omp-usage plugin runtime settings (status|retention|prune)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handlePluginCommand(args, ctx, state);
    },
  });
}

async function handlePluginCommand(args: string, ctx: ExtensionCommandContext, state: PluginState): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "help") {
    notify(ctx, "Usage: /omp-usage status | retention [off|<days>] | prune", "info");
    return;
  }

  const [action, value] = trimmed.split(/\s+/, 2);
  switch (action) {
    case "status": {
      const retention = state.writer.getRetentionDays();
      const retentionLabel = retention === null ? "off" : `${retention}d`;
      notify(
        ctx,
        `eventsDir=${state.config.eventsDir}, queue=${state.writer.getQueueLength()}, writtenBytes=${state.writer.getBytesWritten()}, retention=${retentionLabel}`,
        "info",
      );
      return;
    }
    case "retention": {
      if (!value) {
        const retention = state.writer.getRetentionDays();
        notify(ctx, `Current retention: ${retention === null ? "off" : `${retention} days`}`, "info");
        return;
      }
      const parsed = parseRetentionInput(value);
      if (parsed === undefined) {
        notify(ctx, "Invalid retention value. Use: off | <positive-days>", "error");
        return;
      }
      const deleted = state.writer.setRetentionDays(parsed);
      state.config.retentionDays = parsed;
      notify(
        ctx,
        `Retention updated to ${parsed === null ? "off" : `${parsed} days`}. Pruned files: ${deleted}.`,
        "info",
      );
      return;
    }
    case "prune": {
      const deleted = state.writer.pruneOldFiles();
      notify(ctx, `Retention prune complete. Deleted files: ${deleted}.`, "info");
      return;
    }
    default:
      notify(ctx, `Unknown action: ${action}. Use /omp-usage help`, "error");
  }
}

function parseRetentionInput(input: string): number | null | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === "off" || normalized === "none" || normalized === "0") {
    return null;
  }
  const days = Number.parseInt(normalized, 10);
  if (!Number.isFinite(days) || days <= 0) {
    return undefined;
  }
  return days;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  if (ctx.ui?.notify) {
    ctx.ui.notify(message, type);
    return;
  }
  const prefix = type === "error" ? "[omp-usage:error]" : "[omp-usage]";
  console.log(`${prefix} ${message}`);
}

import type { PluginConfig } from "./types.js";