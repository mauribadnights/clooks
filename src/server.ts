// clooks HTTP server — persistent hook daemon

import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import type { FSWatcher } from 'fs';
import { spawn } from 'child_process';
import { executeHandlers, resetSessionIsolatedHandlers, cleanupHandlerState } from './handlers.js';
import { prefetchContext } from './prefetch.js';
import { MetricsCollector } from './metrics.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { validateAuth } from './auth.js';
import { DenyCache } from './shortcircuit.js';
import { RateLimiter } from './ratelimit.js';
import { DEFAULT_PORT, PID_FILE, LOG_FILE, CONFIG_DIR, HOOK_EVENTS, MANIFEST_PATH } from './constants.js';
import { loadManifest, loadCompositeManifest } from './manifest.js';
import type { Manifest, HookEvent, HookInput, HandlerResult, HandlerConfig, PrefetchContext, CostEntry } from './types.js';

/** Session agent cache: session_id → { agent_type, timestamp } */
const sessionAgents = new Map<string, { agent: string; ts: number }>();

const SESSION_AGENT_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cleanupSessionAgents(): void {
  const now = Date.now();
  for (const [id, entry] of sessionAgents) {
    if (now - entry.ts > SESSION_AGENT_TTL) {
      sessionAgents.delete(id);
    }
  }
}

/** Exported for testing */
export { sessionAgents };

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // If we can't write logs, continue anyway
  }
}

/**
 * Merge multiple handler results into a single HTTP response body.
 *
 * - additionalContext: joined with newlines from all results that have it
 * - hookSpecificOutput: last writer wins
 * - decision/reason: last writer wins (for PostToolUse/Stop block decisions)
 */
