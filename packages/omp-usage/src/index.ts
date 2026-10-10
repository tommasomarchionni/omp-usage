import type { OmpApi, PluginCleanup, PluginConfig } from './types.js';
import { initializePlugin } from './lifecycle.js';

/** OMP extension factory (default export). */
export default function extension(api: OmpApi, userConfig?: Partial<PluginConfig>): PluginCleanup {
  return initializePlugin(api, userConfig);
}

export { initializePlugin } from './lifecycle.js';
export { EventWriter, resolveEventsDir, createPluginConfig, parseRetentionDays } from './writer.js';
export { createUsageEvent, extractAssistantMessageData } from './events.js';
export type {
  PluginConfig,
  OmpApi,
  AssistantMessageEvent,
  PluginCleanup,
  UsageEvent,
  Usage,
  WriterStats,
} from './types.js';
