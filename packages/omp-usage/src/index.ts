import type { OmpApi, PluginCleanup } from "./types.js";
import { initializePlugin } from "./lifecycle.js";

export default function extension(api: OmpApi, userConfig?: import("./types.js").PluginConfig): PluginCleanup {
  return initializePlugin(api, userConfig);
}

export { initializePlugin } from "./lifecycle.js";
export { EventWriter, resolveEventsDir, createPluginConfig } from "./writer.js";
export { createUsageEvent, extractAssistantMessageData } from "./events.js";
export type { PluginConfig, OmpApi, AssistantMessageEvent, PluginCleanup } from "./types.js";