import { mkdirSync, appendFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { UsageEvent } from "@tommasomarchionni/omp-usage-protocol";
import type { PluginConfig, WriterConfig } from "./types.js";
import { DEFAULT_PLUGIN_CONFIG } from "./types.js";

export function resolveEventsDir(configDir: string): string {
  if (!configDir) {
    return join(homedir(), ".local", "state", "omp-usage", "events");
  }
  let expanded = configDir;
  if (expanded.startsWith("~/")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  return resolve(expanded);
}

export class EventWriter {
  private readonly config: WriterConfig;
  private readonly sessionRunId: string;
  private readonly filePath: string;
  private readonly queue: UsageEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private bytesWritten = 0;

  constructor(sessionRunId: string, config: PluginConfig) {
    this.sessionRunId = sessionRunId;
    this.config = {
      eventsDir: resolveEventsDir(config.eventsDir),
      maxQueueSize: config.maxQueueSize,
      flushIntervalMs: config.flushIntervalMs,
      fileMode: config.fileMode,
      dirMode: config.dirMode,
      retentionDays: config.retentionDays,
    };
    this.filePath = join(this.config.eventsDir, `${sessionRunId}.jsonl`);
    this.ensureDirectory();
    this.pruneOldFiles();
    this.startFlushTimer();
    this.startRetentionTimer();
  }

  private ensureDirectory(): void {
    try {
      mkdirSync(this.config.eventsDir, { recursive: true, mode: this.config.dirMode });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code !== "EEXIST") {
        throw e;
      }
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.config.flushIntervalMs);
    this.flushTimer.unref();
  }

  private startRetentionTimer(): void {
    if (this.config.retentionDays === null || this.config.retentionDays <= 0) {
      return;
    }
    const retentionIntervalMs = 10 * 60 * 1000;
    this.retentionTimer = setInterval(() => {
      this.pruneOldFiles();
    }, retentionIntervalMs);
    this.retentionTimer.unref();
  }

  write(event: UsageEvent): boolean {
    if (this.closed) {
      return false;
    }
    if (this.queue.length >= this.config.maxQueueSize) {
      return false;
    }
    this.queue.push(event);
    return true;
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    const toWrite = this.queue.splice(0, this.queue.length);
    try {
      for (const event of toWrite) {
        const line = JSON.stringify(event) + "\n";
        appendFileSync(this.filePath, line, { encoding: "utf8", mode: this.config.fileMode });
        this.bytesWritten += Buffer.byteLength(line, "utf8");
      }
    } catch (e) {
      this.queue.unshift(...toWrite);
      throw e;
    }
    this.pruneOldFiles();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    await this.flush();
  }

  getFilePath(): string {
    return this.filePath;
  }

  getBytesWritten(): number {
    return this.bytesWritten;
  }

  getQueueLength(): number {
    return this.queue.length;
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

  pruneOldFiles(): number {
    const retentionDays = this.config.retentionDays;
    if (retentionDays === null || retentionDays <= 0) {
      return 0;
    }
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - maxAgeMs;
    let deleted = 0;

    let entries: string[] = [];
    try {
      entries = readdirSync(this.config.eventsDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = join(this.config.eventsDir, entry);
      if (fullPath === this.filePath) {
        continue;
      }
      try {
        const stats = statSync(fullPath);
        if (!stats.isFile()) {
          continue;
        }
        if (stats.mtimeMs < cutoffMs) {
          rmSync(fullPath, { force: true });
          deleted += 1;
        }
      } catch {
        // Ignore pruning errors to avoid impacting event ingestion.
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
    eventsDir: resolveEventsDir(overrides.eventsDir ?? envConfig.eventsDir ?? ""),
  };
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function readRetentionDaysEnv(name: string): number | null | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" || normalized === "off" || normalized === "none" || normalized === "0") {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed === 0 ? null : parsed;
}

function resolvePluginConfigFromEnv(): Partial<PluginConfig> {
  const envEventsDir = process.env["OMP_USAGE_EVENTS_DIR"];
  const envMaxQueueSize = readPositiveIntEnv("OMP_USAGE_MAX_QUEUE_SIZE");
  const envFlushIntervalMs = readPositiveIntEnv("OMP_USAGE_FLUSH_INTERVAL_MS");
  const envRetentionDays = readRetentionDaysEnv("OMP_USAGE_RETENTION_DAYS");

  return {
    ...(envEventsDir ? { eventsDir: envEventsDir } : {}),
    ...(envMaxQueueSize !== undefined ? { maxQueueSize: envMaxQueueSize } : {}),
    ...(envFlushIntervalMs !== undefined ? { flushIntervalMs: envFlushIntervalMs } : {}),
    ...(envRetentionDays !== undefined ? { retentionDays: envRetentionDays } : {}),
  };
}