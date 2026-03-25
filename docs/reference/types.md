# Types

TypeScript type reference for programmatic usage. All types are exported from the `@mauribadnights/clooks` package.

```typescript
import type { Manifest, HandlerConfig, HookInput, HookEvent } from '@mauribadnights/clooks';
```

---

## Core Types

### HookEvent

```typescript
type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Notification'
  | 'ConfigChange';
```

### HookInput

```typescript
interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: HookEvent;

  // UserPromptSubmit
  prompt?: string;

  // Pre/PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;

  // SessionStart
  source?: string;
  agent_type?: string;

  // Stop
  stop_hook_active?: boolean;

  // Internal: dependency outputs injected by the engine
  _handlerOutputs?: Record<string, unknown>;

  // Extensible for plugins
  [key: string]: unknown;
}
```

---

## Handler Types

### HandlerConfig

A union of three handler types, all sharing a common base.

```typescript
interface BaseHandler {
  id: string;
  filter?: string;
  timeout?: number;
  enabled?: boolean;
  sessionIsolation?: boolean;
  depends?: string[];
  async?: boolean;
  agent?: string;
  project?: string;
}

interface ScriptHandlerConfig extends BaseHandler {
  type: 'script';
  command: string;
}

interface InlineHandlerConfig extends BaseHandler {
  type: 'inline';
  module: string;
}

interface LLMHandlerConfig extends BaseHandler {
  type: 'llm';
  model?: LLMModel;         // Required for 'api' backend, optional for 'claude-code'
  prompt: string;
  backend?: LLMBackend;     // Default: 'api'
  llmAgent?: string;        // Agent name for 'claude-code' backend (--agent flag)
  batchGroup?: string;      // 'api' backend only
  maxTokens?: number;       // Default: 1024
  temperature?: number;     // Default: 1.0
}

type HandlerConfig = ScriptHandlerConfig | InlineHandlerConfig | LLMHandlerConfig;
```

### LLMModel

```typescript
type LLMModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-6';
```

### LLMBackend

```typescript
type LLMBackend = 'api' | 'claude-code';
```

- `api` — Direct Anthropic Messages API call. Supports batching and cost tracking. Requires `ANTHROPIC_API_KEY` and the `@anthropic-ai/sdk` package.
- `claude-code` — Spawns `claude -p "prompt"`. Supports `llmAgent` for agent-based execution. No API key or SDK required.

### HandlerResult

```typescript
interface HandlerResult {
  id: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  duration_ms: number;
  filtered?: boolean;
  usage?: TokenUsage;
  cost_usd?: number;
}
```

### HandlerState

```typescript
interface HandlerState {
  consecutiveFailures: number;
  disabled: boolean;
  totalFires: number;
  totalErrors: number;
}
```

---

## Manifest Types

### Manifest

```typescript
interface Manifest {
  handlers: Partial<Record<HookEvent, HandlerConfig[]>>;
  prefetch?: PrefetchKey[];
  settings?: {
    port?: number;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    anthropicApiKey?: string;
    authToken?: string;
  };
}
```

### PluginManifest

```typescript
interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  handlers: Partial<Record<HookEvent, HandlerConfig[]>>;
  prefetch?: PrefetchKey[];
  extras?: PluginExtras;
}

interface PluginExtras {
  skills?: string[];
  agents?: string[];
  readme?: string;
  [key: string]: unknown;
}
```

---

## Plugin Types

### InstalledPlugin

```typescript
interface InstalledPlugin {
  name: string;
  version: string;
  path: string;
  installedAt: string;
}
```

### PluginRegistry

```typescript
interface PluginRegistry {
  plugins: InstalledPlugin[];
}
```

---

## Metrics Types

### MetricEntry

```typescript
interface MetricEntry {
  ts: string;
  event: HookEvent;
  handler: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
  filtered?: boolean;
  usage?: TokenUsage;
  cost_usd?: number;
  session_id?: string;
  agent_type?: string;
}
```

### CostEntry

```typescript
interface CostEntry {
  ts: string;
  event: HookEvent;
  handler: string;
  model: LLMModel;
  usage: TokenUsage;
  cost_usd: number;
  batched: boolean;
}
```

