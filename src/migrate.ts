// clooks migration utilities — convert shell hooks to HTTP hooks

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CONFIG_DIR, SETTINGS_BACKUP, DEFAULT_PORT, HOOK_EVENTS, MANIFEST_PATH } from './constants.js';
import { loadManifest } from './manifest.js';
import type { Manifest, HandlerConfig, HookEvent } from './types.js';
import { stringify as stringifyYaml } from 'yaml';

interface ClaudeHookEntry {
  type: 'command' | 'http';
  command?: string;
  url?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

// Claude Code settings.json uses a NESTED hook format:
// settings.hooks[event] is an array of rule groups, each with an optional matcher
// and a hooks[] array of actual hook definitions.
// Example: { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "http", ... }] }] }
interface ClaudeHookRule {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Partial<Record<string, ClaudeHookRule[]>>;
  [key: string]: unknown;
}

/** Options for overriding default paths (used by tests to avoid touching real filesystem). */
export interface MigratePathOptions {
  /** Override the home directory used to locate settings.json */
  homeDir?: string;
  /** Override the config directory (~/.clooks) */
  configDir?: string;
  /** Override the settings backup path */
  settingsBackup?: string;
}

/**
 * Find the Claude Code settings.json path.
 */
export function getSettingsPath(options?: MigratePathOptions): string | null {
  const home = options?.homeDir ?? homedir();
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
 * Migrate Claude Code settings.json command hooks to clooks HTTP hooks.
 *
 * 1. Read settings.json
 * 2. Extract command hooks → generate manifest.yaml handler entries
 * 3. Back up original settings.json
 * 4. Rewrite settings with HTTP hooks pointing to localhost:7890
 * 5. Keep SessionStart with ensure-running command hook + HTTP hook
 */
export function migrate(options?: MigratePathOptions): { manifestPath: string; settingsPath: string; handlersCreated: number } {
  const configDir = options?.configDir ?? CONFIG_DIR;
  const settingsBackup = options?.settingsBackup ?? SETTINGS_BACKUP;

  const settingsPath = getSettingsPath(options);
  if (!settingsPath) {
    throw new Error('Could not find Claude Code settings.json (checked ~/.claude/settings.json and ~/.claude/settings.local.json)');
  }

  const raw = readFileSync(settingsPath, 'utf-8');
  const settings: ClaudeSettings = JSON.parse(raw);

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    throw new Error('No hooks found in settings.json — nothing to migrate');
  }

  // Check if already migrated (HTTP hooks pointing to clooks inside nested rule groups)
  const alreadyMigrated = Object.values(settings.hooks).some((ruleGroups) =>
    ruleGroups?.some((rule) =>
      rule.hooks?.some((e) => e.type === 'http' && e.url?.includes(`localhost:${DEFAULT_PORT}`))
    )
  );
  if (alreadyMigrated) {
    throw new Error('Settings already contain HTTP hooks pointing to clooks. Use "clooks restore" first if you want to re-migrate.');
  }

  // Ensure config dir exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // Back up original settings
  writeFileSync(settingsBackup, raw, 'utf-8');

  // Extract command hooks and build manifest
  const manifestHandlers: Partial<Record<HookEvent, HandlerConfig[]>> = {};
  let handlerIndex = 0;

  // NOTE: In v0.1, matchers from the original rule groups are not preserved in the
  // migrated HTTP hooks — all command hooks are consolidated into matcher-less rule groups.
  // This is acceptable because clooks dispatches based on event type, not matchers.
  for (const [eventName, ruleGroups] of Object.entries(settings.hooks)) {
    if (!HOOK_EVENTS.includes(eventName) || !Array.isArray(ruleGroups)) continue;
    const event = eventName as HookEvent;

    // Flatten command hooks from ALL rule groups for this event
    const commandHooks: ClaudeHookEntry[] = [];
    for (const rule of ruleGroups) {
      if (!Array.isArray(rule.hooks)) continue;
      for (const entry of rule.hooks) {
        if (entry.type === 'command' && entry.command) {
          commandHooks.push(entry);
        }
      }
    }
    if (commandHooks.length === 0) continue;

    manifestHandlers[event] = commandHooks.map((hook) => {
      handlerIndex++;
      return {
        id: `migrated-${event.toLowerCase()}-${handlerIndex}`,
        type: 'script' as const,
        command: hook.command!,
        timeout: hook.timeout ? hook.timeout * 1000 : 5000, // Claude uses seconds, we use ms
        enabled: true,
      };
    });
  }

  // Write manifest.yaml
  const manifest: Manifest = {
    handlers: manifestHandlers,
    settings: { port: DEFAULT_PORT, logLevel: 'info' },
  };

  const yamlStr =
    '# clooks manifest — auto-generated by migrate\n' +
    `# Migrated from: ${settingsPath}\n` +
    `# Date: ${new Date().toISOString()}\n\n` +
    stringifyYaml(manifest);

  const manifestPath = join(configDir, 'manifest.yaml');
  writeFileSync(manifestPath, yamlStr, 'utf-8');

  // Rewrite settings.json with HTTP hooks in the nested rule group format
  const newHooks: Record<string, ClaudeHookRule[]> = {};

  for (const eventName of HOOK_EVENTS) {
    const hadHandlers = manifestHandlers[eventName as HookEvent]?.length ?? 0;
    // Also check if there were existing non-command hooks to preserve (flatten from rule groups)
    const existingNonCommand: ClaudeHookEntry[] = [];
    for (const rule of (settings.hooks[eventName] ?? [])) {
      if (!Array.isArray(rule.hooks)) continue;
      for (const entry of rule.hooks) {
        if (entry.type !== 'command') {
          existingNonCommand.push(entry);
        }
      }
    }

    if (hadHandlers === 0 && existingNonCommand.length === 0 && eventName !== 'SessionStart') continue;

    const hookEntries: ClaudeHookEntry[] = [...existingNonCommand];

    // For SessionStart, add ensure-running command hook
    if (eventName === 'SessionStart') {
      hookEntries.push({
        type: 'command',
        command: 'clooks ensure-running',
      });
    }

    // Add HTTP hook
    if (hadHandlers > 0) {
      const httpHook: ClaudeHookEntry = {
        type: 'http',
        url: `http://localhost:${DEFAULT_PORT}/hooks/${eventName}`,
      };
      if (manifest.settings?.authToken) {
        httpHook.headers = { Authorization: `Bearer ${manifest.settings.authToken}` };
      }
      hookEntries.push(httpHook);
    }

    if (hookEntries.length > 0) {
      // Wrap in a single rule group (no matcher — clooks handles dispatch)
      newHooks[eventName] = [{ hooks: hookEntries }];
    }
  }

  // Ensure SessionStart always has ensure-running even if no hooks were migrated for it
  if (!newHooks['SessionStart']) {
    newHooks['SessionStart'] = [
      { hooks: [{ type: 'command', command: 'clooks ensure-running' }] },
    ];
  }

  settings.hooks = newHooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  return {
    manifestPath,
    settingsPath,
    handlersCreated: handlerIndex,
  };
}

/**
 * Restore original settings.json from backup.
 */
export function restore(options?: MigratePathOptions): string {
  const settingsBackup = options?.settingsBackup ?? SETTINGS_BACKUP;

  if (!existsSync(settingsBackup)) {
    throw new Error('No backup found at ' + settingsBackup);
  }

  const settingsPath = getSettingsPath(options);
  if (!settingsPath) {
    throw new Error('Could not find Claude Code settings.json to restore');
  }

  const backup = readFileSync(settingsBackup, 'utf-8');
  writeFileSync(settingsPath, backup, 'utf-8');

  return settingsPath;
}
