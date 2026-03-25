// clooks HTTP server — persistent hook daemon

import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import type { FSWatcher } from 'fs';
import { spawn } from 'child_process';
import { executeHandlers, resetSessionIsolatedHandlers } from './handlers.js';
import { prefetchContext } from './prefetch.js';
import { MetricsCollector } from './metrics.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { validateAuth } from './auth.js';
import { DEFAULT_PORT, PID_FILE, LOG_FILE, CONFIG_DIR, HOOK_EVENTS, MANIFEST_PATH } from './constants.js';
import { loadManifest } from './manifest.js';
import type { Manifest, HookEvent, HookInput, HandlerResult, HandlerConfig, PrefetchContext, CostEntry } from './types.js';

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
}

/**
 * Create the HTTP server for hook handling.
 */
export function createServer(manifest: Manifest, metrics: MetricsCollector): ServerContext {
  const startTime = Date.now();
  const ctx: ServerContext = { server: null as unknown as Server, metrics, startTime, manifest };
  const authToken = manifest.settings?.authToken ?? '';

  const server = httpCreateServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Health check endpoint — no auth required for monitoring
    if (method === 'GET' && url === '/health') {
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

    // Auth check for all POST requests
    if (method === 'POST' && authToken) {
      const authHeader = req.headers['authorization'] as string | undefined;
      if (!validateAuth(authHeader, authToken)) {
        log(`Auth failure from ${req.socket.remoteAddress}`);
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

      // On SessionStart, reset session-isolated handlers across ALL events
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

      log(`Hook: ${eventName} (${handlers.length} handler${handlers.length > 1 ? 's' : ''})`);

      try {
        // Pre-fetch shared context if configured
        let context: PrefetchContext | undefined;
        if (ctx.manifest.prefetch && ctx.manifest.prefetch.length > 0) {
          context = await prefetchContext(ctx.manifest.prefetch, input);
        }

        const results = await executeHandlers(event, input, handlers as HandlerConfig[], context);

        // Record metrics and costs
        for (const result of results) {
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
          });

          // Track cost for LLM handlers
          if (result.usage && result.cost_usd !== undefined && result.cost_usd > 0) {
            // Find the handler config to get model info
            const handlerConfig = (handlers as HandlerConfig[]).find(h => h.id === result.id);
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
        ctx.watcher = startWatcher(MANIFEST_PATH, () => {
          try {
            const newManifest = loadManifest();
            ctx.manifest = newManifest;
            log('Manifest reloaded');
          } catch (err) {
            log(`Manifest reload failed: ${err instanceof Error ? err.message : err}`);
          }
        }) ?? undefined;
      }

      log(`Daemon started on 127.0.0.1:${port} (pid ${process.pid})`);
      resolve(ctx);
    });

    // Graceful shutdown
    const shutdown = () => {
      log('Shutting down...');
      stopWatcher(ctx.watcher ?? null);
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
 * Check if daemon is currently running.
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
 * Start daemon as a detached background process.
 */
export function startDaemonBackground(options?: { noWatch?: boolean }): void {
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
