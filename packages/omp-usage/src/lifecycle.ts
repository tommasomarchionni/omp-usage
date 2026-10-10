import { randomUUID } from 'node:crypto';
import type {
  AssistantMessageEvent,
  ExtensionCommandContext,
  OmpApi,
  PluginConfig,
} from './types.js';
import { EventWriter, createPluginConfig, parseRetentionDays } from './writer.js';
import { createUsageEvent, extractAssistantMessageData } from './events.js';

interface PluginState {
  sessionRunId: string;
  writer: EventWriter;
  config: PluginConfig;
  /** Recently seen message fingerprints, to avoid recording a replay twice. */
  seen: Set<string>;
  duplicatesSkipped: number;
  sanitizedFields: number;
  handlerErrors: number;
}

const SEEN_LIMIT = 2048;

/**
 * Initializes the plugin for one OMP session binding.
 *
 * OMP rebinds extension factories for every subagent session (task tool,
 * `agent()`, clones), so each binding gets its own `sessionRunId` and its own
 * JSONL file. Module-level state is shared across bindings; this plugin
 * keeps none.
 */
export function initializePlugin(
  api: OmpApi,
  userConfig: Partial<PluginConfig> = {}
): () => Promise<void> {
  const config = createPluginConfig(userConfig);
  const sessionRunId = randomUUID();
  const writer = new EventWriter(sessionRunId, config);
  const state: PluginState = {
    sessionRunId,
    writer,
    config,
    seen: new Set(),
    duplicatesSkipped: 0,
    sanitizedFields: 0,
    handlerErrors: 0,
  };

  api.on('message_end', event => {
    // Never let a recording problem affect the agent turn.
    try {
      handleMessageEnd(event?.message, state);
    } catch {
      state.handlerErrors++;
    }
  });

  // session_shutdown handlers run with a 2 s budget; the flush is synchronous.
  api.on('session_shutdown', () => state.writer.close());

  registerPluginCommands(api, state);

  return () => state.writer.close();
}

function handleMessageEnd(message: unknown, state: PluginState): void {
  const data = extractAssistantMessageData(message);
  if (!data) return;
  state.sanitizedFields += data.droppedFields;

  const fp = fingerprint(data);
  if (fp !== null) {
    if (state.seen.has(fp)) {
      state.duplicatesSkipped++;
      return;
    }
    state.seen.add(fp);
    if (state.seen.size > SEEN_LIMIT) {
      const first = state.seen.values().next().value;
      if (first !== undefined) state.seen.delete(first);
    }
  }

  state.writer.write(createUsageEvent(state.sessionRunId, data));
}

/**
 * A message that carries its own timestamp is identified by timestamp, model
 * and token counts. Without a timestamp no de-duplication is attempted.
 */
function fingerprint(d: AssistantMessageEvent): string | null {
  if (d.messageTimestamp === null) return null;
  const u = d.usage;
  return [
    d.messageTimestamp,
    d.provider,
    d.model,
    d.stopReason,
    u?.input,
    u?.output,
    u?.cacheRead,
    u?.cacheWrite,
  ].join('|');
}

function registerPluginCommands(api: OmpApi, state: PluginState): void {
  if (!api.registerCommand) return;
  api.registerCommand('omp-usage', {
    description: 'omp-usage plugin: status | retention [off|<days>] | prune',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      handlePluginCommand(args, ctx, state);
    },
  });
}

function handlePluginCommand(args: string, ctx: ExtensionCommandContext, state: PluginState): void {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'help') {
    notify(ctx, 'Usage: /omp-usage status | retention [off|<days>] | prune', 'info');
    return;
  }

  const [action, value] = trimmed.split(/\s+/, 2);
  switch (action) {
    case 'status': {
      const s = state.writer.getStats();
      const retention = state.writer.getRetentionDays();
      const level = s.dropped > 0 || s.writeErrors > 0 ? 'warning' : 'info';
      notify(
        ctx,
        [
          `file=${state.writer.getFilePath()}`,
          `written=${s.written}`,
          `queued=${s.queued}`,
          `dropped=${s.dropped}`,
          `writeErrors=${s.writeErrors}`,
          `bytes=${s.bytesWritten}`,
          `duplicatesSkipped=${state.duplicatesSkipped}`,
          `sanitizedFields=${state.sanitizedFields}`,
          `handlerErrors=${state.handlerErrors}`,
          `retention=${retention === null ? 'off' : `${retention}d`}`,
          ...(s.lastError ? [`lastError=${s.lastError}`] : []),
        ].join(', '),
        level
      );
      return;
    }
    case 'retention': {
      if (!value) {
        const retention = state.writer.getRetentionDays();
        notify(
          ctx,
          `Current retention: ${retention === null ? 'off' : `${retention} days`}`,
          'info'
        );
        return;
      }
      const parsed = parseRetentionDays(value);
      if (parsed === undefined) {
        notify(ctx, 'Invalid retention value. Use: off | <positive-days>', 'error');
        return;
      }
      const deleted = state.writer.setRetentionDays(parsed);
      state.config.retentionDays = parsed;
      notify(
        ctx,
        parsed === null
          ? 'Retention disabled.'
          : `Retention set to ${parsed} days (this session only). Deleted files: ${deleted}. ` +
              'Files are deleted by age without checking that the exporter imported them; ' +
              'prefer omp-usage-exporter --retention-days.',
        parsed === null ? 'info' : 'warning'
      );
      return;
    }
    case 'prune': {
      if (state.writer.getRetentionDays() === null) {
        notify(
          ctx,
          'Retention is off: nothing to prune. Use /omp-usage retention <days> first.',
          'info'
        );
        return;
      }
      const deleted = state.writer.pruneOldFiles();
      notify(ctx, `Retention prune complete. Deleted files: ${deleted}.`, 'info');
      return;
    }
    default:
      notify(ctx, `Unknown action: ${action}. Use /omp-usage help`, 'error');
  }
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error'
): void {
  if (ctx.ui?.notify) {
    ctx.ui.notify(message, type);
    return;
  }
  const prefix = type === 'error' ? '[omp-usage:error]' : '[omp-usage]';
  console.log(`${prefix} ${message}`);
}
