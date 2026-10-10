import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventWriter, createPluginConfig, parseRetentionDays, resolveEventsDir } from './writer.js';
import { createUsageEvent, extractAssistantMessageData } from './events.js';
import { DEFAULT_PLUGIN_CONFIG, type PluginConfig, type UsageEvent } from './types.js';

const event = (): UsageEvent =>
  createUsageEvent(
    'run',
    extractAssistantMessageData({
      role: 'assistant',
      provider: 'p',
      model: 'm',
      usage: { input: 1 },
    })!
  );
const tick = () => new Promise(r => setImmediate(r));

describe('EventWriter', () => {
  let dir: string;
  let config: PluginConfig;
  let writer: EventWriter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omp-usage-writer-'));
    config = { ...DEFAULT_PLUGIN_CONFIG, eventsDir: join(dir, 'events'), flushIntervalMs: 20 };
    writer = new EventWriter(randomUUID(), config);
  });
  afterEach(async () => {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = () =>
    readFileSync(writer.getFilePath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as UsageEvent);

  it('creates the directory and file with restrictive permissions', async () => {
    writer.write(event());
    await tick();
    expect(statSync(config.eventsDir).mode & 0o777).toBe(0o700);
    expect(statSync(writer.getFilePath()).mode & 0o777).toBe(0o600);
  });

  it('writes events right after the current tick, batched into complete lines', async () => {
    const a = event();
    const b = event();
    writer.write(a);
    writer.write(b);
    expect(existsSync(writer.getFilePath())).toBe(false); // still in the same tick
    await tick();
    expect(lines().map(e => e.eventId)).toEqual([a.eventId, b.eventId]);
    expect(readFileSync(writer.getFilePath(), 'utf8').endsWith('\n')).toBe(true);
    expect(writer.getStats()).toMatchObject({ written: 2, queued: 0, dropped: 0 });
  });

  it('counts events dropped when the queue is full', async () => {
    await writer.close();
    writer = new EventWriter(randomUUID(), { ...config, maxQueueSize: 2 });
    expect([writer.write(event()), writer.write(event()), writer.write(event())]).toEqual([
      true,
      true,
      false,
    ]);
    expect(writer.getStats().dropped).toBe(1);
    await tick();
    expect(writer.getStats().written).toBe(2);
  });

  it('keeps events and retries after a write failure', async () => {
    chmodSync(config.eventsDir, 0o500); // read-only directory
    try {
      writer.write(event());
      await tick();
      if (process.getuid?.() === 0) return; // root ignores permissions
      expect(writer.getStats()).toMatchObject({ written: 0, queued: 1 });
      expect(writer.getStats().writeErrors).toBeGreaterThan(0);
    } finally {
      chmodSync(config.eventsDir, 0o700);
    }
    await vi.waitFor(() => expect(writer.getStats().written).toBe(1), { timeout: 2000 });
  });

  it('re-creates the file if it is deleted while the session runs', async () => {
    writer.write(event());
    await tick();
    unlinkSync(writer.getFilePath());
    writer.write(event());
    await tick();
    expect(lines()).toHaveLength(1);
  });

  it('refuses to follow a symlink planted at the session file path', async () => {
    const target = join(dir, 'target');
    writeFileSync(target, '');
    symlinkSync(target, writer.getFilePath());
    writer.write(event());
    await tick();
    expect(readFileSync(target, 'utf8')).toBe('');
    expect(writer.getStats().writeErrors).toBeGreaterThan(0);
  });

  it('flushes on close and rejects writes afterwards', async () => {
    writer.write(event());
    await writer.close();
    expect(lines()).toHaveLength(1);
    expect(writer.write(event())).toBe(false);
    expect(writer.getStats().dropped).toBe(1);
    await writer.close(); // idempotent
  });

  it('does not delete anything when retention is off (default)', async () => {
    expect(DEFAULT_PLUGIN_CONFIG.retentionDays).toBeNull();
    const oldFile = join(config.eventsDir, 'old.jsonl');
    writeFileSync(oldFile, '{}\n');
    const t = (Date.now() - 365 * 86_400_000) / 1000;
    utimesSync(oldFile, t, t);
    expect(writer.pruneOldFiles()).toBe(0);
    expect(existsSync(oldFile)).toBe(true);
  });

  it('opt-in retention deletes old regular files only', async () => {
    const oldFile = join(config.eventsDir, 'old.jsonl');
    const link = join(config.eventsDir, 'link.jsonl');
    const other = join(config.eventsDir, 'notes.txt');
    writeFileSync(oldFile, '{}\n');
    writeFileSync(other, 'x');
    symlinkSync(join(dir, 'nowhere'), link);
    const t = (Date.now() - 10 * 86_400_000) / 1000;
    for (const f of [oldFile, other]) utimesSync(f, t, t);
    expect(writer.setRetentionDays(7)).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});

describe('configuration', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('resolves ~ and defaults', () => {
    expect(resolveEventsDir('')).toMatch(/\.local\/state\/omp-usage\/events$/);
    expect(resolveEventsDir('~/x')).not.toContain('~');
  });

  it('reads env strictly and ignores invalid values', () => {
    process.env['OMP_USAGE_MAX_QUEUE_SIZE'] = '10abc';
    process.env['OMP_USAGE_FLUSH_INTERVAL_MS'] = '250';
    process.env['OMP_USAGE_RETENTION_DAYS'] = '14';
    const c = createPluginConfig();
    expect(c.maxQueueSize).toBe(DEFAULT_PLUGIN_CONFIG.maxQueueSize);
    expect(c.flushIntervalMs).toBe(250);
    expect(c.retentionDays).toBe(14);
  });

  it.each([
    ['off', null],
    ['0', null],
    ['', null],
    ['7', 7],
    ['-1', undefined],
    ['7days', undefined],
  ])('parseRetentionDays(%j) = %j', (input, expected) => {
    expect(parseRetentionDays(input)).toBe(expected);
  });
});
