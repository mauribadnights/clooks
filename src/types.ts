// clooks type definitions

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
  agent_type?: string;                    // SessionStart — active agent name
  stop_hook_active?: boolean;             // Stop
  [key: string]: unknown;                 // extensible
}

/** Supported LLM models */
export type LLMModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-6';

/** Handler types — extended with 'llm' */
export type HandlerType = 'script' | 'inline' | 'llm';

/** LLM-specific handler config fields */
export interface LLMHandlerConfig {
  id: string;
  type: 'llm';
  model: LLMModel;
  prompt: string;            // Prompt template with $VARIABLE interpolation
  batchGroup?: string;       // Group ID — LLM handlers with same group are batched into one call
  maxTokens?: number;        // Default 1024
  temperature?: number;      // Default 1.0
  filter?: string;           // Keyword filter (applies to all handler types)
  timeout?: number;          // ms, default 30000 for LLM
  enabled?: boolean;
  sessionIsolation?: boolean; // Reset handler state on SessionStart
  depends?: string[];  // handler IDs this handler depends on (executed after them)
  async?: boolean;     // Fire-and-forget — don't await, don't include in response
  agent?: string;      // Only fire when session's agent matches (e.g., "builder", "coo")
  project?: string;    // Glob pattern matched against cwd (e.g., "*/Driffusion/*")
}

/** Script handler config */
export interface ScriptHandlerConfig {
  id: string;
  type: 'script';
  command: string;
  filter?: string;
  timeout?: number;
  enabled?: boolean;
  sessionIsolation?: boolean; // Reset handler state on SessionStart
  depends?: string[];  // handler IDs this handler depends on (executed after them)
  async?: boolean;     // Fire-and-forget — don't await, don't include in response
  agent?: string;      // Only fire when session's agent matches (e.g., "builder", "coo")
  project?: string;    // Glob pattern matched against cwd (e.g., "*/Driffusion/*")
}

/** Inline handler config */
export interface InlineHandlerConfig {
  id: string;
  type: 'inline';
  module: string;
  filter?: string;
  timeout?: number;
  enabled?: boolean;
  sessionIsolation?: boolean; // Reset handler state on SessionStart
  depends?: string[];  // handler IDs this handler depends on (executed after them)
  async?: boolean;     // Fire-and-forget — don't await, don't include in response
  agent?: string;      // Only fire when session's agent matches (e.g., "builder", "coo")
  project?: string;    // Glob pattern matched against cwd (e.g., "*/Driffusion/*")
}

/** Union of all handler configs */
export type HandlerConfig = ScriptHandlerConfig | InlineHandlerConfig | LLMHandlerConfig;

/** Prefetchable context keys */
export type PrefetchKey = 'transcript' | 'git_status' | 'git_diff';

/** Pre-fetched context data */
export interface PrefetchContext {
  transcript?: string;
  git_status?: string;
  git_diff?: string;
}

/** Extended manifest with prefetch and LLM settings */
export interface Manifest {
  handlers: Partial<Record<HookEvent, HandlerConfig[]>>;
  prefetch?: PrefetchKey[];  // Global prefetch config
  settings?: {
    port?: number;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    anthropicApiKey?: string;  // Can also use ANTHROPIC_API_KEY env var
    authToken?: string;        // Token for authenticating HTTP requests
  };
}

/** Token usage from API response */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Cost entry for tracking */
export interface CostEntry {
  ts: string;
  event: HookEvent;
  handler: string;
  model: LLMModel;
  usage: TokenUsage;
  cost_usd: number;
  batched: boolean;
}

/** Extended metrics entry with optional cost fields */
export interface MetricEntry {
  ts: string;
  event: HookEvent;
  handler: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
  filtered?: boolean;       // Was this handler skipped by filter?
  usage?: TokenUsage;       // For LLM handlers
  cost_usd?: number;        // For LLM handlers
  session_id?: string;      // Claude Code session ID
}

/** Extended handler result with cost info */
export interface HandlerResult {
  id: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  duration_ms: number;
  filtered?: boolean;
  usage?: TokenUsage;
  cost_usd?: number;
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

/** Plugin extras metadata (freeform, extensible) */
export interface PluginExtras {
  skills?: string[];     // skill names the plugin provides
  agents?: string[];     // agent names the plugin provides
  readme?: string;       // path to plugin README (relative to plugin dir)
  [key: string]: unknown; // extensible for future use
}

/** Plugin manifest (clooks-plugin.yaml) */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  handlers: Partial<Record<HookEvent, HandlerConfig[]>>;
  prefetch?: PrefetchKey[];
  extras?: PluginExtras;
}

/** Installed plugin registry entry */
export interface InstalledPlugin {
  name: string;
  version: string;
  path: string;           // absolute path to plugin directory
  installedAt: string;    // ISO timestamp
}

/** Plugin registry file format (installed.json) */
export interface PluginRegistry {
  plugins: InstalledPlugin[];
}
