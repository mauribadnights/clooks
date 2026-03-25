#!/usr/bin/env node

// clooks CLI entry point

import { Command } from 'commander';
import { loadManifest, loadCompositeManifest, createDefaultManifest } from './manifest.js';
import { MetricsCollector } from './metrics.js';
import { startDaemon, stopDaemon, isDaemonRunning, isDaemonHealthy, cleanupStaleDaemon, startDaemonBackground } from './server.js';
import { migrate, restore, getSettingsPath } from './migrate.js';
import { runDoctor } from './doctor.js';
import { generateAuthToken, rotateToken } from './auth.js';
import { installPlugin, uninstallPlugin, listPlugins, loadPlugins } from './plugin.js';
import { syncSettings } from './sync.js';
import { DEFAULT_PORT, CONFIG_DIR, PID_FILE, PLUGIN_MANIFEST_NAME } from './constants.js';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const program = new Command();

program
  .name('clooks')
  .description('Persistent hook runtime for Claude Code')
  .version('0.3.3');

// --- start ---
program
  .command('start')
  .description('Start the clooks daemon')
  .option('-f, --foreground', 'Run in foreground (default: background/detached)')
  .option('--no-watch', 'Disable file watching for manifest changes')
  .action(async (opts: { foreground?: boolean; watch?: boolean }) => {
    const noWatch = opts.watch === false;
    if (!opts.foreground) {
      // Background mode: check if already running and healthy
      if (isDaemonRunning()) {
        const healthy = await isDaemonHealthy();
        if (healthy) {
          console.log('Daemon is already running.');
          process.exit(0);
        }
        // PID alive but daemon unhealthy — stale process after sleep/lid-close
        const stalePid = cleanupStaleDaemon();
        if (stalePid) {
          console.log(`Cleaned up stale daemon (pid ${stalePid}), starting fresh`);
        }
      }

      // Ensure config dir exists
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }

      console.log('Starting clooks daemon in background...');
      startDaemonBackground({ noWatch });
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 500));

      // Sync settings.json with manifest
      const syncAdded = syncSettings();
      if (syncAdded.length > 0) {
        console.log(`Synced HTTP hooks for: ${syncAdded.join(', ')}`);
      }

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
      const manifest = loadCompositeManifest();
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
      const pluginCount = listPlugins().length;
      console.log(`Status: running`);
      console.log(`PID: ${pid}`);
      console.log(`Port: ${health.port}`);
      console.log(`Uptime: ${formatUptime(health.uptime)}`);
      console.log(`Handlers loaded: ${health.handlers_loaded}`);
      console.log(`Plugins: ${pluginCount}`);
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

    console.log('');
    console.log('Per Handler:');
    console.log(metrics.formatHandlerStatsTable());

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

// --- sync ---
program
  .command('sync')
  .description('Sync settings.json with manifest (add missing HTTP hook entries)')
  .action(() => {
    const added = syncSettings();
    if (added.length === 0) {
      console.log('Settings already in sync.');
    } else {
      console.log(`Added HTTP hooks for: ${added.join(', ')}`);
      const settingsPath = getSettingsPath();
      if (settingsPath) {
        console.log(`Settings updated: ${settingsPath}`);
      }
    }
  });

