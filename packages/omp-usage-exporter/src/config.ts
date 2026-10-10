import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExporterConfig } from "./protocol.js";

export interface ResolvedConfig extends ExporterConfig {
  eventsDir: string;
  dbPath: string;
}

export const DEFAULTS = {
  listen: "127.0.0.1:9464",
  maxLineLength: 1048576,
  logLevel: "info" as const,
  maxLabelCardinality: 1000,
};

export function resolveConfig(
  flags: {
    eventsDir?: string;
    dbPath?: string;
    listen?: string;
    maxLineLength?: number;
    logLevel?: "debug" | "info" | "warn" | "error";
    maxLabelCardinality?: number;
  } = {},
): ResolvedConfig {
  const eventsDir = flags.eventsDir ?? process.env["OMP_USAGE_EVENTS_DIR"] ?? join(homedir(), ".local", "state", "omp-usage", "events");
  const dbPath = flags.dbPath ?? process.env["OMP_USAGE_DB_PATH"] ?? join(homedir(), ".local", "state", "omp-usage", "exporter.db");
  const listen = flags.listen ?? process.env["OMP_USAGE_LISTEN"] ?? DEFAULTS.listen;
  const maxLineLength = flags.maxLineLength ?? (process.env["OMP_USAGE_MAX_LINE_LENGTH"] ? parseInt(process.env["OMP_USAGE_MAX_LINE_LENGTH"], 10) : DEFAULTS.maxLineLength);
  const logLevel = flags.logLevel ?? ((process.env["OMP_USAGE_LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? DEFAULTS.logLevel);
  const maxLabelCardinality = flags.maxLabelCardinality ?? (process.env["OMP_USAGE_MAX_LABEL_CARDINALITY"] ? parseInt(process.env["OMP_USAGE_MAX_LABEL_CARDINALITY"], 10) : DEFAULTS.maxLabelCardinality);

  return {
    eventsDir: resolvePath(eventsDir),
    dbPath: resolvePath(dbPath),
    listen,
    maxLineLength,
    logLevel,
    maxLabelCardinality,
  };
}

function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }
  return resolve(path);
}

export function validateConfig(config: ResolvedConfig): void {
  if (config.maxLineLength <= 0) {
    throw new Error("maxLineLength must be positive");
  }
  if (config.maxLabelCardinality <= 0) {
    throw new Error("maxLabelCardinality must be positive");
  }
  if (!config.eventsDir) {
    throw new Error("eventsDir is required");
  }
  if (!config.dbPath) {
    throw new Error("dbPath is required");
  }
  const [host, portStr] = config.listen.split(":");
  if (!host || !portStr) {
    throw new Error("listen must be in format host:port");
  }
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error("port must be between 1 and 65535");
  }
}

export function parseListen(listen: string): { host: string; port: number } {
  const parts = listen.split(":");
  const host = parts[0] ?? "127.0.0.1";
  const portStr = parts[1];
  const port = portStr ? parseInt(portStr, 10) : 9464;
  return { host, port };
}