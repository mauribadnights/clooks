import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import type { HandlerConfig, HookEvent, Manifest } from './types.js';
import { HOOK_EVENTS } from './constants.js';

/** Path to Claude Code's plugin cache */
const CC_PLUGINS_DIR = join(homedir(), '.claude', 'plugins', 'cache');

/** A discovered Claude Code plugin */
export interface CCPlugin {
  name: string;
  version: string;
  path: string;
  hooks: Partial<Record<HookEvent, CCHookEntry[]>>;
  clooksEnhancements?: Partial<Record<string, ClooksEnhancement>>;  // keyed by handler ID
}

interface CCHookEntry {
  type: 'command' | 'http' | 'prompt' | 'agent';
  command?: string;
  url?: string;
  matcher?: string;
  timeout?: number;
}

/** clooks.yaml enhancement overlay per handler */
interface ClooksEnhancement {
  filter?: string;
  project?: string;
  agent?: string;
  async?: boolean;
  depends?: string[];
  sessionIsolation?: boolean;
  batchGroup?: string;
  // For converting command hooks to LLM handlers
  type?: 'llm';
  model?: string;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Discover all installed Claude Code plugins that have hooks.
 */
export function discoverCCPlugins(ccPluginsDir?: string): CCPlugin[] {
  const dir = ccPluginsDir ?? CC_PLUGINS_DIR;
  if (!existsSync(dir)) return [];

  const results: CCPlugin[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(dir, entry.name);

    // Read plugin.json
    const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!existsSync(pluginJsonPath)) continue;

    let pluginJson: Record<string, unknown>;
    try {
      pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    } catch { continue; }

    // Read hooks
    const hooksJsonPath = join(pluginDir, 'hooks', 'hooks.json');
    let hooks: Record<string, unknown> = {};
    if (existsSync(hooksJsonPath)) {
      try { hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')); } catch { /* skip */ }
    }
    // Also check if hooks are inline in plugin.json
    if (pluginJson.hooks && typeof pluginJson.hooks === 'string') {
      const inlineHooksPath = join(pluginDir, pluginJson.hooks as string);
      if (existsSync(inlineHooksPath)) {
        try { hooks = JSON.parse(readFileSync(inlineHooksPath, 'utf-8')); } catch { /* skip */ }
      }
    }

    if (!hooks || Object.keys(hooks).length === 0) continue;

    // Read optional clooks.yaml enhancement
    let enhancements: Record<string, unknown> | undefined = undefined;
    const clooksYamlPath = join(pluginDir, 'clooks.yaml');
    if (existsSync(clooksYamlPath)) {
      try { enhancements = parseYaml(readFileSync(clooksYamlPath, 'utf-8')) as Record<string, unknown>; } catch { /* skip */ }
    }

    results.push({
      name: (pluginJson.name as string) || entry.name,
      version: (pluginJson.version as string) || '0.0.0',
      path: pluginDir,
      hooks: parseHooks(hooks),
      clooksEnhancements: enhancements?.handlers as Partial<Record<string, ClooksEnhancement>> | undefined,
    });
  }

  return results;
}

/**
 * Parse Claude Code hooks.json format into flat event->hooks map.
 * CC format: { "PostToolUse": [{ "matcher": "...", "hooks": [{ "type": "command", ... }] }] }
 */
function parseHooks(hooks: Record<string, unknown>): Partial<Record<HookEvent, CCHookEntry[]>> {
  const result: Partial<Record<HookEvent, CCHookEntry[]>> = {};

  for (const [event, ruleGroups] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.includes(event) || !Array.isArray(ruleGroups)) continue;

    const entries: CCHookEntry[] = [];
    for (const rule of ruleGroups as Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>) {
      if (Array.isArray(rule.hooks)) {
        for (const hook of rule.hooks) {
          entries.push({ ...hook, matcher: rule.matcher } as CCHookEntry);
        }
      }
    }

    if (entries.length > 0) {
      result[event as HookEvent] = entries;
    }
  }

  return result;
}

