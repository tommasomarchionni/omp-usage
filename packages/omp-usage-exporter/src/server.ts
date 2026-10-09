import http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { parseListen } from "./config.js";
import type { Registry } from "@prometheus-io/client";
import type { OperationalMetrics } from "./metrics.js";

export class ExporterServer {
  private readonly server: http.Server;
  private readonly listenPort: number;
  private readonly listenHost: string;
  private readonly registry: Registry;
  private readonly operationalMetrics: OperationalMetrics;

  constructor(registry: Registry, operationalMetrics: OperationalMetrics, listen: string) {
    this.registry = registry;
    this.operationalMetrics = operationalMetrics;
    const { host, port } = parseListen(listen);
    this.listenHost = host;
    this.listenPort = port;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    try {
      if (url === "/metrics" && req.method === "GET") {
        this.handleMetrics(req, res);
      } else if (url === "/healthz" && req.method === "GET") {
        this.handleHealthz(req, res);
      } else {
        this.handleNotFound(res);
      }
    } catch (e) {
      this.handleError(res, e);
    }
  }

  private async handleMetrics(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const metrics = await this.registry.metrics();
      res.setHeader("Content-Type", this.registry.contentType);
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.writeHead(200);
      res.end(metrics);
    } catch {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  }

  private handleHealthz(_req: IncomingMessage, res: ServerResponse): void {
    const lastImport = this.operationalMetrics.lastImportTimestamp.get();
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "ok",
        lastImport: lastImport ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private handleNotFound(res: ServerResponse): void {
    res.writeHead(404);
    res.end("Not Found");
  }

  private handleError(res: ServerResponse, _error: unknown): void {
    res.writeHead(500);
    res.end("Internal Server Error");
  }

  async start(): Promise<void> {
    if (this.server.listening) {
      return;
    }

    const server = this.server;
    const port: number = this.listenPort;
    const host: string = this.listenHost;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: Error) => {
        console.error("Server listen error:", err);
        reject(err);
      });
      server.listen(port, host, () => {
        console.log(`Server listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  address(): string {
    return `${this.listenHost}:${this.listenPort}`;
  }
}