// clooks constants

import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_PORT = 7890;
export const CONFIG_DIR = join(homedir(), '.clooks');
export const MANIFEST_PATH = join(CONFIG_DIR, 'manifest.yaml');
export const PID_FILE = join(CONFIG_DIR, 'daemon.pid');
export const METRICS_FILE = join(CONFIG_DIR, 'metrics.jsonl');
export const LOG_FILE = join(CONFIG_DIR, 'daemon.log');
export const SETTINGS_BACKUP = join(CONFIG_DIR, 'settings.backup.json');
export const MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_HANDLER_TIMEOUT = 5000; // ms
export const COSTS_FILE = join(CONFIG_DIR, 'costs.jsonl');
export const DEFAULT_LLM_TIMEOUT = 30000; // ms
export const DEFAULT_LLM_MAX_TOKENS = 1024;

/** Pricing per million tokens (USD) — as of March 2026 */
export const LLM_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
};

export const HOOKS_DIR = join(CONFIG_DIR, 'hooks');

export const PLUGINS_DIR = join(CONFIG_DIR, 'plugins');
export const PLUGIN_REGISTRY = join(PLUGINS_DIR, 'installed.json');
export const PLUGIN_MANIFEST_NAME = 'clooks-plugin.yaml';

export const HOOK_EVENTS: string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'ConfigChange',
];
