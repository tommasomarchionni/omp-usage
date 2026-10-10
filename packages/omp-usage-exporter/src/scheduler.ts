import { watch, type FSWatcher } from 'node:fs';
import type { ExporterDatabase } from './database.js';
import type { Importer, ImportCycleResult } from './importer.js';
import type { Logger } from './logger.js';
import type { ExporterMetrics, ExporterState } from './metrics.js';

export interface SchedulerOptions {
  eventsDir: string;
  pollIntervalMs: number;
  /** Debounce for file-system notifications. */
  watchDebounceMs?: number;
  /** Disable fs.watch (polling only), e.g. on network filesystems. */
  watch?: boolean;
}

/**
 * Runs import cycles continuously: every `pollIntervalMs` and, when
 * available, shortly after a change notification from fs.watch. Polling is
 * the source of truth; the watcher only reduces latency, because fs.watch is
 * not reliable on every filesystem (NFS/SMB, some containers).
 *
 * Cycles never overlap: a trigger during a running cycle schedules exactly one
 * follow-up cycle.
 */
export class ImportScheduler {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly importer: Importer,
    private readonly db: ExporterDatabase,
    private readonly state: ExporterState,
    private readonly metrics: ExporterMetrics,
    private readonly logger: Logger,
    private readonly options: SchedulerOptions
  ) {}

  /** Runs one cycle immediately and starts periodic imports. */
  async start(): Promise<ImportCycleResult | null> {
    const first = await this.runCycle();
    if (this.stopped) return first;
    this.timer = setInterval(() => this.trigger(), this.options.pollIntervalMs);
    this.timer.unref();
    if (this.options.watch !== false) this.startWatcher();
    return first;
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(this.options.eventsDir, { persistent: false }, () => {
        if (this.debounce) return;
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.trigger();
        }, this.options.watchDebounceMs ?? 250);
        this.debounce.unref();
      });
      this.watcher.on('error', e => {
        this.logger.warn('fs.watch failed, continuing with polling only', { error: e.message });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (e) {
      this.logger.debug('fs.watch unavailable, using polling only', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Requests a cycle; coalesces with a running one. */
  trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.runCycle();
  }

  /** Runs one import cycle and updates exporter state. Never rejects. */
  runCycle(): Promise<ImportCycleResult | null> {
    let result: ImportCycleResult | null = null;
    const p = (async () => {
      const attemptAt = Date.now();
      try {
        result = await this.importer.importAll();
        this.state.lastAttemptMs = attemptAt;
        this.state.lastDurationMs = result.durationMs;
        this.state.filesTracked = this.db.isClosed()
          ? this.state.filesTracked
          : this.db.listCursors().length;
        if (result.fileErrors === 0) {
          this.state.lastCycleOk = true;
          this.state.lastSuccessMs = Date.now();
          this.state.lastError = null;
        } else {
          this.state.lastCycleOk = false;
          this.state.lastError = `${result.fileErrors} file(s) failed to import`;
        }
        if (result.imported > 0 || result.invalid > 0 || result.resets > 0) {
          this.logger.info('import cycle', {
            imported: result.imported,
            duplicates: result.duplicates,
            invalid: result.invalid,
            resets: result.resets,
            files: result.files,
            ms: result.durationMs,
          });
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.state.lastAttemptMs = attemptAt;
        this.state.lastCycleOk = false;
        this.state.lastError = err.message;
        this.metrics.importErrorsTotal.inc({ reason: classifyError(err) });
        this.logger.error('import cycle failed', { error: err.message });
      }
    })();

    this.running = p.finally(() => {
      this.running = null;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.trigger();
      }
    });
    return this.running.then(() => result);
  }

  /** Stops timers and the watcher, then waits for the in-flight cycle. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
    await this.importer.stop();
    if (this.running) await this.running;
  }
}

export function classifyError(err: Error): 'database' | 'io' | 'other' {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code.startsWith('SQLITE')) return 'database';
    if (/^E[A-Z]+$/.test(code)) return 'io';
  }
  return 'other';
}
