// clooks doctor — diagnostics and health checks

import { existsSync, accessSync, constants as fsConstants, readFileSync } from 'fs';
import { get as httpGet } from 'http';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { CONFIG_DIR, MANIFEST_PATH, PID_FILE, DEFAULT_PORT } from './constants.js';
import { loadManifest } from './manifest.js';
import { isDaemonRunning } from './server.js';
import type { DiagnosticResult, HandlerConfig, HookEvent } from './types.js';

/**
 * Run all diagnostic checks and return results.
 */
export async function runDoctor(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // 1. Config directory exists
  results.push(checkConfigDir());

  // 2. Manifest exists and is valid
  results.push(checkManifest());

  // 3. Daemon is running (PID file + process alive)
  results.push(checkDaemonRunning());

  // 4. Port is reachable
  results.push(await checkPortReachable());

  // 5. Script handler commands are executable
  results.push(...checkHandlerCommands());

  // 6. Settings.json has HTTP hooks pointing to clooks
  results.push(checkSettingsHooks());

  // 7. No stale PID file
  results.push(checkStalePid());

  return results;
}

function checkConfigDir(): DiagnosticResult {
  if (existsSync(CONFIG_DIR)) {
    return { check: 'Config directory', status: 'ok', message: `${CONFIG_DIR} exists` };
  }
  return { check: 'Config directory', status: 'error', message: `${CONFIG_DIR} does not exist. Run "clooks start" to create it.` };
}

function checkManifest(): DiagnosticResult {
  if (!existsSync(MANIFEST_PATH)) {
    return { check: 'Manifest', status: 'warn', message: 'manifest.yaml not found. No handlers configured.' };
  }

  try {
    loadManifest();
    return { check: 'Manifest', status: 'ok', message: 'manifest.yaml is valid' };
  } catch (err) {
    return { check: 'Manifest', status: 'error', message: `manifest.yaml is invalid: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkDaemonRunning(): DiagnosticResult {
  if (isDaemonRunning()) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    return { check: 'Daemon process', status: 'ok', message: `Running (pid ${pid})` };
  }
  return { check: 'Daemon process', status: 'warn', message: 'Daemon is not running' };
}

function checkPortReachable(): Promise<DiagnosticResult> {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${DEFAULT_PORT}/health`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'ok') {
            resolve({ check: 'Port reachable', status: 'ok', message: `127.0.0.1:${DEFAULT_PORT} responds with status ok` });
          } else {
            resolve({ check: 'Port reachable', status: 'warn', message: `Port responds but status is: ${parsed.status}` });
          }
        } catch {
          resolve({ check: 'Port reachable', status: 'warn', message: 'Port responds but returned invalid JSON' });
        }
      });
    });

    req.on('error', () => {
      resolve({ check: 'Port reachable', status: 'error', message: `Cannot reach 127.0.0.1:${DEFAULT_PORT}` });
    });

    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ check: 'Port reachable', status: 'error', message: 'Health check timed out' });
    });
  });
}

function checkHandlerCommands(): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];

  try {
    const manifest = loadManifest();
    for (const [_event, handlers] of Object.entries(manifest.handlers)) {
      for (const handler of handlers as HandlerConfig[]) {
        if (handler.type !== 'script') continue;
        if (!handler.command) continue;

        // Extract the base command (first word)
        const baseCmd = handler.command.split(/\s+/)[0];

        // Skip built-in shell commands
        if (['echo', 'cat', 'true', 'false', 'test', '['].includes(baseCmd)) {
          results.push({ check: `Handler "${handler.id}"`, status: 'ok', message: `Command: ${baseCmd} (shell builtin)` });
          continue;
        }

        try {
          execSync(`which ${baseCmd}`, { stdio: 'pipe' });
          results.push({ check: `Handler "${handler.id}"`, status: 'ok', message: `Command "${baseCmd}" found in PATH` });
        } catch {
          results.push({ check: `Handler "${handler.id}"`, status: 'error', message: `Command "${baseCmd}" not found in PATH` });
        }
      }
    }
  } catch {
    // If manifest can't be loaded, skip handler checks (already caught by checkManifest)
  }

  if (results.length === 0) {
    results.push({ check: 'Handler commands', status: 'ok', message: 'No script handlers to check' });
  }

  return results;
}

function checkSettingsHooks(): DiagnosticResult {
  const candidates = [
    join(homedir(), '.claude', 'settings.local.json'),
    join(homedir(), '.claude', 'settings.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    try {
      const raw = readFileSync(path, 'utf-8');
      const settings = JSON.parse(raw);

      if (!settings.hooks) {
        return { check: 'Settings hooks', status: 'warn', message: 'No hooks configured in ' + path };
      }

      // settings.hooks[event] is an array of rule groups, each with a hooks[] array
      const hasHttpHook = Object.values(
        settings.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; url?: string }> }>>
      ).some((ruleGroups) =>
        ruleGroups.some((rule) =>
          rule.hooks?.some((e) => e.type === 'http' && e.url?.includes(`localhost:${DEFAULT_PORT}`))
        )
      );

      if (hasHttpHook) {
        return { check: 'Settings hooks', status: 'ok', message: `HTTP hooks point to clooks in ${path}` };
      }

      return { check: 'Settings hooks', status: 'warn', message: `No HTTP hooks pointing to clooks in ${path}. Run "clooks migrate".` };
    } catch {
      return { check: 'Settings hooks', status: 'error', message: `Failed to parse ${path}` };
    }
  }

  return { check: 'Settings hooks', status: 'warn', message: 'No Claude Code settings.json found' };
}

function checkStalePid(): DiagnosticResult {
  if (!existsSync(PID_FILE)) {
    return { check: 'Stale PID', status: 'ok', message: 'No PID file' };
  }

  const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    return { check: 'Stale PID', status: 'error', message: 'PID file contains invalid value' };
  }

  try {
    process.kill(pid, 0);
    return { check: 'Stale PID', status: 'ok', message: `PID ${pid} is alive` };
  } catch {
    return { check: 'Stale PID', status: 'error', message: `Stale PID file: process ${pid} is dead. Remove ${PID_FILE} or run "clooks start".` };
  }
}
