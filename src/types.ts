// cchooks type definitions

/** Hook event names supported by Claude Code */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Notification'
  | 'ConfigChange';

/** Hook input payload from Claude Code */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: HookEvent;
  // Event-specific fields
  prompt?: string;                        // UserPromptSubmit
  tool_name?: string;                     // Pre/PostToolUse
  tool_input?: Record<string, unknown>;   // Pre/PostToolUse
  source?: string;                        // SessionStart
  stop_hook_active?: boolean;             // Stop
  [key: string]: unknown;                 // extensible
}

/** Handler types in manifest */
export type HandlerType = 'script' | 'inline';

/** Configuration for a single handler */
export interface HandlerConfig {
  id: string;
  type: HandlerType;
  command?: string;   // for script type
  module?: string;    // for inline type (path to JS module with default export)
  timeout?: number;   // ms, default 5000
  enabled?: boolean;  // default true
}

/** The full manifest structure */
export interface Manifest {
  handlers: Partial<Record<HookEvent, HandlerConfig[]>>;
  settings?: {
    port?: number;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
  };
}

/** Result from executing a single handler */
export interface HandlerResult {
  id: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  duration_ms: number;
}

/** A single metrics entry */
export interface MetricEntry {
  ts: string;
  event: HookEvent;
  handler: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
}

/** Runtime state for tracking consecutive failures */
export interface HandlerState {
  consecutiveFailures: number;
  disabled: boolean;
  totalFires: number;
  totalErrors: number;
}

/** Diagnostic result from doctor checks */
export interface DiagnosticResult {
  check: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}