function mergeResults(results: HandlerResult[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const contexts: string[] = [];

  for (const result of results) {
    if (!result.ok || !result.output || typeof result.output !== 'object') continue;

    const out = result.output as Record<string, unknown>;

    if (typeof out.additionalContext === 'string' && out.additionalContext) {
      contexts.push(out.additionalContext);
    }

    if (out.hookSpecificOutput !== undefined) {
      merged.hookSpecificOutput = out.hookSpecificOutput;
    }

    if (out.decision !== undefined) {
      merged.decision = out.decision;
    }

    if (out.reason !== undefined) {
      merged.reason = out.reason;
    }
  }

  if (contexts.length > 0) {
    merged.additionalContext = contexts.join('\n');
  }

  return merged;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export interface ServerContext {
  server: Server;
  metrics: MetricsCollector;
  startTime: number;
  manifest: Manifest;
  watcher?: FSWatcher;
  denyCache: DenyCache;
  rateLimiter: RateLimiter;
  cleanupInterval?: ReturnType<typeof setInterval>;
}

/**
 * Create the HTTP server for hook handling.
 */
export function createServer(manifest: Manifest, metrics: MetricsCollector): ServerContext {
  const startTime = Date.now();
  const denyCache = new DenyCache();
  const rateLimiter = new RateLimiter();
  const ctx: ServerContext = {
    server: null as unknown as Server,
    metrics,
    startTime,
    manifest,
    denyCache,
    rateLimiter,
  };
  const authToken = manifest.settings?.authToken ?? '';

  // Periodic cleanup for deny cache and rate limiter (every 60s)
  ctx.cleanupInterval = setInterval(() => {
    denyCache.cleanup();
    rateLimiter.cleanup();
    cleanupSessionAgents();
  }, 60_000);
  // Unref so it doesn't keep the process alive
  if (ctx.cleanupInterval && typeof ctx.cleanupInterval === 'object' && 'unref' in ctx.cleanupInterval) {
    ctx.cleanupInterval.unref();
  }

  const server = httpCreateServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Public health endpoint — minimal, no auth
    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Detailed health endpoint — authenticated if authToken configured
    if (method === 'GET' && url === '/health/detail') {
      if (authToken) {
        const authHeader = req.headers['authorization'] as string | undefined;
        if (!validateAuth(authHeader, authToken)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
      }

      const handlerCount = Object.values(ctx.manifest.handlers)
        .reduce((sum, arr) => sum + (arr?.length ?? 0), 0);

      sendJson(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        handlers_loaded: handlerCount,
        port: ctx.manifest.settings?.port ?? DEFAULT_PORT,
      });
      return;
    }

    // Auth check for all POST requests — only when auth token is configured
    if (method === 'POST' && authToken) {
      const source = req.socket.remoteAddress ?? 'unknown';

      // Rate limiting: check if this source has too many auth failures
      if (!rateLimiter.check(source)) {
        const retryAfter = rateLimiter.retryAfter(source);
        const body = JSON.stringify({ error: 'Too many auth failures' });
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Retry-After': String(retryAfter),
        });
        res.end(body);
        return;
      }

      const authHeader = req.headers['authorization'] as string | undefined;
      if (!validateAuth(authHeader, authToken)) {
        rateLimiter.recordFailure(source);
        log(`Auth failure from ${source}`);
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // Hook endpoint: POST /hooks/:eventName
    const hookMatch = url.match(/^\/hooks\/([A-Za-z]+)$/);
    if (method === 'POST' && hookMatch) {
      const eventName = hookMatch[1];

      if (!HOOK_EVENTS.includes(eventName)) {
        sendJson(res, 400, { error: `Unknown hook event: ${eventName}` });
        return;
      }

      const event = eventName as HookEvent;

      // On SessionStart, cache agent and reset session-isolated handlers
      if (event === 'SessionStart') {
        const allHandlers = Object.values(ctx.manifest.handlers)
          .flat()
          .filter((h): h is HandlerConfig => h != null);
        resetSessionIsolatedHandlers(allHandlers);
      }

      const handlers = ctx.manifest.handlers[event] ?? [];

      if (handlers.length === 0) {
        sendJson(res, 200, {});
        return;
      }

      let input: HookInput;
      try {
        const body = await readBody(req);
        input = JSON.parse(body) as HookInput;
      } catch (err) {
        log(`Failed to parse request body for ${eventName}: ${err}`);
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      // Cache agent_type on SessionStart
      if (event === 'SessionStart' && input.agent_type && input.session_id) {
        sessionAgents.set(input.session_id, { agent: input.agent_type, ts: Date.now() });
      }

      // Resolve current agent for this session
      const currentAgent = input.session_id ? sessionAgents.get(input.session_id)?.agent : undefined;

      // Short-circuit: skip PostToolUse if PreToolUse denied this tool
      if (event === 'PostToolUse' && input.tool_name && input.session_id) {
        if (denyCache.isDenied(input.session_id, input.tool_name)) {
          log(`PostToolUse skipped — PreToolUse denied for ${input.tool_name}`);
          sendJson(res, 200, {});
          return;
        }
      }

      const allHandlerConfigs = handlers as HandlerConfig[];
      const syncCount = allHandlerConfigs.filter(h => !h.async).length;
      const asyncCount = allHandlerConfigs.filter(h => h.async).length;
      if (asyncCount > 0) {
        log(`Hook: ${eventName} (${syncCount} sync, ${asyncCount} async handler${syncCount + asyncCount > 1 ? 's' : ''})`);
      } else {
        log(`Hook: ${eventName} (${handlers.length} handler${handlers.length > 1 ? 's' : ''})`);
      }

      try {
        // Pre-fetch shared context if configured
        let context: PrefetchContext | undefined;
        if (ctx.manifest.prefetch && ctx.manifest.prefetch.length > 0) {
          context = await prefetchContext(ctx.manifest.prefetch, input);
        }

        // Callback for recording async handler metrics when they complete
        const recordResult = (result: HandlerResult) => {
          metrics.record({
            ts: new Date().toISOString(),
            event,
            handler: result.id,
            duration_ms: result.duration_ms,
            ok: result.ok,
            error: result.error,
            filtered: result.filtered,
            usage: result.usage,
            cost_usd: result.cost_usd,
            session_id: input.session_id,
            agent_type: currentAgent,
          });

          if (result.usage && result.cost_usd !== undefined && result.cost_usd > 0) {
            const handlerConfig = allHandlerConfigs.find(h => h.id === result.id);
            if (handlerConfig && handlerConfig.type === 'llm') {
              const llmConfig = handlerConfig as import('./types.js').LLMHandlerConfig;
              metrics.trackCost({
                ts: new Date().toISOString(),
                event,
                handler: result.id,
                model: llmConfig.model,
                usage: result.usage,
                cost_usd: result.cost_usd,
                batched: !!llmConfig.batchGroup,
              });
            }
          }
        };

        const results = await executeHandlers(event, input, allHandlerConfigs, context, recordResult, currentAgent);

        // Record metrics and costs for sync results
        for (const result of results) {
          recordResult(result);
        }

        // Short-circuit: if PreToolUse had a deny, record it in the cache
        if (event === 'PreToolUse' && input.tool_name && input.session_id) {
          const hasDeny = results.some(r => {
            if (!r.ok || !r.output || typeof r.output !== 'object') return false;
            const out = r.output as Record<string, unknown>;
            // Check hookSpecificOutput.permissionDecision === 'deny'
            if (out.hookSpecificOutput && typeof out.hookSpecificOutput === 'object') {
              const hso = out.hookSpecificOutput as Record<string, unknown>;
              if (hso.permissionDecision === 'deny') return true;
            }
            // Check decision === 'block'
            if (out.decision === 'block') return true;
            return false;
          });
          if (hasDeny) {
            denyCache.recordDeny(input.session_id, input.tool_name);
          }
        }

        const merged = mergeResults(results);
        log(`  -> ${results.filter((r) => r.ok).length}/${results.length} ok, response keys: ${Object.keys(merged).join(', ') || '(empty)'}`);
        sendJson(res, 200, merged);
      } catch (err) {
        log(`Error executing handlers for ${eventName}: ${err}`);
        sendJson(res, 500, { error: 'Internal handler error' });
      }
      return;
    }

    // 404 for everything else
    sendJson(res, 404, { error: 'Not found' });
  });

  ctx.server = server;
  return ctx;
}

/**
 * Start the daemon: bind the server and write PID file.
 */
export function startDaemon(manifest: Manifest, metrics: MetricsCollector, options?: { noWatch?: boolean }): Promise<ServerContext> {
  return new Promise((resolve, reject) => {
    const ctx = createServer(manifest, metrics);
    const port = manifest.settings?.port ?? DEFAULT_PORT;

    ctx.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log(`Port ${port} already in use`);
        reject(new Error(`Port ${port} is already in use. Is another clooks instance running?`));
      } else {
        log(`Server error: ${err.message}`);
        reject(err);
      }
    });

    ctx.server.listen(port, '127.0.0.1', () => {
      // Write PID file
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }
      writeFileSync(PID_FILE, String(process.pid), 'utf-8');

      // Start file watcher unless disabled
      if (!options?.noWatch) {
        ctx.watcher = startWatcher(
          MANIFEST_PATH,
          () => {
            try {
              const newManifest = loadCompositeManifest();

              // Diff handlers: find removed, added, and changed handlers
              const oldIds = new Set<string>();
              const oldHandlerMap = new Map<string, HandlerConfig>();
              for (const handlers of Object.values(ctx.manifest.handlers)) {
                if (!handlers) continue;
                for (const h of handlers) {
                  oldIds.add(h.id);
                  oldHandlerMap.set(h.id, h);
                }
              }

              const newIds = new Set<string>();
              const newHandlerMap = new Map<string, HandlerConfig>();
              for (const handlers of Object.values(newManifest.handlers)) {
                if (!handlers) continue;
                for (const h of handlers) {
                  newIds.add(h.id);
                  newHandlerMap.set(h.id, h);
                }
              }

              // Removed handlers: clean up their state
              for (const id of oldIds) {
                if (!newIds.has(id)) {
                  cleanupHandlerState(id);
                  log(`  Handler removed: ${id}`);
                }
              }

              // Added handlers: initialize fresh state (happens automatically on first use)
              for (const id of newIds) {
                if (!oldIds.has(id)) {
                  log(`  Handler added: ${id}`);
                }
              }

              // Changed handlers with sessionIsolation: reset state
              for (const id of newIds) {
                if (oldIds.has(id)) {
                  const newH = newHandlerMap.get(id)!;
                  const oldH = oldHandlerMap.get(id)!;
                  if (newH.sessionIsolation && JSON.stringify(oldH) !== JSON.stringify(newH)) {
                    cleanupHandlerState(id);
                    log(`  Handler changed (session-isolated, state reset): ${id}`);
                  }
                }
              }

              ctx.manifest = newManifest;
              log('Manifest reloaded successfully');
            } catch (err) {
              log(`Manifest reload failed (keeping previous config): ${err instanceof Error ? err.message : err}`);
            }
          },
          (err) => {
            log(`Watcher error: ${err.message}`);
          },
        ) ?? undefined;
      }

      log(`Daemon started on 127.0.0.1:${port} (pid ${process.pid})`);
      resolve(ctx);
    });

    // Graceful shutdown
    const shutdown = () => {
      log('Shutting down...');
      stopWatcher(ctx.watcher ?? null);
      if (ctx.cleanupInterval) clearInterval(ctx.cleanupInterval);
      ctx.server.close(() => {
        try {
          if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        } catch {
          // ignore
        }
        metrics.flush();
        log('Daemon stopped.');
        process.exit(0);
      });

      // Force exit after 5s
      setTimeout(() => {
        process.exit(1);
      }, 5000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Visibility into macOS sleep/wake cycles
    process.on('SIGTSTP', () => {
      log('Daemon suspended (system sleep)');
    });
    process.on('SIGCONT', () => {
      log('Daemon resumed (system wake)');
    });
  });
}

