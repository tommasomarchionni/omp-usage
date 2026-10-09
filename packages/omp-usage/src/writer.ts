import { mkdirSync, appendFileSync } from "node:fs";
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
    };
    this.filePath = join(this.config.eventsDir, `${sessionRunId}.jsonl`);
    this.ensureDirectory();
    this.startFlushTimer();
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
}

export function createPluginConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    ...DEFAULT_PLUGIN_CONFIG,
    ...overrides,
    eventsDir: resolveEventsDir(overrides.eventsDir ?? ""),
  };
}