/**
 * Convert discovered CC plugins into clooks manifest handler entries.
 * Applies clooks.yaml enhancements if present.
 * Handler IDs namespaced as "pluginName/derivedId".
 */
export function convertPluginsToHandlers(plugins: CCPlugin[]): Partial<Record<HookEvent, HandlerConfig[]>> {
  const handlers: Partial<Record<HookEvent, HandlerConfig[]>> = {};

  for (const plugin of plugins) {
    for (const [event, hookEntries] of Object.entries(plugin.hooks)) {
      const hookEvent = event as HookEvent;
      if (!handlers[hookEvent]) handlers[hookEvent] = [];

      for (let i = 0; i < hookEntries.length; i++) {
        const hook = hookEntries[i];
        if (hook.type !== 'command' || !hook.command) continue;  // Only import command hooks

        // Derive handler ID from command
        const baseId = deriveId(hook.command, hookEvent, i);
        const id = `${plugin.name}/${baseId}`;

        // Build base handler config
        const handler: HandlerConfig = {
          id,
          type: 'script',
          command: resolvePluginVars(hook.command, plugin.path),
          timeout: hook.timeout ? hook.timeout * 1000 : 5000,
          enabled: true,
        } as HandlerConfig;

        // Apply clooks.yaml enhancements if present
        const enhancement = plugin.clooksEnhancements?.[baseId];
        if (enhancement) {
          applyEnhancement(handler, enhancement, plugin.name);
        }

        handlers[hookEvent]!.push(handler);
      }
    }
  }

  return handlers;
}

/** Apply clooks.yaml enhancement to a handler */
function applyEnhancement(handler: HandlerConfig, enhancement: ClooksEnhancement, pluginName: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic property assignment from enhancement overlay
  const h = handler as any;
  if (enhancement.filter) h.filter = enhancement.filter;
  if (enhancement.project) h.project = enhancement.project;
  if (enhancement.agent) h.agent = enhancement.agent;
  if (enhancement.async !== undefined) h.async = enhancement.async;
  if (enhancement.depends) {
    h.depends = enhancement.depends.map(d =>
      d.includes('/') ? d : `${pluginName}/${d}`
    );
  }
  if (enhancement.sessionIsolation) h.sessionIsolation = enhancement.sessionIsolation;

  // Allow converting to LLM handler
  if (enhancement.type === 'llm' && enhancement.model && enhancement.prompt) {
    h.type = 'llm';
    h.model = enhancement.model;
    h.prompt = enhancement.prompt;
    delete h.command;
    if (enhancement.batchGroup) h.batchGroup = enhancement.batchGroup;
    if (enhancement.maxTokens) h.maxTokens = enhancement.maxTokens;
    if (enhancement.temperature) h.temperature = enhancement.temperature;
  }
}

/** Resolve ${CLAUDE_PLUGIN_ROOT} and similar vars in commands */
function resolvePluginVars(command: string, pluginPath: string): string {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginPath);
}

/** Derive a handler ID from command */
function deriveId(command: string, event: HookEvent, index: number): string {
  // Extract script filename
  const jsMatch = command.match(/[\\/]([^\\/]+)\.(?:js|ts|py|sh)(?:\s|"|'|$)/);
  if (jsMatch) {
    return jsMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }
  const moduleMatch = command.match(/python3?\s+-m\s+([\w.]+)/);
  if (moduleMatch) {
    const parts = moduleMatch[1].split('.');
    return parts.slice(-2).join('-').toLowerCase();
  }
  return `${event.toLowerCase()}-${index}`;
}

/**
 * Import all Claude Code plugins into clooks.
 * Returns the discovered plugins and generated handlers.
 */
export function importPlugins(ccPluginsDir?: string): {
  plugins: CCPlugin[];
  handlers: Partial<Record<HookEvent, HandlerConfig[]>>;
} {
  const plugins = discoverCCPlugins(ccPluginsDir);
  const handlers = convertPluginsToHandlers(plugins);
  return { plugins, handlers };
}
