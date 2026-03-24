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