### TokenUsage

```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}
```

---

## Context Types

### PrefetchKey

```typescript
type PrefetchKey = 'transcript' | 'git_status' | 'git_diff';
```

### PrefetchContext

```typescript
interface PrefetchContext {
  transcript?: string;
  git_status?: string;
  git_diff?: string;
}
```

---

## Diagnostic Types

### DiagnosticResult

```typescript
interface DiagnosticResult {
  check: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}
```

---

## Exported Functions

### Server

```typescript
createServer(manifest: Manifest, metrics: MetricsCollector): ServerContext;
startDaemon(manifest: Manifest, metrics: MetricsCollector, options?: object): Promise<ServerContext>;
stopDaemon(): boolean;
isDaemonRunning(): boolean;
```

### Manifest

```typescript
loadManifest(): Promise<Manifest>;
loadCompositeManifest(): Promise<Manifest>;
validateManifest(manifest: Manifest): void;
createDefaultManifest(authToken?: string): Promise<string>;
```

### Plugins

```typescript
loadPlugins(pluginsDir?: string, registryPath?: string): Promise<Array>;
mergeManifests(userManifest: Manifest, plugins: Array): Manifest;
validatePluginManifest(manifest: PluginManifest): void;
installPlugin(sourcePath: string, pluginsDir?: string, registryPath?: string): Promise<InstalledPlugin>;
uninstallPlugin(name: string, pluginsDir?: string, registryPath?: string): Promise<void>;
listPlugins(registryPath?: string): Promise<InstalledPlugin[]>;
```

### Handlers

```typescript
executeHandlers(
  event: HookEvent,
  input: HookInput,
  handlers: HandlerConfig[],
  context?: PrefetchContext,
  onAsyncResult?: (result: HandlerResult) => void,
  currentAgent?: string
): Promise<HandlerResult[]>;

resolveExecutionOrder(handlers: HandlerConfig[]): HandlerConfig[][];
resetSessionIsolatedHandlers(handlers: Partial<Record<HookEvent, HandlerConfig[]>>): void;
cleanupHandlerState(id: string): void;
```

### Filtering

```typescript
evaluateFilter(filter: string, input: HookInput): boolean;
```

### LLM

```typescript
executeLLMHandler(handler: LLMHandlerConfig, input: HookInput, context: PrefetchContext): Promise<HandlerResult>;
executeLLMHandlersBatched(
  handlers: LLMHandlerConfig[],
  input: HookInput,
  context: PrefetchContext,
  sessionId?: string
): Promise<HandlerResult[]>;
calculateCost(model: LLMModel, usage: TokenUsage): number;
```

### Context

```typescript
prefetchContext(keys: PrefetchKey[], input: HookInput): Promise<PrefetchContext>;
renderPromptTemplate(template: string, input: HookInput, context: PrefetchContext): string;
```

### Auth

```typescript
generateAuthToken(): string;
validateAuth(authHeader: string, expectedToken: string): boolean;
rotateToken(options?: object): Promise<string>;
```

### Metrics

```typescript
class MetricsCollector {
  record(entry: MetricEntry): void;
  // ...
}
```

### Rate Limiting

```typescript
class RateLimiter { /* ... */ }
class DenyCache { /* ... */ }
```

### Service

```typescript
installService(): Promise<void>;
uninstallService(): Promise<void>;
isServiceInstalled(): Promise<boolean>;
getServiceStatus(): Promise<string>;
```

### Migration and Diagnostics

```typescript
migrate(): Promise<void>;
restore(): Promise<void>;
syncSettings(): Promise<void>;
runDoctor(): Promise<DiagnosticResult[]>;
```

### File Watching

```typescript
startWatcher(path: string, onReload: () => void, onError?: (err: Error) => void): FSWatcher | null;
stopWatcher(watcher: FSWatcher): void;
```

### Agent

```typescript
installAgent(): Promise<void>;
```

---

[Home](../index.md) | [Prev: Config Files](config-files.md) | [Next: Monitoring](../operations/monitoring.md)
