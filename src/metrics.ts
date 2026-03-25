// clooks metrics and observability

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { dirname } from 'path';
import { METRICS_FILE, COSTS_FILE } from './constants.js';
import type { MetricEntry, HookEvent, CostEntry } from './types.js';

interface AggregatedStats {
  event: string;
  fires: number;
  errors: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
}

export interface HandlerStats {
  handler: string;
  event: string;
  fires: number;
  errors: number;
  filtered: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
}

export class MetricsCollector {
  private static readonly MAX_ENTRIES = 1000;
  private entries: MetricEntry[] = [];
  private ringIndex = 0;
  private totalRecorded = 0;

  private static readonly METRICS_MAX_BYTES = 5 * 1024 * 1024; // 5MB
  private static readonly COSTS_MAX_BYTES = 1 * 1024 * 1024;  // 1MB

  /** Rotate a log file if it exceeds maxBytes. Keeps one backup (.1). */
  private rotateIfNeeded(filePath: string, maxBytes: number): void {
    try {
      if (!existsSync(filePath)) return;
      const stat = statSync(filePath);
      if (stat.size >= maxBytes) {
        renameSync(filePath, filePath + '.1');
      }
    } catch {
      // Non-critical — rotation failure is not fatal
    }
  }

  /** Record a metric entry in memory (ring buffer) and append to disk. */
  record(entry: MetricEntry): void {
    // Ring buffer: overwrite oldest when full
    if (this.entries.length < MetricsCollector.MAX_ENTRIES) {
      this.entries.push(entry);
    } else {
      this.entries[this.ringIndex] = entry;
      this.ringIndex = (this.ringIndex + 1) % MetricsCollector.MAX_ENTRIES;
    }
    this.totalRecorded++;
    try {
      const dir = dirname(METRICS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.rotateIfNeeded(METRICS_FILE, MetricsCollector.METRICS_MAX_BYTES);
      appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Non-critical — metrics should not crash the daemon
    }
  }

  /** Get aggregated stats per event type. */
  getStats(): AggregatedStats[] {
    const all = this.loadAll();
    const byEvent = new Map<string, MetricEntry[]>();

    for (const entry of all) {
      const existing = byEvent.get(entry.event) ?? [];
      existing.push(entry);
      byEvent.set(entry.event, existing);
    }

    const stats: AggregatedStats[] = [];
    for (const [event, entries] of byEvent) {
      const durations = entries.map((e) => e.duration_ms);
      stats.push({
        event,
        fires: entries.length,
        errors: entries.filter((e) => !e.ok).length,
        avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
        minDuration: Math.min(...durations),
        maxDuration: Math.max(...durations),
      });
    }

    return stats.sort((a, b) => b.fires - a.fires);
  }

  /** Get stats for a specific session. */
  getSessionStats(sessionId: string): AggregatedStats[] {
    const all = this.loadAll().filter((e) => e.session_id === sessionId);

    const byEvent = new Map<string, MetricEntry[]>();
    for (const entry of all) {
      const existing = byEvent.get(entry.event) ?? [];
      existing.push(entry);
      byEvent.set(entry.event, existing);
    }

    const stats: AggregatedStats[] = [];
    for (const [event, entries] of byEvent) {
      const durations = entries.map((e) => e.duration_ms);
      stats.push({
        event,
        fires: entries.length,
        errors: entries.filter((e) => !e.ok).length,
        avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
        minDuration: Math.min(...durations),
        maxDuration: Math.max(...durations),
      });
    }

    return stats.sort((a, b) => b.fires - a.fires);
  }

  /** Get per-handler stats (not just per-event). */
  getHandlerStats(): HandlerStats[] {
    const all = this.loadAll();
    const byHandler = new Map<string, MetricEntry[]>();

    for (const entry of all) {
      const existing = byHandler.get(entry.handler) ?? [];
      existing.push(entry);
      byHandler.set(entry.handler, existing);
    }

    const stats: HandlerStats[] = [];
    for (const [handler, entries] of byHandler) {
      const durations = entries.map((e) => e.duration_ms);
      stats.push({
        handler,
        event: entries[0].event,
        fires: entries.length,
        errors: entries.filter((e) => !e.ok).length,
        filtered: entries.filter((e) => e.filtered).length,
        avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
        minDuration: Math.min(...durations),
        maxDuration: Math.max(...durations),
      });
    }

    return stats.sort((a, b) => {
      if (b.fires !== a.fires) return b.fires - a.fires;
      return b.avgDuration - a.avgDuration;
    });
  }

  /** Format per-handler stats as a CLI-friendly table. */
  formatHandlerStatsTable(): string {
    const stats = this.getHandlerStats();
    if (stats.length === 0) {
      return 'No per-handler metrics recorded yet.';
    }

    const header = padHandlerRow(['Handler', 'Event', 'Fires', 'Errors', 'Avg ms', 'Max ms']);
    const separator = '-'.repeat(header.length);
    const rows = stats.map((s) =>
      padHandlerRow([
        s.handler,
        s.event,
        String(s.fires),
        String(s.errors),
        s.avgDuration.toFixed(1),
        s.maxDuration.toFixed(1),
      ])
    );

    return [header, separator, ...rows].join('\n');
  }

  /** Flush is a no-op since we append on every record, but provided for API completeness. */
  flush(): void {
    // Already written on each record()
  }

