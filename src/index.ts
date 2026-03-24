// cchooks — public API exports

export { createServer, startDaemon, stopDaemon, isDaemonRunning } from './server.js';
export { loadManifest, validateManifest, createDefaultManifest } from './manifest.js';
export { MetricsCollector } from './metrics.js';
export { migrate, restore, getSettingsPath } from './migrate.js';
export { runDoctor } from './doctor.js';
export { executeHandlers } from './handlers.js';
export { DEFAULT_PORT, CONFIG_DIR, MANIFEST_PATH, PID_FILE, METRICS_FILE, LOG_FILE } from './constants.js';
export type {
  HookEvent,
  HookInput,
  HandlerType,
  HandlerConfig,
  Manifest,
  HandlerResult,
  MetricEntry,
  HandlerState,
  DiagnosticResult,
} from './types.js';
