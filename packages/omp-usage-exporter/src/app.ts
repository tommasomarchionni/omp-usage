import { mkdirSync } from 'node:fs';
import type { ResolvedConfig } from './config.js';
import { isLoopback, parseListen } from './config.js';
import { ExporterDatabase } from './database.js';
import { Importer } from './importer.js';
import type { Logger } from './logger.js';
import {
  createExporterState,
  createMetrics,
  type ExporterMetrics,
  type ExporterState,
} from './metrics.js';
import { ImportScheduler } from './scheduler.js';
import { ExporterServer } from './server.js';
import { ShutdownManager } from './shutdown.js';

export interface ExporterApp {
  db: ExporterDatabase;
  importer: Importer;
  scheduler: ImportScheduler;
  server: ExporterServer;
  metrics: ExporterMetrics;
  state: ExporterState;
  shutdown: ShutdownManager;
}

export interface CreateAppOptions {
  version: string;
  logger: Logger;
  /** Disable fs.watch (tests, network filesystems). */
  watch?: boolean;
  collectProcessMetrics?: boolean;
}

/** Wires all components. Opening the database acquires the exclusive lock. */
export function createApp(config: ResolvedConfig, options: CreateAppOptions): ExporterApp {
  const { logger } = options;
  mkdirSync(config.eventsDir, { recursive: true, mode: 0o700 });

  const db = new ExporterDatabase(config.dbPath);
  const state = createExporterState();
  const metrics = createMetrics(db, state, {
    maxLabelCardinality: config.maxLabelCardinality,
    version: options.version,
    collectProcessMetrics: options.collectProcessMetrics,
  });

  const importer = new Importer(
    { eventsDir: config.eventsDir, maxLineLength: config.maxLineLength },
    db
  );
  importer.on('warning', (msg, file) => logger.warn(msg, { file }));
  importer.on('error', (err, file) => {
    metrics.importErrorsTotal.inc({
      reason: (err as { code?: string }).code?.startsWith('SQLITE') ? 'database' : 'io',
    });
    logger.error('failed to import file', { file, error: err.message });
  });
  importer.on('reset', (file, reason) => {
    metrics.fileResetsTotal.inc({ reason });
    logger.warn('event file changed underneath the cursor, re-reading from start', {
      file,
      reason,
    });
  });

  const scheduler = new ImportScheduler(importer, db, state, metrics, logger, {
    eventsDir: config.eventsDir,
    pollIntervalMs: config.pollIntervalMs,
    watch: options.watch,
    retentionDays: config.retentionDays,
  });

  const server = new ExporterServer(metrics.registry, db, state, {
    listen: config.listen,
    staleAfterMs: config.staleAfterMs,
    logger,
  });

  // Order matters: stop serving, finish the in-flight import batch, then
  // checkpoint and close SQLite.
  const shutdown = new ShutdownManager(
    [
      { name: 'http', stop: () => server.stop(Math.min(5_000, config.shutdownTimeoutMs / 2)) },
      { name: 'importer', stop: () => scheduler.stop() },
      { name: 'database', stop: () => db.close() },
    ],
    logger,
    config.shutdownTimeoutMs
  );

  const { host } = parseListen(config.listen);
  if (!isLoopback(host)) {
    logger.warn('listening on a non-loopback address: /metrics is reachable from the network', {
      listen: config.listen,
    });
  }

  return { db, importer, scheduler, server, metrics, state, shutdown };
}
