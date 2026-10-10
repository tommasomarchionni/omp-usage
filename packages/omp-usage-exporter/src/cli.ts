#!/usr/bin/env node
import { Command, Option } from 'commander';
import { ConfigError, resolveConfig, type ConfigFlags } from './config.js';
import { createApp } from './app.js';
import { DatabaseLockedError, ExporterDatabase } from './database.js';
import { createLogger } from './logger.js';
import { VERSION } from './version.js';

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command()
    .name('omp-usage-exporter')
    .description('Imports OMP usage events (JSONL) into SQLite and exposes Prometheus metrics')
    .version(VERSION, '-V, --version')
    .option(
      '--events-dir <path>',
      'directory containing event JSONL files [env OMP_USAGE_EVENTS_DIR]'
    )
    .option('--db-path <path>', 'SQLite database path [env OMP_USAGE_DB_PATH]')
    .option(
      '--listen <addr>',
      'HTTP listen address host:port, [ipv6]:port or :port [env OMP_USAGE_LISTEN]'
    )
    .option(
      '--max-line-length <bytes>',
      'maximum JSONL line length [env OMP_USAGE_MAX_LINE_LENGTH]'
    )
    .addOption(
      new Option('--log-level <level>', 'log level [env OMP_USAGE_LOG_LEVEL]').choices([
        'debug',
        'info',
        'warn',
        'error',
      ])
    )
    .option(
      '--max-label-cardinality <n>',
      'maximum exported (provider, model) pairs [env OMP_USAGE_MAX_LABEL_CARDINALITY]'
    )
    .option(
      '--poll-interval-ms <ms>',
      'interval between import cycles [env OMP_USAGE_POLL_INTERVAL_MS]'
    )
    .option(
      '--shutdown-timeout-ms <ms>',
      'graceful shutdown budget [env OMP_USAGE_SHUTDOWN_TIMEOUT_MS]'
    )
    .option(
      '--retention-days <days>',
      'delete fully imported event files idle for N days (default: never) [env OMP_USAGE_EXPORTER_RETENTION_DAYS]'
    )
    .option('--no-watch', 'disable fs.watch and rely on polling only (network filesystems)')
    .option('--config-check', 'validate configuration, print it as JSON and exit')
    .option('--import-once', 'run a single import cycle and exit')
    .option('--backup <file>', 'write an online backup of the database to <file> and exit')
    .option('--rebuild-aggregates', 'recompute aggregates from stored events and exit')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError()
    .exitOverride();

  try {
    program.parse(argv);
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode;
    return typeof code === 'number' ? code : 2;
  }

  const opts = program.opts<{
    eventsDir?: string;
    dbPath?: string;
    listen?: string;
    maxLineLength?: string;
    logLevel?: string;
    maxLabelCardinality?: string;
    pollIntervalMs?: string;
    shutdownTimeoutMs?: string;
    retentionDays?: string;
    watch: boolean;
    configCheck?: boolean;
    importOnce?: boolean;
    backup?: string;
    rebuildAggregates?: boolean;
  }>();

  let config;
  try {
    const flags: ConfigFlags = {
      eventsDir: opts.eventsDir,
      dbPath: opts.dbPath,
      listen: opts.listen,
      maxLineLength: opts.maxLineLength,
      logLevel: opts.logLevel,
      maxLabelCardinality: opts.maxLabelCardinality,
      pollIntervalMs: opts.pollIntervalMs,
      shutdownTimeoutMs: opts.shutdownTimeoutMs,
      retentionDays: opts.retentionDays,
    };
    config = resolveConfig(flags);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (opts.configCheck) {
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    return 0;
  }

  const logger = createLogger(config.logLevel);

  if (opts.rebuildAggregates) {
    const db = openOrExplain(config.dbPath, logger);
    if (!db) return 1;
    try {
      db.rebuildAggregates();
      logger.info('aggregates rebuilt', { events: db.countEvents() });
    } finally {
      db.close();
    }
    if (!opts.backup) return 0;
  }

  if (opts.backup) {
    // Read-only, lock-free: safe while the exporter service is running.
    const db = new ExporterDatabase(config.dbPath, { lock: false });
    try {
      await db.backup(opts.backup);
      logger.info('backup written', { file: opts.backup });
    } finally {
      db.close();
    }
    return 0;
  }

  let app;
  try {
    app = createApp(config, { version: VERSION, logger, watch: opts.watch });
  } catch (e) {
    if (e instanceof DatabaseLockedError) {
      logger.error(e.message);
      return 1;
    }
    throw e;
  }

  logger.info('omp-usage-exporter starting', {
    version: VERSION,
    eventsDir: config.eventsDir,
    dbPath: config.dbPath,
    schema: app.db.getSchemaVersion(),
  });

  if (opts.importOnce) {
    const result = await app.scheduler.runCycle();
    logger.info('import complete', {
      imported: result?.imported ?? 0,
      duplicates: result?.duplicates ?? 0,
      invalid: result?.invalid ?? 0,
      files: result?.files ?? 0,
    });
    const { ok } = await app.shutdown.shutdown('import-once');
    return ok && app.state.lastCycleOk ? 0 : 1;
  }

  app.shutdown.installSignalHandlers();
  process.on('uncaughtException', err => {
    logger.error('uncaught exception', { error: err.stack ?? err.message });
    void app.shutdown.shutdown('uncaughtException').then(() => process.exit(1));
  });
  process.on('unhandledRejection', reason => {
    logger.error('unhandled rejection', {
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });

  try {
    await app.server.start();
  } catch (e) {
    logger.error('cannot listen', {
      listen: config.listen,
      error: e instanceof Error ? e.message : String(e),
    });
    await app.shutdown.shutdown('listen-failed');
    return 1;
  }
  logger.info('listening', {
    metrics: `http://${app.server.address()}/metrics`,
    health: `http://${app.server.address()}/healthz`,
  });

  // Initial import happens after the listener is up so /healthz answers
  // during a long first import; Prometheus sees the counters grow.
  await app.scheduler.start();
  return -1; // keep running; exit is driven by signals
}

function openOrExplain(
  dbPath: string,
  logger: ReturnType<typeof createLogger>
): ExporterDatabase | null {
  try {
    return new ExporterDatabase(dbPath);
  } catch (e) {
    if (e instanceof DatabaseLockedError) {
      logger.error(`${e.message} Stop the running exporter first.`);
      return null;
    }
    throw e;
  }
}

main().then(
  code => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  }
);
