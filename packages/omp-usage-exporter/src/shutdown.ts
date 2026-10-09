import type { ExporterDatabase } from "./database.js";
import type { Importer } from "./importer.js";
import type { ExporterServer } from "./server.js";

export class ShutdownManager {
  private readonly server: ExporterServer;
  private readonly importer: Importer;
  private readonly database: ExporterDatabase;
  private readonly shutdownTimeout: number;
  private shuttingDown = false;

  constructor(
    server: ExporterServer,
    importer: Importer,
    database: ExporterDatabase,
    shutdownTimeoutMs = 30000,
  ) {
    this.server = server;
    this.importer = importer;
    this.database = database;
    this.shutdownTimeout = shutdownTimeoutMs;
  }

  setupSignals(): void {
    const handleSignal = (signal: NodeJS.Signals) => {
      this.shutdown(signal).catch((err) => {
        console.error(`Error during shutdown (${signal}):`, err);
        process.exit(1);
      });
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  }

  async shutdown(signal?: NodeJS.Signals): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    console.log(`Shutdown initiated${signal ? ` by ${signal}` : ""}...`);

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Shutdown timeout")), this.shutdownTimeout);
    });

    const shutdownProcess = (async () => {
      console.log("Stopping HTTP server...");
      await this.server.stop();
      console.log("HTTP server stopped.");

      console.log("Stopping importer...");
      this.importer.stop();
      console.log("Importer stopped.");

      console.log("Closing database...");
      this.database.close();
      console.log("Database closed.");

      console.log("Shutdown complete.");
    })();

    await Promise.race([shutdownProcess, timeout]);
  }
}