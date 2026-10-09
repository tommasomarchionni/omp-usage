/**
 * Protocol types for omp-usage.
 * These are the TypeScript types used across plugin and exporter.
 */

import type { UsageEvent, UsageEventInput } from "./schema.js";

export type { UsageEvent, UsageEventInput };

/**
 * Configuration for the plugin writer.
 */
export interface WriterConfig {
  /** Directory where event files are written */
  eventsDir: string;
  /** Maximum events queued in memory before dropping */
  maxQueueSize: number;
  /** Flush interval in milliseconds */
  flushIntervalMs: number;
  /** File permissions (octal) */
  fileMode: number;
  /** Directory permissions (octal) */
  dirMode: number;
}

/**
 * Default writer configuration.
 */
export const DEFAULT_WRITER_CONFIG: WriterConfig = {
  eventsDir: "",
  maxQueueSize: 1000,
  flushIntervalMs: 1000,
  fileMode: 0o600,
  dirMode: 0o700,
};

/**
 * Configuration for the exporter.
 */
export interface ExporterConfig {
  /** Directory to scan for event files */
  eventsDir: string;
  /** SQLite database path */
  dbPath: string;
  /** HTTP listen address (host:port) */
  listen: string;
  /** Maximum line length when reading JSONL */
  maxLineLength: number;
  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Maximum unique (provider, model) pairs for metrics cardinality */
  maxLabelCardinality: number;
}

/**
 * Default exporter configuration.
 */
export const DEFAULT_EXPORTER_CONFIG: ExporterConfig = {
  eventsDir: "",
  dbPath: "",
  listen: "127.0.0.1:9464",
  maxLineLength: 1048576, // 1 MiB
  logLevel: "info",
  maxLabelCardinality: 1000,
};

/**
 * Database cursor for tracking import position per file.
 */
export interface FileCursor {
  /** Absolute file path */
  filePath: string;
  /** Byte offset of last successfully imported line */
  offset: number;
  /** File size at last read (for truncation detection) */
  fileSize: number;
  /** Inode for rename detection */
  inode: number;
  /** Device ID for rename detection */
  device: number;
  /** Last modified time (ms) */
  mtimeMs: number;
}

/**
 * Aggregated metrics stored in the database.
 */
export interface AggregatedMetrics {
  /** Provider name */
  provider: string;
  /** Model identifier */
  model: string;
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Total cache read tokens */
  cacheReadTokens: number;
  /** Total cache write tokens */
  cacheWriteTokens: number;
  /** Total reasoning tokens */
  reasoningTokens: number;
  /** Total requests (success) */
  requestsSuccess: number;
  /** Total requests (error) */
  requestsError: number;
  /** Total reported cost in USD */
  reportedCostUsd: number;
  /** Count of events with missing usage */
  usageMissing: number;
}

/**
 * Operational metrics for the exporter itself.
 */
export interface OperationalMetrics {
  /** Total import errors by reason */
  importErrors: Record<string, number>;
  /** Total invalid records by reason */
  invalidRecords: Record<string, number>;
  /** Last successful import timestamp (ISO 8601) */
  lastImportTimestamp: string | null;
}

/**
 * Prometheus metric labels for LLM metrics.
 */
export interface LlmMetricLabels {
  provider: string;
  model: string;
}

/**
 * Prometheus metric labels for request metrics.
 */
export interface RequestMetricLabels extends LlmMetricLabels {
  status: "success" | "error";
}

/**
 * Prometheus metric labels for token metrics.
 */
export interface TokenMetricLabels extends LlmMetricLabels {
  direction: "input" | "output" | "cache_read" | "cache_write";
}