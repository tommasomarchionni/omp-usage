import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from '@prometheus-io/client';
import { formatHostPort, parseListen } from './config.js';
import type { ExporterDatabase } from './database.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { ExporterState } from './metrics.js';

export interface ServerOptions {
  listen: string;
  /** /healthz turns unhealthy when the last successful import is older. */
  staleAfterMs: number;
  logger?: Logger;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  database: boolean;
  lastImport: string | null;
  lastImportOk: boolean;
  lastError: string | null;
  timestamp: string;
}

/**
 * Minimal HTTP server: GET/HEAD /metrics and /healthz only. Nothing else is
 * served, in particular no event file or database content.
 */
export class ExporterServer {
  private readonly server: http.Server;
  private readonly host: string;
  private port: number;
  private readonly logger: Logger;

  constructor(
    private readonly registry: Registry,
    private readonly db: ExporterDatabase,
    private readonly state: ExporterState,
    private readonly options: ServerOptions
  ) {
    const { host, port } = parseListen(options.listen);
    this.host = host;
    this.port = port;
    this.logger = options.logger ?? silentLogger;

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    // Slowloris protection; Prometheus scrapes are tiny and fast.
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 50;
  }

  health(now = Date.now()): { code: number; body: HealthReport } {
    const database = this.db.ping();
    const last = this.state.lastSuccessMs;
    const stale =
      last === null ? this.state.lastAttemptMs !== null : now - last > this.options.staleAfterMs;
    let status: HealthReport['status'] = 'ok';
    if (!database) status = 'unavailable';
    else if (!this.state.lastCycleOk || stale) status = 'degraded';
    return {
      code: status === 'ok' ? 200 : 503,
      body: {
        status,
        database,
        lastImport: last === null ? null : new Date(last).toISOString(),
        lastImportOk: this.state.lastCycleOk,
        lastError: this.state.lastError,
        timestamp: new Date(now).toISOString(),
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';

    try {
      if (path !== '/metrics' && path !== '/healthz') {
        return this.text(res, 404, 'Not Found\n');
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return this.text(res, 405, 'Method Not Allowed\n');
      }

      if (path === '/healthz') {
        const { code, body } = this.health();
        const payload = JSON.stringify(body);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : payload);
        return;
      }

      const metrics = await this.registry.metrics();
      res.writeHead(200, { 'Content-Type': this.registry.contentType });
      res.end(method === 'HEAD' ? undefined : metrics);
    } catch (e) {
      this.logger.error('request failed', {
        path,
        error: e instanceof Error ? e.message : String(e),
      });
      if (!res.headersSent) this.text(res, 500, 'Internal Server Error\n');
      else res.destroy();
    }
  }

  private text(res: ServerResponse, code: number, body: string): void {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  async start(): Promise<void> {
    if (this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        resolve();
      });
    });
  }

  /**
   * Stops accepting connections and waits for in-flight requests. Idle
   * keep-alive sockets (Prometheus keeps them open) are closed immediately;
   * remaining sockets are destroyed after `graceMs`.
   */
  async stop(graceMs = 5_000): Promise<void> {
    if (!this.server.listening) return;
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
    this.server.closeIdleConnections();
    const timer = setTimeout(() => this.server.closeAllConnections(), graceMs);
    timer.unref();
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }

  address(): string {
    return formatHostPort(this.host, this.port);
  }

  get listening(): boolean {
    return this.server.listening;
  }
}
