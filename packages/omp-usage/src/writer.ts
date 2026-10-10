import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PluginConfig, UsageEvent, WriterConfig, WriterStats } from './types.js';
import { DEFAULT_PLUGIN_CONFIG } from './types.js';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveEventsDir(configDir: string): string {
  if (!configDir) {
    return join(homedir(), '.local', 'state', 'omp-usage', 'events');
  }
  let expanded = configDir;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2));
  return resolve(expanded);
}

/**
 * Append-only JSONL writer for one OMP session (one file per sessionRunId).
 *
 * - Events are written as soon as the current handler returns (coalesced in a
 *   microtask): one `write()` per batch of complete lines, so a crash loses at
 *   most the events of the current tick.
 * - The file is opened by path for every batch with `O_APPEND | O_NOFOLLOW`,
 *   so a deleted file is re-created instead of writing into an unlinked inode
 *   and a planted symlink is refused.
 * - On write failure events stay queued (bounded by `maxQueueSize`) and are
 *   retried every `flushIntervalMs`; overflow is counted as dropped.
 * - A synchronous flush also runs on process `exit` as a last resort.
 * - Never throws into OMP.
 */
export class EventWriter {
  private readonly config: WriterConfig;
  private readonly filePath: string;
  private queue: UsageEvent[] = [];
  private scheduled = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly stats: WriterStats = {
    queued: 0,
    written: 0,
    dropped: 0,
    writeErrors: 0,
    bytesWritten: 0,
    lastError: null,
  };
  private readonly onExit = (): void => {
    this.flushSync();
  };

  constructor(sessionRunId: string, config: PluginConfig) {
    this.config = { ...config, eventsDir: resolveEventsDir(config.eventsDir) };
    this.filePath = join(this.config.eventsDir, `${sessionRunId}.jsonl`);
    this.ensureDirectory();
    this.startRetentionTimer();
    process.once('exit', this.onExit);
  }

  private ensureDirectory(): void {
    try {
      mkdirSync(this.config.eventsDir, { recursive: true, mode: this.config.dirMode });
    } catch (e) {
      this.recordError(e);
    }
  }

  /** Queues an event. Returns false if it was dropped (closed or queue full). */
  write(event: UsageEvent): boolean {
    if (this.closed) {
      this.stats.dropped++;
      return false;
    }
    if (this.queue.length >= this.config.maxQueueSize) {
      this.stats.dropped++;
      return false;
    }
    this.queue.push(event);
    this.stats.queued = this.queue.length;
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.flushSync();
      });
    }
    return true;
  }

  /**
   * Writes all queued events. Returns true when the queue is empty afterwards.
   */
  flushSync(): boolean {
    if (this.queue.length === 0) return true;
    const batch = this.queue;
    const data = batch.map(e => JSON.stringify(e) + '\n').join('');
    const buf = Buffer.from(data, 'utf8');
    let fd: number | null = null;
    try {
      this.ensureDirectory();
      fd = openSync(
        this.filePath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW,
        this.config.fileMode
      );
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      this.queue = [];
      this.stats.written += batch.length;
      this.stats.bytesWritten += buf.length;
      this.stats.queued = 0;
      this.stopRetry();
      return true;
    } catch (e) {
      // Keep events for a retry; partial writes are not possible for the
      // reader because it only imports newline-terminated, valid lines.
      this.recordError(e);
      this.startRetry();
      return false;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  /** Kept for API compatibility; writes are synchronous. */
  async flush(): Promise<void> {
    this.flushSync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.flushSync();
    this.closed = true;
    this.stopRetry();
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    process.off('exit', this.onExit);
    if (this.queue.length > 0) {
      this.stats.dropped += this.queue.length;
      this.queue = [];
    }
  }

  private startRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setInterval(() => this.flushSync(), this.config.flushIntervalMs);
    this.retryTimer.unref();
  }

  private stopRetry(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private recordError(e: unknown): void {
    this.stats.writeErrors++;
    this.stats.lastError = e instanceof Error ? e.message : String(e);
  }

  private startRetentionTimer(): void {
    if (this.config.retentionDays === null || this.config.retentionDays <= 0) return;
    this.retentionTimer = setInterval(() => this.pruneOldFiles(), 60 * 60 * 1000);
    this.retentionTimer.unref();
  }

  getFilePath(): string {
    return this.filePath;
  }

  getBytesWritten(): number {
    return this.stats.bytesWritten;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getStats(): Readonly<WriterStats> {
    return { ...this.stats, queued: this.queue.length };
  }

  getRetentionDays(): number | null {
    return this.config.retentionDays;
  }

  setRetentionDays(retentionDays: number | null): number {
    this.config.retentionDays = retentionDays;
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    this.startRetentionTimer();
    return this.pruneOldFiles();
  }

  /**
   * Opt-in deletion of `*.jsonl` regular files whose mtime is older than
   * `retentionDays`. The current session file, symlinks and other entries are
   * never touched. The plugin cannot know whether the exporter imported a
   * file: prefer the exporter's `--retention-days`.
   */
  pruneOldFiles(): number {
    const retentionDays = this.config.retentionDays;
    if (retentionDays === null || retentionDays <= 0) return 0;
    const cutoffMs = Date.now() - retentionDays * DAY_MS;
    let deleted = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.config.eventsDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(this.config.eventsDir, entry);
      if (fullPath === this.filePath) continue;
      try {
        const st = lstatSync(fullPath);
        if (st.isFile() && st.mtimeMs < cutoffMs) {
          rmSync(fullPath, { force: true });
          deleted++;
        }
      } catch {
        // Never impact event ingestion.
      }
    }
    return deleted;
  }
}

export function createPluginConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  const envConfig = resolvePluginConfigFromEnv();
  return {
    ...DEFAULT_PLUGIN_CONFIG,
    ...envConfig,
    ...overrides,
    eventsDir: resolveEventsDir(overrides.eventsDir ?? envConfig.eventsDir ?? ''),
  };
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseRetentionDays(raw: string): number | null | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'off' || normalized === 'none' || normalized === '0')
    return null;
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolvePluginConfigFromEnv(): Partial<PluginConfig> {
  const envEventsDir = process.env['OMP_USAGE_EVENTS_DIR']?.trim();
  const envMaxQueueSize = readPositiveIntEnv('OMP_USAGE_MAX_QUEUE_SIZE');
  const envFlushIntervalMs = readPositiveIntEnv('OMP_USAGE_FLUSH_INTERVAL_MS');
  const rawRetention = process.env['OMP_USAGE_RETENTION_DAYS'];
  const envRetentionDays =
    rawRetention === undefined ? undefined : parseRetentionDays(rawRetention);

  return {
    ...(envEventsDir ? { eventsDir: envEventsDir } : {}),
    ...(envMaxQueueSize !== undefined ? { maxQueueSize: envMaxQueueSize } : {}),
    ...(envFlushIntervalMs !== undefined ? { flushIntervalMs: envFlushIntervalMs } : {}),
    ...(envRetentionDays !== undefined ? { retentionDays: envRetentionDays } : {}),
  };
}
