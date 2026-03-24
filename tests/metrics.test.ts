import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MetricEntry } from '../src/types.js';

// We need to mock the METRICS_FILE constant so the MetricsCollector writes to a temp location
let tmpDir: string;
let metricsFile: string;

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/constants.js')>();
  return {
    ...original,
    get METRICS_FILE() {
      return metricsFile;
    },
  };
});

// Import after mock is set up
const { MetricsCollector } = await import('../src/metrics.js');

describe('metrics', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-metrics-'));
    metricsFile = join(tmpDir, 'metrics.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(overrides?: Partial<MetricEntry>): MetricEntry {
    return {
      ts: new Date().toISOString(),
      event: 'PostToolUse',
      handler: 'test-handler',
      duration_ms: 42,
      ok: true,
      ...overrides,
    };
  }

  it('records entries and persists to disk', () => {
    const collector = new MetricsCollector();
    collector.record(makeEntry());
    collector.record(makeEntry({ handler: 'other', duration_ms: 100 }));

    expect(existsSync(metricsFile)).toBe(true);

    const { readFileSync } = require('fs');
    const lines = readFileSync(metricsFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.handler).toBe('test-handler');
  });

  it('returns aggregated stats per event', () => {
    const collector = new MetricsCollector();
    collector.record(makeEntry({ event: 'PostToolUse', duration_ms: 10 }));
    collector.record(makeEntry({ event: 'PostToolUse', duration_ms: 20 }));
    collector.record(makeEntry({ event: 'PreToolUse', duration_ms: 5 }));
    collector.record(makeEntry({ event: 'PostToolUse', duration_ms: 30, ok: false, error: 'fail' }));

    const stats = collector.getStats();

    // PostToolUse should come first (3 fires > 1 fire)
    expect(stats[0].event).toBe('PostToolUse');
    expect(stats[0].fires).toBe(3);
    expect(stats[0].errors).toBe(1);
    expect(stats[0].avgDuration).toBeCloseTo(20, 0);
    expect(stats[0].minDuration).toBe(10);
    expect(stats[0].maxDuration).toBe(30);

    expect(stats[1].event).toBe('PreToolUse');
    expect(stats[1].fires).toBe(1);
    expect(stats[1].errors).toBe(0);
  });

  it('formats stats table correctly', () => {
    const collector = new MetricsCollector();
    collector.record(makeEntry({ event: 'PostToolUse', duration_ms: 50 }));
    collector.record(makeEntry({ event: 'PostToolUse', duration_ms: 100, ok: false, error: 'err' }));

    const table = collector.formatStatsTable();

    expect(table).toContain('Event');
    expect(table).toContain('Fires');
    expect(table).toContain('Errors');
    expect(table).toContain('PostToolUse');
    expect(table).toContain('Total fires: 2');
    expect(table).toContain('Total errors: 1');
    expect(table).toContain('Spawns saved: ~2');
  });

  it('returns "No metrics recorded yet." when empty', () => {
    const collector = new MetricsCollector();
    const table = collector.formatStatsTable();
    expect(table).toBe('No metrics recorded yet.');
  });

  it('estimates spawns saved as total entry count', () => {
    const collector = new MetricsCollector();
    collector.record(makeEntry());
    collector.record(makeEntry());
    collector.record(makeEntry());

    expect(collector.estimateSpawnsSaved()).toBe(3);
  });

  it('estimates 0 spawns saved when no entries', () => {
    const collector = new MetricsCollector();
    expect(collector.estimateSpawnsSaved()).toBe(0);
  });
});
