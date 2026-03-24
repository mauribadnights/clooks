import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { request } from 'http';
import { createServer } from '../src/server.js';
import { MetricsCollector } from '../src/metrics.js';
import { resetHandlerStates } from '../src/handlers.js';
import type { Manifest, HookInput } from '../src/types.js';
import type { Server } from 'http';

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: bodyStr
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
          : undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: { raw: data } });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('server', () => {
  let server: Server;
  let port: number;

  const manifest: Manifest = {
    handlers: {
      PostToolUse: [
        {
          id: 'echo-handler',
          type: 'script',
          command: 'echo \'{"additionalContext":"from echo handler"}\'',
          timeout: 5000,
        },
        {
          id: 'decision-handler',
          type: 'script',
          command: 'echo \'{"decision":"approve","reason":"all good"}\'',
          timeout: 5000,
        },
      ],
      PreToolUse: [
        {
          id: 'silent-handler',
          type: 'script',
          command: 'true',
          timeout: 5000,
        },
      ],
    },
    settings: { port: 0, logLevel: 'error' },
  };

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        resetHandlerStates();
        const metrics = new MetricsCollector();
        const ctx = createServer(manifest, metrics);
        server = ctx.server;

        // Listen on port 0 to get a random available port
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  beforeEach(() => {
    resetHandlerStates();
  });

  it('GET /health returns 200 with status ok', async () => {
    const res = await httpRequest(port, 'GET', '/health');

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
    expect(res.data).toHaveProperty('uptime');
    expect(res.data).toHaveProperty('handlers_loaded');
  });

  it('POST /hooks/PostToolUse returns 200 with merged results', async () => {
    const input: HookInput = {
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp',
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    };

    const res = await httpRequest(port, 'POST', '/hooks/PostToolUse', input);

    expect(res.status).toBe(200);
    expect(res.data.additionalContext).toBe('from echo handler');
    expect(res.data.decision).toBe('approve');
    expect(res.data.reason).toBe('all good');
  });

  it('POST /hooks/PreToolUse with silent handler returns empty object', async () => {
    const input: HookInput = {
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    };

    const res = await httpRequest(port, 'POST', '/hooks/PreToolUse', input);

    expect(res.status).toBe(200);
    expect(res.data).toEqual({});
  });

  it('POST /hooks/InvalidEvent returns 400', async () => {
    const res = await httpRequest(port, 'POST', '/hooks/InvalidEvent', { session_id: 'x' });

    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Unknown hook event');
  });

  it('POST /hooks/PostToolUse with invalid JSON returns 400', async () => {
    // Send raw invalid JSON
    const res = await new Promise<{ status: number; data: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/hooks/PostToolUse',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString();
            });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
            });
          },
        );
        req.on('error', reject);
        req.write('not valid json {{{');
        req.end();
      },
    );

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('Invalid JSON body');
  });

  it('GET /unknown returns 404', async () => {
    const res = await httpRequest(port, 'GET', '/unknown');

    expect(res.status).toBe(404);
    expect(res.data.error).toBe('Not found');
  });

  it('POST /hooks/SessionStart with no handlers returns empty object', async () => {
    const input: HookInput = {
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/tmp',
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
    };

    const res = await httpRequest(port, 'POST', '/hooks/SessionStart', input);

    expect(res.status).toBe(200);
    expect(res.data).toEqual({});
  });
});