  /** Format stats as a CLI-friendly table. */
  formatStatsTable(): string {
    const stats = this.getStats();
    if (stats.length === 0) {
      return 'No metrics recorded yet.';
    }

    const header = padRow(['Event', 'Fires', 'Errors', 'Avg (ms)', 'Min (ms)', 'Max (ms)']);
    const separator = '-'.repeat(header.length);
    const rows = stats.map((s) =>
      padRow([
        s.event,
        String(s.fires),
        String(s.errors),
        s.avgDuration.toFixed(1),
        s.minDuration.toFixed(1),
        s.maxDuration.toFixed(1),
      ])
    );

    const totalFires = stats.reduce((sum, s) => sum + s.fires, 0);
    const totalErrors = stats.reduce((sum, s) => sum + s.errors, 0);
    const footer = `\nTotal fires: ${totalFires} | Total errors: ${totalErrors} | Spawns saved: ~${totalFires}`;

    return [header, separator, ...rows, footer].join('\n');
  }

  /** Estimate how many process spawns were saved. */
  estimateSpawnsSaved(): number {
    const all = this.loadAll();
    return all.length;
  }

  // --- Cost tracking ---

  /** Track a cost entry — appends to costs.jsonl. */
  trackCost(entry: CostEntry): void {
    try {
      const dir = dirname(COSTS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.rotateIfNeeded(COSTS_FILE, MetricsCollector.COSTS_MAX_BYTES);
      appendFileSync(COSTS_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Non-critical — cost tracking should not crash the daemon
    }
  }

  /** Get cost statistics from persisted cost entries. */
  getCostStats(): { totalCost: number; totalTokens: number; byModel: Record<string, { cost: number; tokens: number }>; byHandler: Record<string, { cost: number; tokens: number; calls: number }> } {
    const entries = this.loadCosts();
    let totalCost = 0;
    let totalTokens = 0;
    const byModel: Record<string, { cost: number; tokens: number }> = {};
    const byHandler: Record<string, { cost: number; tokens: number; calls: number }> = {};

    for (const entry of entries) {
      totalCost += entry.cost_usd;
      const tokens = entry.usage.input_tokens + entry.usage.output_tokens;
      totalTokens += tokens;

      // By model
      if (!byModel[entry.model]) {
        byModel[entry.model] = { cost: 0, tokens: 0 };
      }
      byModel[entry.model].cost += entry.cost_usd;
      byModel[entry.model].tokens += tokens;

      // By handler
      if (!byHandler[entry.handler]) {
        byHandler[entry.handler] = { cost: 0, tokens: 0, calls: 0 };
      }
      byHandler[entry.handler].cost += entry.cost_usd;
      byHandler[entry.handler].tokens += tokens;
      byHandler[entry.handler].calls++;
    }

    return { totalCost, totalTokens, byModel, byHandler };
  }

  /** Format cost data as a CLI-friendly table. */
  formatCostTable(): string {
    const entries = this.loadCosts();
    if (entries.length === 0) {
      return 'No LLM cost data recorded yet.';
    }

    const stats = this.getCostStats();
    const lines: string[] = [];

    lines.push('LLM Cost Summary');
    lines.push(`  Total: $${stats.totalCost.toFixed(4)} (${formatTokenCount(stats.totalTokens)} tokens)`);
    lines.push('');

    // By Model
    lines.push('  By Model:');
    for (const [model, data] of Object.entries(stats.byModel)) {
      lines.push(`    ${model.padEnd(22)} $${data.cost.toFixed(4)} (${formatTokenCount(data.tokens)} tokens)`);
    }
    lines.push('');

    // By Handler
    lines.push('  By Handler:');
    for (const [handler, data] of Object.entries(stats.byHandler)) {
      const avgTokens = data.calls > 0 ? Math.round(data.tokens / data.calls) : 0;
      lines.push(`    ${handler.padEnd(22)} $${data.cost.toFixed(4)} (${data.calls} calls, avg ${avgTokens} tokens)`);
    }

    // Batching savings estimate
    const batchedCount = entries.filter(e => e.batched).length;
    const unbatchedCount = entries.length - batchedCount;
    if (batchedCount > 0) {
      // Estimate: batched calls saved roughly (batchedCount - unique_batch_calls) API calls
      // Simple heuristic: batched entries share cost, individual would each cost input overhead
      const batchedCost = entries.filter(e => e.batched).reduce((s, e) => s + e.cost_usd, 0);
      // Rough estimate: without batching, each would have its own input tokens overhead
      const estimatedIndividualCost = batchedCost * 2; // conservative 2x estimate
      const saved = estimatedIndividualCost - batchedCost;
      if (saved > 0) {
        const pct = Math.round((saved / (stats.totalCost + saved)) * 100);
        lines.push('');
        lines.push(`  Batching saved: ~$${saved.toFixed(4)} (~${pct}% of what individual calls would cost)`);
      }
    }

    return lines.join('\n');
  }

  /** Load cost entries from disk. */
  private loadCosts(): CostEntry[] {
    if (!existsSync(COSTS_FILE)) {
      return [];
    }
    try {
      const raw = readFileSync(COSTS_FILE, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line) as CostEntry);
    } catch {
      return [];
    }
  }

  /** Load all entries from disk + memory (deduped by combining disk file). */
  private loadAll(): MetricEntry[] {
    if (!existsSync(METRICS_FILE)) {
      return [...this.entries];
    }

    try {
      const raw = readFileSync(METRICS_FILE, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line) as MetricEntry);
    } catch {
      return [...this.entries];
    }
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function padRow(cols: string[]): string {
  const widths = [20, 8, 8, 10, 10, 10];
  return cols.map((col, i) => col.padEnd(widths[i])).join('  ');
}

function padHandlerRow(cols: string[]): string {
  const widths = [35, 20, 7, 7, 8, 8];
  return cols.map((col, i) => col.padEnd(widths[i])).join('  ');
}
