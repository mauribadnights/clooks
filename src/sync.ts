// clooks sync — ensure settings.json has HTTP hooks for every event with handlers

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadCompositeManifest } from './manifest.js';
import { DEFAULT_PORT, MANIFEST_PATH } from './constants.js';
import type { Manifest, HookEvent } from './types.js';

interface ClaudeHookEntry {
  type: 'command' | 'http';
  command?: string;
  url?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

interface ClaudeHookRule {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Partial<Record<string, ClaudeHookRule[]>>;
  [key: string]: unknown;
}

export interface SyncOptions {
  settingsPath?: string;
  manifestPath?: string;
  /** Override composite manifest loading — used for testing */
  manifest?: Manifest;
}

/**
 * Find the Claude Code settings.json path.
 * Checks settings.local.json first, then settings.json.
 */
function findSettingsPath(): string | null {
  const home = homedir();
  const candidates = [
    join(home, '.claude', 'settings.local.json'),
    join(home, '.claude', 'settings.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Ensure settings.json has HTTP hooks for every event that has handlers in the manifest.
 * Adds missing HTTP hook entries without touching existing ones.
 * Returns list of events that were added.
 */
export function syncSettings(options?: SyncOptions): string[] {
  // Determine settings path
  const settingsPath = options?.settingsPath ?? findSettingsPath();
  if (!settingsPath || !existsSync(settingsPath)) {
    return []; // No settings file found — nothing to sync
  }

  // Load manifest
  let manifest: Manifest;
  if (options?.manifest) {
    manifest = options.manifest;
  } else {
    manifest = loadCompositeManifest();
  }

  const port = manifest.settings?.port ?? DEFAULT_PORT;
  const authToken = manifest.settings?.authToken;

  // Find all events that have at least one handler
  const eventsWithHandlers = new Set<string>();
  for (const [event, handlers] of Object.entries(manifest.handlers)) {
    if (handlers && handlers.length > 0) {
      eventsWithHandlers.add(event);
    }
  }

  // Read settings.json
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch {
    return [];
  }

  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const added: string[] = [];

  // Check each event with handlers
  for (const event of eventsWithHandlers) {
    const hookUrl = `http://localhost:${port}/hooks/${event}`;

    // Check if settings.json already has an HTTP hook pointing to this URL
    const ruleGroups = settings.hooks[event] ?? [];
    let hasHttpHook = false;
    for (const rule of ruleGroups) {
      if (!Array.isArray(rule.hooks)) continue;
      for (const hook of rule.hooks) {
        if (hook.type === 'http' && hook.url === hookUrl) {
          hasHttpHook = true;
          break;
        }
      }
      if (hasHttpHook) break;
    }

    if (!hasHttpHook) {
      // Add HTTP hook in a new rule group
      const httpHook: ClaudeHookEntry = {
        type: 'http',
        url: hookUrl,
      };
      if (authToken) {
        httpHook.headers = { Authorization: `Bearer ${authToken}` };
      }

      if (!settings.hooks[event]) {
        settings.hooks[event] = [];
      }

      // Check if there's already a rule group without a matcher we can append to
      const existingRules = settings.hooks[event]!;
      const unmatchedRule = existingRules.find(r => !r.matcher);
      if (unmatchedRule) {
        unmatchedRule.hooks.push(httpHook);
      } else {
        existingRules.push({ hooks: [httpHook] });
      }

      added.push(event);
    }
  }

  // Ensure SessionStart always has the `clooks ensure-running` command hook
  if (!settings.hooks['SessionStart']) {
    settings.hooks['SessionStart'] = [];
  }

  const sessionRules = settings.hooks['SessionStart']!;
  let hasEnsureRunning = false;
  for (const rule of sessionRules) {
    if (!Array.isArray(rule.hooks)) continue;
    for (const hook of rule.hooks) {
      if (hook.type === 'command' && hook.command === 'clooks ensure-running') {
        hasEnsureRunning = true;
        break;
      }
    }
    if (hasEnsureRunning) break;
  }

  if (!hasEnsureRunning) {
    const unmatchedRule = sessionRules.find(r => !r.matcher);
    const ensureHook: ClaudeHookEntry = { type: 'command', command: 'clooks ensure-running' };
    if (unmatchedRule) {
      // Prepend ensure-running before HTTP hooks
      unmatchedRule.hooks.unshift(ensureHook);
    } else {
      sessionRules.unshift({ hooks: [ensureHook] });
    }
    if (!added.includes('SessionStart')) {
      added.push('SessionStart');
    }
  }

  // Write settings.json back only if changes were made
  if (added.length > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  return added;
}
