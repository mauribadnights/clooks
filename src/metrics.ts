// clooks metrics and observability

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { METRICS_FILE } from './constants.js';
import type { MetricEntry, HookEvent } from './types.js';

interface AggregatedStats {
  event: string;
  fires: number;
  errors: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
}

export class MetricsCollector {
  private entries: MetricEntry[] = [];

  /** Record a metric entry in memory and append to disk. */
  record(entry: MetricEntry): void {
    this.entries.push(entry);
    try {
      const dir = dirname(METRICS_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
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
    const all = this.loadAll().filter((e) => {
      // MetricEntry doesn't have session_id, but we stored it in the entry if available
      return (e as MetricEntry & { session_id?: string }).session_id === sessionId;
    });

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

function padRow(cols: string[]): string {
  const widths = [20, 8, 8, 10, 10, 10];
  return cols.map((col, i) => col.padEnd(widths[i])).join('  ');
}
