import { Command } from "commander";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, validateConfig } from "./config.js";
import { ExporterDatabase } from "./database.js";
import { Importer } from "./importer.js";
import { createAllMetrics, updateLlmMetricsFromAggregates } from "./metrics.js";
import { ExporterServer } from "./server.js";
import { ShutdownManager } from "./shutdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getVersion(): Promise<string> {
  try {
    const pkgPath = new URL("../package.json", import.meta.url).pathname;
    const pkg = await import(pkgPath, { assert: { type: "json" } });
    return pkg.default.version;
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const program = new Command();

  const version = await getVersion();
  program
    .name("omp-usage-exporter")
    .description("Imports OMP usage events and exposes Prometheus metrics")
    .version(version)
    .option("--events-dir <path>", "Directory containing event JSONL files")
    .option("--db-path <path>", "SQLite database path")
    .option("--listen <host:port>", "HTTP listen address")
    .option("--max-line-length <bytes>", "Maximum line length for JSONL parsing", parseInt)
    .option("--log-level <level>", "Log level: debug, info, warn, error")
    .option("--max-label-cardinality <number>", "Maximum unique (provider,model) pairs", parseInt)
    .option("--config-check", "Validate configuration and exit")
    .option("--import-once", "Import all files once and exit")
    .helpOption("-h, --help", "Show help")
    .parse(process.argv);

  const options = program.opts() as Record<string, unknown>;

  const config = resolveConfig({
    eventsDir: options["eventsDir"] as string | undefined,
    dbPath: options["dbPath"] as string | undefined,
    listen: options["listen"] as string | undefined,
    maxLineLength: options["maxLineLength"] as number | undefined,
    logLevel: options["logLevel"] as "debug" | "info" | "warn" | "error" | undefined,
    maxLabelCardinality: options["maxLabelCardinality"] as number | undefined,
  });

  try {
    validateConfig(config);
  } catch (e) {
    console.error("Configuration error:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (options["configCheck"]) {
    console.log("Configuration valid:");
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }

  const database = new ExporterDatabase(config.dbPath);
  const metrics = createAllMetrics(config.maxLabelCardinality);
  const importer = new Importer(config, database);
  const server = new ExporterServer(metrics.registry, metrics.operational, config.listen);
  const shutdownManager = new ShutdownManager(server, importer, database);

  shutdownManager.setupSignals();

  console.log("Starting initial import...");
  const result = await importer.importAll();
  console.log(`Imported ${result.imported} events from ${result.files} files (${result.errors} errors)`);

  const aggregates = database.getAggregates();
  const cardinality = updateLlmMetricsFromAggregates(metrics.llm, aggregates, config.maxLabelCardinality);
  metrics.operational.labelCardinalityGauge.set(cardinality);

  if (options["importOnce"]) {
    console.log("Import complete. Exiting.");
    await shutdownManager.shutdown();
    process.exit(0);
  }

  await server.start();
  console.log(`Exporter listening on http://${server.address()}`);
  console.log(`  Metrics: http://${server.address()}/metrics`);
  console.log(`  Health:  http://${server.address()}/healthz`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});