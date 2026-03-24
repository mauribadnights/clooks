// clooks hook handlers — execution engine

import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { DEFAULT_HANDLER_TIMEOUT, MAX_CONSECUTIVE_FAILURES } from './constants.js';
import { evaluateFilter } from './filter.js';
import type { HandlerConfig, ScriptHandlerConfig, InlineHandlerConfig, HandlerResult, HandlerState, HookEvent, HookInput, PrefetchContext } from './types.js';

/** Runtime state per handler ID */
const handlerStates = new Map<string, HandlerState>();

function getState(id: string): HandlerState {
  let state = handlerStates.get(id);
  if (!state) {
    state = { consecutiveFailures: 0, disabled: false, totalFires: 0, totalErrors: 0 };
    handlerStates.set(id, state);
  }
  return state;
}

/** Reset all handler states (useful for testing) */
export function resetHandlerStates(): void {
  handlerStates.clear();
}

/** Get a copy of the handler states map */
export function getHandlerStates(): Map<string, HandlerState> {
  return new Map(handlerStates);
}

/**
 * Execute all handlers for an event in parallel.
 * Returns merged results array.
 * Optionally accepts pre-fetched context for LLM prompt rendering.
 */
export async function executeHandlers(
  _event: HookEvent,
  input: HookInput,
  handlers: HandlerConfig[],
  context?: PrefetchContext
): Promise<HandlerResult[]> {
  const promises = handlers.map(async (handler) => {
    // Skip disabled handlers (both manifest-disabled and auto-disabled)
    if (handler.enabled === false) {
      return { id: handler.id, ok: true, output: undefined, duration_ms: 0 } as HandlerResult;
    }

    const state = getState(handler.id);
    if (state.disabled) {
      return {
        id: handler.id,
        ok: false,
        error: `Auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
        duration_ms: 0,
      } as HandlerResult;
    }

    // Evaluate keyword filter before execution
    if (handler.filter) {
      const inputStr = JSON.stringify(input);
      if (!evaluateFilter(handler.filter, inputStr)) {
        return {
          id: handler.id,
          ok: true,
          output: undefined,
          duration_ms: 0,
          filtered: true,
        } as HandlerResult;
      }
    }

    state.totalFires++;

    const start = performance.now();
    let result: HandlerResult;

    try {
      if (handler.type === 'script') {
        result = await executeScriptHandler(handler, input);
      } else if (handler.type === 'inline') {
        result = await executeInlineHandler(handler, input);
      } else {
        result = {
          id: handler.id,
          ok: false,
          error: `Unknown handler type: ${(handler as HandlerConfig).type}`,
          duration_ms: 0,
        };
      }
    } catch (err) {
      result = {
        id: handler.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: performance.now() - start,
      };
    }

    // Update failure tracking
    if (result.ok) {
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures++;
      state.totalErrors++;
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        state.disabled = true;
      }
    }

    return result;
  });

  return Promise.all(promises);
}

/**
 * Execute a script handler: spawn a child process, pipe input JSON to stdin,
 * read stdout as JSON response.
 */
export function executeScriptHandler(handler: HandlerConfig, input: HookInput): Promise<HandlerResult> {
  const h = handler as ScriptHandlerConfig;
  const timeout = h.timeout ?? DEFAULT_HANDLER_TIMEOUT;

  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn('sh', ['-c', h.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Write input JSON to stdin and close it
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = performance.now() - start;

      if (code !== 0) {
        resolve({
          id: handler.id,
          ok: false,
          error: `Exit code ${code}${stderr ? ': ' + stderr.trim() : ''}`,
          duration_ms,
        });
        return;
      }

      // Try to parse stdout as JSON
      let output: unknown = undefined;
      if (stdout.trim()) {
        try {
          output = JSON.parse(stdout.trim());
        } catch {
          // If stdout isn't valid JSON, wrap it as additionalContext
          output = { additionalContext: stdout.trim() };
        }
      }

      resolve({ id: handler.id, ok: true, output, duration_ms });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        id: handler.id,
        ok: false,
        error: `Spawn error: ${err.message}`,
        duration_ms: performance.now() - start,
      });
    });
  });
}

/**
 * Execute an inline handler: dynamically import a JS module and call its default export.
 */
export async function executeInlineHandler(handler: HandlerConfig, input: HookInput): Promise<HandlerResult> {
  const h = handler as InlineHandlerConfig;
  const timeout = h.timeout ?? DEFAULT_HANDLER_TIMEOUT;
  const start = performance.now();

  try {
    const modulePath = resolve(h.module);
    const moduleUrl = pathToFileURL(modulePath).href;
    const mod = await import(moduleUrl);

    if (typeof mod.default !== 'function') {
      return {
        id: h.id,
        ok: false,
        error: `Module "${h.module}" does not export a default function`,
        duration_ms: performance.now() - start,
      };
    }

    // Run with timeout
    const result = await Promise.race([
      mod.default(input),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Inline handler timed out after ${timeout}ms`)), timeout)
      ),
    ]);

    return {
      id: handler.id,
      ok: true,
      output: result,
      duration_ms: performance.now() - start,
    };
  } catch (err) {
    return {
      id: handler.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: performance.now() - start,
    };
  }
}
