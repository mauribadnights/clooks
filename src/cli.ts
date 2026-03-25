#!/usr/bin/env node

// clooks CLI entry point

import { Command } from 'commander';
import { loadManifest, createDefaultManifest } from './manifest.js';
import { MetricsCollector } from './metrics.js';
import { startDaemon, stopDaemon, isDaemonRunning, startDaemonBackground } from './server.js';
import { migrate, restore } from './migrate.js';
import { runDoctor } from './doctor.js';
import { generateAuthToken } from './auth.js';
import { DEFAULT_PORT, CONFIG_DIR, PID_FILE } from './constants.js';
import { existsSync, readFileSync, mkdirSync } from 'fs';

const program = new Command();

program
  .name('clooks')
  .description('Persistent hook runtime for Claude Code')
  .version('0.2.1');

// --- start ---
program
  .command('start')
  .description('Start the clooks daemon')
  .option('-f, --foreground', 'Run in foreground (default: background/detached)')
  .option('--no-watch', 'Disable file watching for manifest changes')
  .action(async (opts: { foreground?: boolean; watch?: boolean }) => {
    const noWatch = opts.watch === false;
    if (!opts.foreground) {
      // Background mode: check if already running, then spawn detached
      if (isDaemonRunning()) {
        console.log('Daemon is already running.');
        process.exit(0);
      }

      // Ensure config dir exists
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }

      console.log('Starting clooks daemon in background...');
      startDaemonBackground({ noWatch });
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 500));
      if (isDaemonRunning()) {
        const pid = readFileSync(PID_FILE, 'utf-8').trim();
        console.log(`Daemon started (pid ${pid}), listening on 127.0.0.1:${DEFAULT_PORT}`);
      } else {
        console.log('Daemon started. Check ~/.clooks/daemon.log if issues arise.');
      }
      process.exit(0);
    }

    // Foreground mode: run the actual server
    try {
      const manifest = loadManifest();
      const metrics = new MetricsCollector();
      const port = manifest.settings?.port ?? DEFAULT_PORT;

      const handlerCount = Object.values(manifest.handlers)
        .reduce((sum, arr) => sum + (arr?.length ?? 0), 0);

      await startDaemon(manifest, metrics, { noWatch });
      console.log(`clooks daemon running on 127.0.0.1:${port} (${handlerCount} handler${handlerCount !== 1 ? 's' : ''})`);
    } catch (err) {
      console.error('Failed to start daemon:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- stop ---
program
  .command('stop')
  .description('Stop the clooks daemon')
  .action(() => {
    if (stopDaemon()) {
      console.log('Daemon stopped.');
    } else {
      console.log('Daemon is not running (no PID file or process not found).');
    }
  });

// --- status ---
program
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    const running = isDaemonRunning();
    if (!running) {
      console.log('Status: stopped');
      return;
    }

    const pid = existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf-8').trim() : '?';

    // Try to hit health endpoint
    try {
      const { get } = await import('http');
      const data = await new Promise<string>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${DEFAULT_PORT}/health`, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      const health = JSON.parse(data);
      console.log(`Status: running`);
      console.log(`PID: ${pid}`);
      console.log(`Port: ${health.port}`);
      console.log(`Uptime: ${formatUptime(health.uptime)}`);
      console.log(`Handlers loaded: ${health.handlers_loaded}`);
    } catch {
      console.log(`Status: running (pid ${pid})`);
      console.log(`Note: Could not reach health endpoint on port ${DEFAULT_PORT}`);
    }
  });

// --- stats ---
program
  .command('stats')
  .description('Show hook execution metrics')
  .action(() => {
    const metrics = new MetricsCollector();
    console.log(metrics.formatStatsTable());

    // Append cost summary if LLM data exists
    const costStats = metrics.getCostStats();
    if (costStats.totalCost > 0) {
      console.log('');
      console.log(metrics.formatCostTable());
    }
  });

// --- costs ---
program
  .command('costs')
  .description('Show LLM cost breakdown')
  .action(() => {
    const metrics = new MetricsCollector();
    console.log(metrics.formatCostTable());
  });

// --- migrate ---
program
  .command('migrate')
  .description('Migrate Claude Code settings.json to use clooks HTTP hooks')
  .action(() => {
    try {
      const result = migrate();
      console.log('Migration complete!');
      console.log(`  Settings: ${result.settingsPath}`);
      console.log(`  Manifest: ${result.manifestPath}`);
      console.log(`  Handlers created: ${result.handlersCreated}`);
      console.log(`  Backup: ~/.clooks/settings.backup.json`);
      console.log('\nRun "clooks start" to start the daemon.');
    } catch (err) {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- restore ---
program
  .command('restore')
  .description('Restore original settings.json from backup')
  .action(() => {
    try {
      const path = restore();
      console.log(`Restored settings to: ${path}`);
    } catch (err) {
      console.error('Restore failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- doctor ---
program
  .command('doctor')
  .description('Run diagnostic health checks')
  .action(async () => {
    const results = await runDoctor();
    const icons = { ok: '[OK]', warn: '[WARN]', error: '[ERR]' };

    for (const r of results) {
      console.log(`  ${icons[r.status]}  ${r.check}: ${r.message}`);
    }

    const errors = results.filter((r) => r.status === 'error').length;
    const warns = results.filter((r) => r.status === 'warn').length;
    console.log(`\n${results.length} checks: ${results.length - errors - warns} ok, ${warns} warnings, ${errors} errors`);

    if (errors > 0) process.exit(1);
  });

// --- ensure-running ---
program
  .command('ensure-running')
  .description('Start daemon if not already running (used by SessionStart hook)')
  .action(async () => {
    if (isDaemonRunning()) {
      // Already running — exit silently and fast
      process.exit(0);
    }

    // Ensure config dir exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // If no manifest, create a default one
    const { MANIFEST_PATH } = await import('./constants.js');
    if (!existsSync(MANIFEST_PATH)) {
      createDefaultManifest();
    }

    startDaemonBackground();
    process.exit(0);
  });

// --- init ---
program
  .command('init')
  .description('Create default config directory and example manifest')
  .action(() => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const token = generateAuthToken();
    const path = createDefaultManifest(token);
    console.log(`Created: ${path}`);
    console.log(`Auth token: ${token}`);
    console.log('Edit this file to configure your hook handlers.');
  });

program.parse();

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
