import type { Logger } from './logger.js';

export interface Stoppable {
  name: string;
  stop: () => Promise<void> | void;
}

/**
 * Ordered, idempotent, time-bounded shutdown.
 *
 * Steps run sequentially in the given order. If the whole sequence exceeds
 * `timeoutMs` the returned promise resolves with `ok: false` so the caller can
 * exit with a non-zero code; the timer is always cleared.
 */
export class ShutdownManager {
  private promise: Promise<{ ok: boolean }> | null = null;
  private handlers: Array<{ signal: NodeJS.Signals; fn: () => void }> = [];

  constructor(
    private readonly steps: Stoppable[],
    private readonly logger: Logger,
    private readonly timeoutMs: number
  ) {}

  get inProgress(): boolean {
    return this.promise !== null;
  }

  shutdown(reason: string): Promise<{ ok: boolean }> {
    if (this.promise) return this.promise;
    this.logger.info('shutdown initiated', { reason });

    const sequence = (async () => {
      for (const step of this.steps) {
        const t = Date.now();
        await step.stop();
        this.logger.debug('stopped', { component: step.name, ms: Date.now() - t });
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      timer.unref();
    });

    this.promise = Promise.race([sequence.then(() => 'done' as const), timeout])
      .then(r => {
        if (r === 'timeout') {
          this.logger.error('shutdown timed out', { timeoutMs: this.timeoutMs });
          return { ok: false };
        }
        this.logger.info('shutdown complete');
        return { ok: true };
      })
      .catch((e: unknown) => {
        this.logger.error('shutdown failed', { error: e instanceof Error ? e.message : String(e) });
        return { ok: false };
      })
      .finally(() => clearTimeout(timer));
    return this.promise;
  }

  /**
   * Installs SIGINT/SIGTERM handlers. A second signal during shutdown forces
   * an immediate exit (useful when a step hangs).
   */
  installSignalHandlers(exit: (code: number) => void = c => process.exit(c)): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const fn = () => {
        if (this.inProgress) {
          this.logger.warn('second signal received, forcing exit', { signal });
          exit(1);
          return;
        }
        void this.shutdown(signal).then(({ ok }) => exit(ok ? 0 : 1));
      };
      process.on(signal, fn);
      this.handlers.push({ signal, fn });
    }
  }

  removeSignalHandlers(): void {
    for (const { signal, fn } of this.handlers) process.off(signal, fn);
    this.handlers = [];
  }
}
