import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExporterDatabase } from './database.js';
import { Importer } from './importer.js';
import { silentLogger } from './logger.js';
import { createExporterState, createMetrics } from './metrics.js';
import { ImportScheduler } from './scheduler.js';
import { line, makeEvent, tempDir } from '../test/helpers.js';

const waitFor = async (cond: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 20));
  }
};

describe('ImportScheduler', () => {
  let dir: ReturnType<typeof tempDir>;
  let eventsDir: string;
  let db: ExporterDatabase;
  let scheduler: ImportScheduler;
  let state: ReturnType<typeof createExporterState>;

  const make = (watch: boolean) => {
    const importer = new Importer({ eventsDir, maxLineLength: 1 << 20 }, db);
    state = createExporterState();
    const metrics = createMetrics(db, state, {
      maxLabelCardinality: 10,
      version: 't',
      collectProcessMetrics: false,
    });
    scheduler = new ImportScheduler(importer, db, state, metrics, silentLogger, {
      eventsDir,
      pollIntervalMs: 100,
      watch,
    });
  };

  beforeEach(() => {
    dir = tempDir();
    eventsDir = join(dir.path, 'events');
    mkdirSync(eventsDir);
    db = new ExporterDatabase(join(dir.path, 'db.sqlite'));
  });
  afterEach(async () => {
    await scheduler.stop();
    db.close();
    dir.cleanup();
  });

  it('keeps importing after start (regression: import ran only once)', async () => {
    make(false);
    writeFileSync(join(eventsDir, 'a.jsonl'), line(makeEvent()));
    await scheduler.start();
    expect(db.countEvents()).toBe(1);
    expect(state.lastSuccessMs).not.toBeNull();
    appendFileSync(join(eventsDir, 'a.jsonl'), line(makeEvent()));
    writeFileSync(join(eventsDir, 'b.jsonl'), line(makeEvent()));
    await waitFor(() => db.countEvents() === 3 && state.filesTracked === 2);
  });

  it('stop() waits for the in-flight cycle and prevents further cycles', async () => {
    make(true);
    await scheduler.start();
    writeFileSync(
      join(eventsDir, 'a.jsonl'),
      Array.from({ length: 3000 }, () => line(makeEvent())).join('')
    );
    scheduler.trigger();
    await scheduler.stop();
    const n = db.countEvents();
    await new Promise(r => setTimeout(r, 300));
    expect(db.countEvents()).toBe(n);
  });
});
