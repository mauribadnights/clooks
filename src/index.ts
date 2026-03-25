// clooks — public API exports

export { createServer, startDaemon, stopDaemon, isDaemonRunning } from './server.js';
export { loadManifest, validateManifest, createDefaultManifest } from './manifest.js';
export { MetricsCollector } from './metrics.js';
export { migrate, restore, getSettingsPath } from './migrate.js';
export type { MigratePathOptions } from './migrate.js';
export { runDoctor } from './doctor.js';
export { executeHandlers, resetSessionIsolatedHandlers } from './handlers.js';
export { startWatcher, stopWatcher } from './watcher.js';
export { generateAuthToken, validateAuth } from './auth.js';
export { evaluateFilter } from './filter.js';
export { executeLLMHandler, executeLLMHandlersBatched, calculateCost, resetClient } from './llm.js';
export { prefetchContext, renderPromptTemplate } from './prefetch.js';
export { DEFAULT_PORT, CONFIG_DIR, MANIFEST_PATH, PID_FILE, METRICS_FILE, LOG_FILE, COSTS_FILE, DEFAULT_LLM_TIMEOUT, DEFAULT_LLM_MAX_TOKENS, LLM_PRICING } from './constants.js';
export type {
  HookEvent,
  HookInput,
  HandlerType,
  HandlerConfig,
  ScriptHandlerConfig,
  InlineHandlerConfig,
  LLMHandlerConfig,
  LLMModel,
  Manifest,
  HandlerResult,
  MetricEntry,
  HandlerState,
  DiagnosticResult,
  PrefetchKey,
  PrefetchContext,
  TokenUsage,
  CostEntry,
} from './types.js';
