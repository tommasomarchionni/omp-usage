import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ExporterDatabase } from './database.js';
import { Importer, type FileResetReason } from './importer.js';
import { line, makeEvent, tempDir } from '../test/helpers.js';

describe('Importer', () => {
  let dir: ReturnType<typeof tempDir>;
  let eventsDir: string;
  let db: ExporterDatabase;
  let importer: Importer;
  let resets: Array<[string, FileResetReason]>;

  const make = (opts: { maxLineLength?: number; batchSize?: number; chunkSize?: number } = {}) => {
    importer = new Importer(
      { eventsDir, maxLineLength: opts.maxLineLength ?? 1_048_576, ...opts },
      db
    );
    resets = [];
    importer.on('reset', (f, r) => resets.push([f, r]));
    importer.on('warning', () => {});
    importer.on('error', () => {});
  };

  beforeEach(() => {
    dir = tempDir();
    eventsDir = join(dir.path, 'events');
    mkdirSync(eventsDir);
    db = new ExporterDatabase(join(dir.path, 'exporter.db'));
    make();
  });
  afterEach(async () => {
    await importer.stop();
    db.close();
    dir.cleanup();
  });

  const file = (name = 'a.jsonl') => join(eventsDir, name);
  const input = () => db.getAggregates().reduce((s, a) => s + a.inputTokens, 0);

  it('imports valid lines and ignores blank lines', async () => {
    writeFileSync(file(), '\n' + line(makeEvent()) + '\r\n' + line(makeEvent()));
    const r = await importer.importAll();
    expect(r).toMatchObject({ imported: 2, invalid: 0, files: 1, fileErrors: 0 });
  });

  it('keeps a cumulative byte cursor across batches (regression)', async () => {
    make({ batchSize: 2 });
    const content = Array.from({ length: 5 }, () => line(makeEvent())).join('');
    writeFileSync(file(), content);
    await importer.importAll();
    expect(db.getCursor(file())?.offset).toBe(Buffer.byteLength(content));
    // A restart must not re-read anything.
    make({ batchSize: 2 });
    const r = await importer.importAll();
    expect(r.imported + r.duplicates).toBe(0);
  });

  it('only processes newline-terminated lines and resumes the partial tail', async () => {
    const full = line(makeEvent());
    const partial = line(makeEvent());
    writeFileSync(file(), full + partial.slice(0, 40));
    let r = await importer.importAll();
    expect(r.imported).toBe(1);
    expect(db.getCursor(file())?.offset).toBe(Buffer.byteLength(full));
    appendFileSync(file(), partial.slice(40));
    r = await importer.importAll();
    expect(r.imported).toBe(1);
  });

  it('handles multi-byte UTF-8 split across read chunks', async () => {
    make({ chunkSize: 7 });
    writeFileSync(file(), line(makeEvent({ model: 'modèle-测试-🚀' })));
    const r = await importer.importAll();
    expect(r.imported).toBe(1);
    expect(db.getAggregates()[0]?.model).toBe('modèle-测试-🚀');
  });

  it('advances the cursor past invalid lines and counts them once (regression)', async () => {
    writeFileSync(
      file(),
      'not json\n' +
        line({ ...makeEvent(), schemaVersion: 999 }) +
        line({ ...makeEvent(), usage: { input: -1 } }) +
        line(makeEvent())
    );
    let r = await importer.importAll();
    expect(r).toMatchObject({ imported: 1, invalid: 3 });
    r = await importer.importAll();
    expect(r).toMatchObject({ imported: 0, invalid: 0 });
    expect(db.getInvalidRecordCounts()).toEqual({
      invalid_json: 1,
      unknown_schema_version: 1,
      invalid_schema: 1,
    });
  });

  it('rejects NaN-like and non-finite values via schema', async () => {
    writeFileSync(file(), '{"schemaVersion":1,"usage":{"input":1e999}}\n');
    const r = await importer.importAll();
    expect(r.invalid).toBe(1);
  });

  it('skips over-long lines without loading them and continues', async () => {
    make({ maxLineLength: 64, chunkSize: 16 });
    writeFileSync(file(), 'x'.repeat(500) + '\n' + 'y'.repeat(10) + '\n');
    const r = await importer.importAll();
    expect(r.invalid).toBe(2); // long line + "yyyy" (invalid JSON)
    expect(db.getInvalidRecordCounts()).toMatchObject({ line_too_long: 1, invalid_json: 1 });
  });

  it('reports invalid UTF-8', async () => {
    writeFileSync(file(), Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a])]));
    await importer.importAll();
    expect(db.getInvalidRecordCounts()).toEqual({ invalid_utf8: 1 });
  });

  it('re-reads a truncated file from the start without double counting', async () => {
    const a = line(makeEvent());
    const b = line(makeEvent());
    writeFileSync(file(), a + b);
    await importer.importAll();
    truncateSync(file(), 0);
    const c = line(makeEvent());
    writeFileSync(file(), c);
    const r = await importer.importAll();
    expect(resets).toEqual([[file(), 'truncated']]);
    expect(r.imported).toBe(1);
    expect(db.countEvents()).toBe(3);
  });

  it('detects a replaced file (new inode) and re-reads it', async () => {
    const e1 = makeEvent();
    writeFileSync(file(), line(e1));
    await importer.importAll();
    const tmp = join(eventsDir, 'a.jsonl.tmp');
    writeFileSync(tmp, line(e1) + line(makeEvent()) + line(makeEvent()));
    renameSync(tmp, file());
    const r = await importer.importAll();
    expect(resets.map(x => x[1])).toEqual(['replaced']);
    expect(r).toMatchObject({ imported: 2, duplicates: 1 });
  });

  it('detects a file rewritten in place with the same size', async () => {
    const e1 = makeEvent({ eventId: '550e8400-e29b-41d4-a716-446655440001' });
    const e2 = makeEvent({
      eventId: '550e8400-e29b-41d4-a716-446655440002',
      usage: { input: 22222, output: 99, cost: { total: 0.5 } },
    });
    writeFileSync(file(), line(e1));
    await importer.importAll();
    writeFileSync(file(), line(e2) + line(makeEvent())); // same inode, larger, different prefix
    const r = await importer.importAll();
    expect(resets.map(x => x[1])).toEqual(['rewritten']);
    expect(r.imported).toBe(2);
  });

  it('treats a renamed file as new and relies on event ids for dedup', async () => {
    writeFileSync(file(), line(makeEvent()));
    await importer.importAll();
    renameSync(file(), file('b.jsonl'));
    const r = await importer.importAll();
    expect(r).toMatchObject({ imported: 0, duplicates: 1 });
    expect(input()).toBe(11351);
  });

  it('ignores symlinks and non-jsonl files', async () => {
    const outside = join(dir.path, 'secret.jsonl');
    writeFileSync(outside, line(makeEvent()));
    symlinkSync(outside, file('link.jsonl'));
    writeFileSync(file('notes.txt'), line(makeEvent()));
    mkdirSync(file('dir.jsonl'));
    const r = await importer.importAll();
    expect(r.imported).toBe(0);
  });

  it('returns an empty result when the events directory does not exist', async () => {
    rmSync(eventsDir, { recursive: true });
    const r = await importer.importAll();
    expect(r).toMatchObject({ imported: 0, files: 0, fileErrors: 0 });
  });

  it('shares a single in-flight cycle between concurrent callers', async () => {
    writeFileSync(file(), line(makeEvent()));
    const [a, b] = await Promise.all([importer.importAll(), importer.importAll()]);
    expect(a).toBe(b);
    expect(db.countEvents()).toBe(1);
  });

  it('stop() waits for the current batch and leaves a consistent cursor', async () => {
    make({ batchSize: 10 });
    const lines = Array.from({ length: 2000 }, () => line(makeEvent()));
    writeFileSync(file(), lines.join(''));
    const p = importer.importAll();
    await new Promise(r => setImmediate(r));
    await importer.stop();
    await p;
    const count = db.countEvents();
    const offset = db.getCursor(file())?.offset ?? 0;
    // Cursor always points exactly after the last committed line.
    expect(offset).toBe(Buffer.byteLength(lines.slice(0, count).join('')));
    expect(count % 10).toBe(0);
  });
});
