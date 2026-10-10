import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { ExporterDatabase } from './database.js';
import {
  buildLabelMap,
  createExporterState,
  createMetrics,
  normalizeLabelValue,
  OVERFLOW_LABEL,
} from './metrics.js';
import type { FileCursor, UsageEvent } from './protocol.js';
import { makeEvent, tempDir } from '../test/helpers.js';

const cursor: FileCursor = {
  filePath: '/f',
  offset: 1,
  fileSize: 1,
  inode: 1,
  device: 1,
  mtimeMs: 0,
};

function value(text: string, name: string, labels: Record<string, string>): number | undefined {
  for (const l of text.split('\n')) {
    if (!l.startsWith(name + '{')) continue;
    if (Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
      return Number(l.split(' ').pop());
  }
  return undefined;
}

describe('normalizeLabelValue', () => {
  it('keeps provider/model names verbatim (regression: values were mangled)', () => {
    expect(normalizeLabelValue('openrouter/free')).toBe('openrouter/free');
    expect(normalizeLabelValue('qwen3.6-35b-a3b:Q4_K_M')).toBe('qwen3.6-35b-a3b:Q4_K_M');
  });
  it('replaces control characters and truncates', () => {
    expect(normalizeLabelValue('a\nb\u0000c')).toBe('a_b_c');
    expect(normalizeLabelValue('x'.repeat(300))).toHaveLength(128);
  });
});

describe('buildLabelMap', () => {
  it('folds pairs beyond the cardinality limit into _other', () => {
    const { map, exported, overflow } = buildLabelMap(
      [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3' },
      ],
      2
    );
    expect(exported).toBe(2);
    expect(overflow).toBe(1);
    expect(map.get('p3\u0000m3')).toEqual({ provider: OVERFLOW_LABEL, model: OVERFLOW_LABEL });
  });
});

describe('createMetrics', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: ExporterDatabase;
  beforeEach(() => {
    dir = tempDir();
    db = new ExporterDatabase(join(dir.path, 'db.sqlite'));
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('exposes counters computed from the database at scrape time, idempotently', async () => {
    const state = createExporterState();
    const { registry } = createMetrics(db, state, {
      maxLabelCardinality: 10,
      version: '1.2.3',
      collectProcessMetrics: false,
    });
    db.applyBatch({
      events: [
        makeEvent(),
        makeEvent({ stopReason: 'error' }),
        makeEvent({ usage: null }),
      ] as UsageEvent[],
      invalid: { invalid_json: 3 },
      cursor,
    });

    const first = await registry.metrics();
    const second = await registry.metrics();
    expect(second).toBe(first); // scraping twice never double counts

    const l = { provider: 'openrouter', model: 'openrouter/free' };
    expect(value(first, 'omp_llm_tokens_total', { ...l, direction: 'input' })).toBe(2 * 11351);
    expect(value(first, 'omp_llm_tokens_total', { ...l, direction: 'output' })).toBe(2 * 83);
    expect(value(first, 'omp_llm_reasoning_tokens_total', l)).toBe(142);
    expect(value(first, 'omp_llm_requests_total', { ...l, status: 'success' })).toBe(2);
    expect(value(first, 'omp_llm_requests_total', { ...l, status: 'error' })).toBe(1);
    expect(value(first, 'omp_llm_stop_reasons_total', { ...l, stop_reason: 'stop' })).toBe(2);
    expect(value(first, 'omp_llm_usage_missing_total', l)).toBe(1);
    expect(value(first, 'omp_usage_invalid_records_total', { reason: 'invalid_json' })).toBe(3);
    expect(first).toContain('omp_usage_build_info{version="1.2.3"');
    // 0 until the first successful import, so "time() - x" alerts fire.
    expect(first).toMatch(
      /omp_usage_last_import_timestamp_seconds\{app="omp-usage-exporter"\} 0\n/
    );

    db.applyBatch({ events: [makeEvent()] as UsageEvent[], invalid: {}, cursor });
    state.lastSuccessMs = 1_700_000_000_000;
    const third = await registry.metrics();
    expect(value(third, 'omp_llm_tokens_total', { ...l, direction: 'input' })).toBe(3 * 11351);
    expect(third).toMatch(
      /omp_usage_last_import_timestamp_seconds\{app="omp-usage-exporter"\} 1700000000/
    );
  });

  it('does not throw when scraped after the database is closed', async () => {
    const { registry } = createMetrics(db, createExporterState(), {
      maxLabelCardinality: 10,
      version: 'x',
      collectProcessMetrics: false,
    });
    db.close();
    await expect(registry.metrics()).resolves.toContain('omp_usage_build_info');
  });
});