/**
 * Stop a running daemon by reading PID file and sending SIGTERM.
 */
export function stopDaemon(): boolean {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    unlinkSync(PID_FILE);
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // Process doesn't exist — clean up stale PID
    try {
      unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    return false;
  }

  // Give it a moment, then clean up PID file
  // The daemon itself should remove it, but clean up just in case
  setTimeout(() => {
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }, 2000);

  return true;
}

/**
 * Check if daemon is currently running (PID check only).
 * Use for stop/status where a quick check is fine.
 */
export function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;

  const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return false;

  try {
    // Signal 0 tests if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running AND healthy (PID + health endpoint).
 * Defends against stale PIDs reused by macOS after sleep/lid-close.
 * Use for ensure-running and start where correctness matters.
 */
export async function isDaemonHealthy(): Promise<boolean> {
  if (!existsSync(PID_FILE)) return false;

  const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return false;

  // Step 1: PID alive?
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Step 2: Health endpoint responds?
  const port = DEFAULT_PORT; // health check always on default port
  try {
    const { get } = await import('http');
    const data = await new Promise<string>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    const health = JSON.parse(data);
    return health.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Clean up a stale daemon: remove PID file and attempt to kill the process.
 * Returns the stale PID for logging purposes.
 */
export function cleanupStaleDaemon(): number | null {
  if (!existsSync(PID_FILE)) return null;

  const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  // Remove stale PID file
  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  // Try to kill the stale process (might be our daemon but unhealthy)
  if (!isNaN(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process doesn't exist — that's fine
    }
    return pid;
  }

  return null;
}

/**
 * Start daemon as a detached background process.
 * Always removes any existing PID file first — the new daemon writes its own.
 */
export function startDaemonBackground(options?: { noWatch?: boolean }): void {
  // Clean any stale PID file before spawning
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  const args = [process.argv[1], 'start', '--foreground'];
  if (options?.noWatch) {
    args.push('--no-watch');
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
