import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MetricEntry } from '../src/types.js';

// We need to mock the METRICS_FILE and COSTS_FILE constants so the MetricsCollector writes to a temp location
let tmpDir: string;
let metricsFile: string;
let costsFile: string;

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/constants.js')>();
  return {
    ...original,
    get METRICS_FILE() {
      return metricsFile;
    },
    get COSTS_FILE() {
      return costsFile;
    },
  };
});

// Import after mock is set up
const { MetricsCollector } = await import('../src/metrics.js');

describe('metrics', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-metrics-'));
    metricsFile = join(tmpDir, 'metrics.jsonl');
    costsFile = join(tmpDir, 'costs.jsonl');
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

  // --- session_id tests ---

  it('records session_id in metric entries', () => {
    const collector = new MetricsCollector();
    collector.record(makeEntry({ session_id: 'sess-123' }));

    const lines = readFileSync(metricsFile, 'utf-8').trim().split('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.session_id).toBe('sess-123');
  });

  it('filters by session_id in getSessionStats()', () => {
    const collector = new MetricsCollector();
    collector.record(makeEntry({ session_id: 'sess-A', event: 'PostToolUse', duration_ms: 10 }));
    collector.record(makeEntry({ session_id: 'sess-A', event: 'PostToolUse', duration_ms: 20 }));
    collector.record(makeEntry({ session_id: 'sess-B', event: 'PostToolUse', duration_ms: 100 }));
    collector.record(makeEntry({ session_id: 'sess-A', event: 'PreToolUse', duration_ms: 5 }));

    const statsA = collector.getSessionStats('sess-A');
    const totalFiresA = statsA.reduce((sum, s) => sum + s.fires, 0);
    expect(totalFiresA).toBe(3);

    const statsB = collector.getSessionStats('sess-B');
    const totalFiresB = statsB.reduce((sum, s) => sum + s.fires, 0);
    expect(totalFiresB).toBe(1);

    const statsNone = collector.getSessionStats('sess-nonexistent');
    expect(statsNone).toHaveLength(0);
  });

  // --- log rotation tests ---

  it('rotates metrics.jsonl when it exceeds 5MB', () => {
    const collector = new MetricsCollector();

    // Write a 5MB+ file to simulate an oversized log
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1);
    writeFileSync(metricsFile, bigContent, 'utf-8');

    // Record one more entry — should trigger rotation
    collector.record(makeEntry({ handler: 'after-rotation' }));

    // The old file should have been rotated to .1
    const rotatedFile = metricsFile + '.1';
    expect(existsSync(rotatedFile)).toBe(true);

    // The new metrics file should contain only the new entry
    const newContent = readFileSync(metricsFile, 'utf-8').trim();
    const lines = newContent.split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).handler).toBe('after-rotation');
  });

  it('rotates costs.jsonl when it exceeds 1MB', () => {
    const collector = new MetricsCollector();

    // Write a 1MB+ file to simulate an oversized cost log
    const bigContent = 'x'.repeat(1 * 1024 * 1024 + 1);
    writeFileSync(costsFile, bigContent, 'utf-8');

    // Track one more cost — should trigger rotation
    collector.trackCost({
      ts: new Date().toISOString(),
      event: 'PostToolUse',
      handler: 'after-rotation',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 100, output_tokens: 50 },
      cost_usd: 0.001,
      batched: false,
    });

    const rotatedFile = costsFile + '.1';
    expect(existsSync(rotatedFile)).toBe(true);

    const newContent = readFileSync(costsFile, 'utf-8').trim();
    const lines = newContent.split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).handler).toBe('after-rotation');
  });

  it('does not rotate when file is under threshold', () => {
    const collector = new MetricsCollector();

    // Write a small file
    writeFileSync(metricsFile, 'small content\n', 'utf-8');

    collector.record(makeEntry({ handler: 'small' }));

    // No rotation should have happened
    const rotatedFile = metricsFile + '.1';
    expect(existsSync(rotatedFile)).toBe(false);

    // File should have both old content and new entry
    const content = readFileSync(metricsFile, 'utf-8');
    expect(content).toContain('small content');
    expect(content).toContain('"handler":"small"');
  });
});