// --- ensure-running ---
program
  .command('ensure-running')
  .description('Start daemon if not already running (used by SessionStart hook)')
  .action(async () => {
    if (isDaemonRunning()) {
      const healthy = await isDaemonHealthy();
      if (healthy) {
        // Already running and healthy — sync settings silently and exit fast
        syncSettings();
        process.exit(0);
      }
      // PID alive but daemon unhealthy — stale process after sleep/lid-close
      const stalePid = cleanupStaleDaemon();
      if (stalePid) {
        // Log to daemon.log for visibility
        const { appendFileSync } = await import('fs');
        const { LOG_FILE } = await import('./constants.js');
        try {
          appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Cleaned up stale daemon (pid ${stalePid}), starting fresh\n`, 'utf-8');
        } catch {
          // ignore
        }
      }
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

    // Sync settings silently after starting
    syncSettings();

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

// --- rotate-token ---
program
  .command('rotate-token')
  .description('Generate new auth token, update manifest and settings.json')
  .action(() => {
    try {
      const newToken = rotateToken();
      console.log(`Auth token rotated successfully.`);
      console.log(`New token: ${newToken}`);
      console.log('If daemon is running, the file watcher will pick up the manifest change.');
    } catch (err) {
      console.error('Token rotation failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- update ---
program
  .command('update')
  .description('Update clooks to the latest version')
  .action(async () => {
    console.log('Checking for updates...');

    const currentVersion = program.version();

    try {
      const { execSync } = await import('child_process');
      const latest = execSync('npm view @mauribadnights/clooks version', { encoding: 'utf-8' }).trim();

      if (latest === currentVersion) {
        console.log(`Already on latest version (${currentVersion}).`);
        return;
      }

      console.log(`Updating: ${currentVersion} \u2192 ${latest}`);
      execSync('npm install -g @mauribadnights/clooks@latest', { stdio: 'inherit' });
      console.log(`Updated to ${latest}.`);

      // Restart daemon if running
      if (isDaemonRunning()) {
        console.log('Restarting daemon...');
        stopDaemon();
        await new Promise(r => setTimeout(r, 1000));
        startDaemonBackground();
        await new Promise(r => setTimeout(r, 500));
        console.log('Daemon restarted.');
      }
    } catch (err) {
      console.error('Update failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- add (install plugin) ---
program
  .command('add <path>')
  .description('Install a plugin from a local directory')
  .action((pluginPath: string) => {
    try {
      const resolvedPath = resolve(pluginPath);
      if (!existsSync(resolvedPath)) {
        console.error(`Path does not exist: ${resolvedPath}`);
        process.exit(1);
      }

      const manifestFile = resolve(resolvedPath, PLUGIN_MANIFEST_NAME);
      if (!existsSync(manifestFile)) {
        console.error(`No ${PLUGIN_MANIFEST_NAME} found at ${resolvedPath}`);
        process.exit(1);
      }

      const plugin = installPlugin(resolvedPath);

      // Count handlers in the installed plugin
      const plugins = loadPlugins();
      const installed = plugins.find(p => p.name === plugin.name);
      const handlerCount = installed
        ? Object.values(installed.manifest.handlers).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
        : 0;

      console.log(`Installed plugin ${plugin.name} v${plugin.version} (${handlerCount} handlers)`);

      // Sync settings.json to add HTTP hooks for any new events
      const syncAdded = syncSettings();
      if (syncAdded.length > 0) {
        console.log(`Synced HTTP hooks for: ${syncAdded.join(', ')}`);
      }
    } catch (err) {
      console.error('Plugin install failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- remove (uninstall plugin) ---
program
  .command('remove <name>')
  .description('Uninstall a plugin')
  .action((name: string) => {
    try {
      uninstallPlugin(name);
      console.log(`Removed plugin ${name}`);
    } catch (err) {
      console.error('Plugin removal failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- plugins (list installed plugins) ---
program
  .command('plugins')
  .description('List installed plugins')
  .action(() => {
    const plugins = listPlugins();
    if (plugins.length === 0) {
      console.log('No plugins installed.');
      return;
    }

    // Load full manifests to access extras and handler counts
    const loaded = loadPlugins();
    const manifestMap = new Map(loaded.map(l => [l.name, l.manifest]));

    console.log('Installed Plugins:');

    for (const p of plugins) {
      const manifest = manifestMap.get(p.name);
      const handlerCount = manifest
        ? Object.values(manifest.handlers).reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
        : 0;

      console.log(`  ${p.name} v${p.version} (${handlerCount} handler${handlerCount !== 1 ? 's' : ''})`);

      if (manifest?.extras) {
        if (manifest.extras.skills && manifest.extras.skills.length > 0) {
          console.log(`    Skills: ${manifest.extras.skills.join(', ')}`);
        }
        if (manifest.extras.agents && manifest.extras.agents.length > 0) {
          console.log(`    Agents: ${manifest.extras.agents.join(', ')}`);
        }
      }
    }
  });

program.parse();

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
