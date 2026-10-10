import { createReadStream, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ExporterDatabase } from "./database.js";
import { validateJsonlLine, type UsageEvent, SCHEMA_VERSION, type FileCursor } from "./protocol.js";
import type { ResolvedConfig } from "./config.js";

export interface ImporterEvents {
  progress: [imported: number, total: number];
  fileComplete: [filePath: string, imported: number];
  error: [error: Error, context?: string];
  warning: [message: string, context?: string];
}

export class Importer extends EventEmitter<ImporterEvents> {
  private readonly config: ResolvedConfig;
  private readonly db: ExporterDatabase;
  private readonly maxLineLength: number;
  private running = false;

  constructor(config: ResolvedConfig, db: ExporterDatabase) {
    super();
    this.config = config;
    this.db = db;
    this.maxLineLength = config.maxLineLength;
  }

  async importAll(): Promise<{ imported: number; files: number; errors: number }> {
    if (this.running) {
      throw new Error("Import already in progress");
    }
    this.running = true;

    let totalImported = 0;
    let totalErrors = 0;
    let filesProcessed = 0;

    try {
      const files = this.getEventFiles();

      for (const file of files) {
        if (!this.running) break;
        const result = await this.importFile(file);
        totalImported += result.imported;
        totalErrors += result.errors;
        filesProcessed++;
        this.emit("fileComplete", file, result.imported);
      }
    } finally {
      this.running = false;
    }

    return { imported: totalImported, files: filesProcessed, errors: totalErrors };
  }

  stop(): void {
    this.running = false;
  }

  private getEventFiles(): string[] {
    try {
      const files = readdirSync(this.config.eventsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(this.config.eventsDir, f))
        .sort();
      return files;
    } catch {
      return [];
    }
  }

  private async importFile(filePath: string): Promise<{ imported: number; errors: number }> {
    const cursor = this.db.getCursor(filePath);
    let imported = 0;
    let errors = 0;

    const stream = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
      start: cursor?.offset ?? 0,
    });

    let buffer = "";
    let lineNumber = 0;
    const batch: Array<{ event: UsageEvent; cursor: FileCursor }> = [];
    const BATCH_SIZE = 100;

    for await (const chunk of stream) {
      if (!this.running) break;

      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!this.running) break;
        lineNumber++;

        if (line.trim().length === 0) {
          continue;
        }

        if (Buffer.byteLength(line, "utf8") > this.maxLineLength) {
          errors++;
          this.emit("warning", `Line ${lineNumber} exceeds max length`, filePath);
          this.db.incrementOperationalMetric("import_errors_line_too_long");
          continue;
        }

        const result = validateJsonlLine(line);
        if (!result.valid) {
          errors++;
          this.emit("warning", `Invalid line ${lineNumber}: ${result.errors?.[0]?.message}`, filePath);
          this.db.incrementOperationalMetric("import_errors_malformed");
          continue;
        }

        const event = result.event!;

        if (event.schemaVersion !== SCHEMA_VERSION) {
          errors++;
          this.emit("warning", `Unknown schema version ${event.schemaVersion}`, filePath);
          this.db.incrementOperationalMetric("import_errors_unknown_schema");
          continue;
        }

        const stats = statSync(filePath);
        const newCursor: FileCursor = {
          filePath,
          offset: (cursor?.offset ?? 0) + Buffer.byteLength(line + "\n", "utf8"),
          fileSize: stats.size,
          inode: stats.ino,
          device: stats.dev,
          mtimeMs: stats.mtimeMs,
        };

        batch.push({ event, cursor: newCursor });

        if (batch.length >= BATCH_SIZE) {
          const result = this.db.importEvents(batch);
          imported += result.imported;
          errors += result.errors;
          batch.length = 0;
          this.emit("progress", imported, 0);
        }
      }
    }

    if (batch.length > 0) {
      const result = this.db.importEvents(batch);
      imported += result.imported;
      errors += result.errors;
    }

    this.db.setOperationalMetric("last_import_timestamp", new Date().toISOString());

    return { imported, errors };
  }
}