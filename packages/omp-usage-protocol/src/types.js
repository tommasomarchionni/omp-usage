/**
 * Protocol types for omp-usage.
 * These are the TypeScript types used across plugin and exporter.
 */
/**
 * Default writer configuration.
 */
export const DEFAULT_WRITER_CONFIG = {
    eventsDir: "",
    maxQueueSize: 1000,
    flushIntervalMs: 1000,
    fileMode: 0o600,
    dirMode: 0o700,
};
/**
 * Default exporter configuration.
 */
export const DEFAULT_EXPORTER_CONFIG = {
    eventsDir: "",
    dbPath: "",
    listen: "127.0.0.1:9464",
    maxLineLength: 1048576, // 1 MiB
    logLevel: "info",
    maxLabelCardinality: 1000,
};
//# sourceMappingURL=types.js.map