// cchooks HTTP server — persistent hook daemon

import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { executeHandlers } from './handlers.js';
import { MetricsCollector } from './metrics.js';
import { DEFAULT_PORT, PID_FILE, LOG_FILE, CONFIG_DIR, HOOK_EVENTS } from './constants.js';
import type { Manifest, HookEvent, HookInput, HandlerResult, HandlerConfig } from './types.js';

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
}

/**
 * Create the HTTP server for hook handling.
 */
export function createServer(manifest: Manifest, metrics: MetricsCollector): ServerContext {
  const startTime = Date.now();

  const server = httpCreateServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Health check endpoint
    if (method === 'GET' && url === '/health') {
      const handlerCount = Object.values(manifest.handlers)
        .reduce((sum, arr) => sum + (arr?.length ?? 0), 0);

      sendJson(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        handlers_loaded: handlerCount,
        port: manifest.settings?.port ?? DEFAULT_PORT,
      });
      return;
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
      const handlers = manifest.handlers[event] ?? [];

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
        const results = await executeHandlers(event, input, handlers as HandlerConfig[]);

        // Record metrics
        for (const result of results) {
          metrics.record({
            ts: new Date().toISOString(),
            event,
            handler: result.id,
            duration_ms: result.duration_ms,
            ok: result.ok,
            error: result.error,
          });
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

  return { server, metrics, startTime, manifest };
}

/**
 * Start the daemon: bind the server and write PID file.
 */
export function startDaemon(manifest: Manifest, metrics: MetricsCollector): Promise<ServerContext> {
  return new Promise((resolve, reject) => {
    const ctx = createServer(manifest, metrics);
    const port = manifest.settings?.port ?? DEFAULT_PORT;

    ctx.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log(`Port ${port} already in use`);
        reject(new Error(`Port ${port} is already in use. Is another cchooks instance running?`));
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

      log(`Daemon started on 127.0.0.1:${port} (pid ${process.pid})`);
      resolve(ctx);
    });

    // Graceful shutdown
    const shutdown = () => {
      log('Shutting down...');
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
export function startDaemonBackground(): void {
  const child = spawn(process.execPath, [process.argv[1], 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
