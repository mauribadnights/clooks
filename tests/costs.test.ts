import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CostEntry } from '../src/types.js';

// Mock constants to use temp directories — NEVER write to real ~/.clooks
let tmpDir: string;
let costsFile: string;
let metricsFile: string;

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/constants.js')>();
  return {
    ...original,
    get COSTS_FILE() {
      return costsFile;
    },
    get METRICS_FILE() {
      return metricsFile;
    },
  };
});

const { MetricsCollector } = await import('../src/metrics.js');

function makeCostEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    ts: new Date().toISOString(),
    event: 'PostToolUse',
    handler: 'test-llm-handler',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 1000, output_tokens: 500 },
    cost_usd: 0.0028,
    batched: false,
    ...overrides,
  };
}

describe('cost tracking', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-costs-'));
    // Safety assertions: paths MUST be in temp dir
    expect(tmpDir).toContain(tmpdir());
    costsFile = join(tmpDir, 'costs.jsonl');
    metricsFile = join(tmpDir, 'metrics.jsonl');
    expect(costsFile).toContain(tmpDir);
    expect(metricsFile).toContain(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('trackCost() writes to costs.jsonl', () => {
    const collector = new MetricsCollector();
    const entry = makeCostEntry();
    collector.trackCost(entry);

    expect(existsSync(costsFile)).toBe(true);
    const raw = readFileSync(costsFile, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.handler).toBe('test-llm-handler');
    expect(parsed.cost_usd).toBe(0.0028);
  });

  it('trackCost() appends multiple entries', () => {
    const collector = new MetricsCollector();
    collector.trackCost(makeCostEntry({ handler: 'h1', cost_usd: 0.001 }));
    collector.trackCost(makeCostEntry({ handler: 'h2', cost_usd: 0.002 }));
    collector.trackCost(makeCostEntry({ handler: 'h3', cost_usd: 0.003 }));

    const lines = readFileSync(costsFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('getCostStats() aggregates by model and handler', () => {
    const collector = new MetricsCollector();
    collector.trackCost(makeCostEntry({
      handler: 'analyzer',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 1000, output_tokens: 500 },
      cost_usd: 0.003,
    }));
    collector.trackCost(makeCostEntry({
      handler: 'analyzer',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 2000, output_tokens: 1000 },
      cost_usd: 0.006,
    }));
    collector.trackCost(makeCostEntry({
      handler: 'summarizer',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 500, output_tokens: 200 },
      cost_usd: 0.0045,
    }));

    const stats = collector.getCostStats();

    // Total cost
    expect(stats.totalCost).toBeCloseTo(0.0135, 4);
    // Total tokens
    expect(stats.totalTokens).toBe(1000 + 500 + 2000 + 1000 + 500 + 200);

    // By model
    expect(stats.byModel['claude-haiku-4-5'].cost).toBeCloseTo(0.009, 4);
    expect(stats.byModel['claude-sonnet-4-6'].cost).toBeCloseTo(0.0045, 4);

    // By handler
    expect(stats.byHandler['analyzer'].calls).toBe(2);
    expect(stats.byHandler['analyzer'].cost).toBeCloseTo(0.009, 4);
    expect(stats.byHandler['summarizer'].calls).toBe(1);
  });

  it('formatCostTable() returns formatted string with model and handler info', () => {
    const collector = new MetricsCollector();
    collector.trackCost(makeCostEntry({
      handler: 'analyzer',
      model: 'claude-haiku-4-5',
      cost_usd: 0.005,
    }));
    collector.trackCost(makeCostEntry({
      handler: 'summarizer',
      model: 'claude-sonnet-4-6',
      cost_usd: 0.015,
      batched: true,
    }));

    const table = collector.formatCostTable();

    expect(table).toContain('LLM Cost Summary');
    expect(table).toContain('Total:');
    expect(table).toContain('By Model:');
    expect(table).toContain('claude-haiku-4-5');
    expect(table).toContain('claude-sonnet-4-6');
    expect(table).toContain('By Handler:');
    expect(table).toContain('analyzer');
    expect(table).toContain('summarizer');
  });

  it('empty costs returns appropriate message', () => {
    const collector = new MetricsCollector();
    const table = collector.formatCostTable();
    expect(table).toBe('No LLM cost data recorded yet.');
  });

  it('getCostStats() returns zeros when no entries', () => {
    const collector = new MetricsCollector();
    const stats = collector.getCostStats();
    expect(stats.totalCost).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(Object.keys(stats.byModel)).toHaveLength(0);
    expect(Object.keys(stats.byHandler)).toHaveLength(0);
  });

  it('formatCostTable() shows batching savings when batched entries exist', () => {
    const collector = new MetricsCollector();
    collector.trackCost(makeCostEntry({ batched: true, cost_usd: 0.01 }));
    collector.trackCost(makeCostEntry({ batched: true, cost_usd: 0.02 }));

    const table = collector.formatCostTable();
    expect(table).toContain('Batching saved');
  });
});
