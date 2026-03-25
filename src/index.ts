// clooks — public API exports

export { createServer, startDaemon, stopDaemon, isDaemonRunning } from './server.js';
export { loadManifest, loadCompositeManifest, validateManifest, createDefaultManifest } from './manifest.js';
export { loadPlugins, mergeManifests, validatePluginManifest, loadRegistry, saveRegistry, installPlugin, uninstallPlugin, listPlugins } from './plugin.js';
export { MetricsCollector } from './metrics.js';
export { migrate, restore, getSettingsPath } from './migrate.js';
export type { MigratePathOptions } from './migrate.js';
export { runDoctor } from './doctor.js';
export { executeHandlers, resetSessionIsolatedHandlers, cleanupHandlerState } from './handlers.js';
export { resolveExecutionOrder } from './deps.js';
export { DenyCache } from './shortcircuit.js';
export { RateLimiter } from './ratelimit.js';
export { startWatcher, stopWatcher } from './watcher.js';
export { generateAuthToken, validateAuth, rotateToken } from './auth.js';
export { syncSettings } from './sync.js';
export { installService, uninstallService, isServiceInstalled, getServiceStatus } from './service.js';
export type { ServiceStatus } from './service.js';
export type { SyncOptions } from './sync.js';
export type { RotateTokenOptions } from './auth.js';
export { evaluateFilter } from './filter.js';
export { executeLLMHandler, executeLLMHandlersBatched, calculateCost, resetClient } from './llm.js';
export { prefetchContext, renderPromptTemplate } from './prefetch.js';
export { DEFAULT_PORT, CONFIG_DIR, MANIFEST_PATH, PID_FILE, METRICS_FILE, LOG_FILE, COSTS_FILE, DEFAULT_LLM_TIMEOUT, DEFAULT_LLM_MAX_TOKENS, LLM_PRICING, PLUGINS_DIR, PLUGIN_REGISTRY, PLUGIN_MANIFEST_NAME } from './constants.js';
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
  PluginManifest,
  InstalledPlugin,
  PluginRegistry,
} from './types.js';
