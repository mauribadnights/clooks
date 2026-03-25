// clooks hook handlers — execution engine

import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { DEFAULT_HANDLER_TIMEOUT, MAX_CONSECUTIVE_FAILURES } from './constants.js';
import { evaluateFilter } from './filter.js';
import { executeLLMHandlersBatched } from './llm.js';
import { resolveExecutionOrder } from './deps.js';
import type { HandlerConfig, ScriptHandlerConfig, InlineHandlerConfig, LLMHandlerConfig, HandlerResult, HandlerState, HookEvent, HookInput, PrefetchContext } from './types.js';

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

/** Clean up state for a specific handler ID (used during manifest reload diffs). */
export function cleanupHandlerState(handlerId: string): void {
  handlerStates.delete(handlerId);
}

/**
 * Reset handler states for handlers that have sessionIsolation: true.
 * Called on SessionStart events.
 */
export function resetSessionIsolatedHandlers(handlers: HandlerConfig[]): void {
  for (const handler of handlers) {
    if (handler.sessionIsolation) {
      const state = handlerStates.get(handler.id);
      if (state) {
        state.consecutiveFailures = 0;
        state.disabled = false;
        state.totalFires = 0;
        state.totalErrors = 0;
      }
    }
  }
}

/**
 * Execute all handlers for an event, respecting dependency order.
 * Handlers are grouped into "waves" via topological sort.
 * Within each wave, handlers run in parallel.
 * Outputs from previous waves are available to dependent handlers via _handlerOutputs.
 */
export async function executeHandlers(
  _event: HookEvent,
  input: HookInput,
  handlers: HandlerConfig[],
  context?: PrefetchContext,
  onAsyncResult?: (result: HandlerResult) => void
): Promise<HandlerResult[]> {
  // Pre-check: filter out disabled/auto-disabled/filtered handlers before dep resolution
  const eligible: HandlerConfig[] = [];
  const skippedResults: HandlerResult[] = [];

  for (const handler of handlers) {
    if (handler.enabled === false) {
      skippedResults.push({ id: handler.id, ok: true, output: undefined, duration_ms: 0 });
      continue;
    }

    const state = getState(handler.id);
    if (state.disabled) {
      skippedResults.push({
        id: handler.id,
        ok: false,
        error: `Auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
        duration_ms: 0,
      });
      continue;
    }

    if (handler.filter) {
      const inputStr = JSON.stringify(input);
      if (!evaluateFilter(handler.filter, inputStr)) {
        skippedResults.push({
          id: handler.id,
          ok: true,
          output: undefined,
          duration_ms: 0,
          filtered: true,
        });
        continue;
      }
    }

    eligible.push(handler);
  }

  if (eligible.length === 0) {
    return skippedResults;
  }

  // Separate async handlers from sync handlers
  // Async handlers with dependents (or depended upon) are forced synchronous
  const eligibleIds = new Set(eligible.map(h => h.id));
  const dependedUpon = new Set<string>();
  for (const h of eligible) {
    if (h.depends) {
      for (const dep of h.depends) {
        if (eligibleIds.has(dep)) dependedUpon.add(dep);
      }
    }
  }

  const syncHandlers: HandlerConfig[] = [];
  const asyncHandlers: HandlerConfig[] = [];

  for (const handler of eligible) {
    if (handler.async) {
      const hasDependents = dependedUpon.has(handler.id);
      const hasDeps = handler.depends?.some(d => eligibleIds.has(d)) ?? false;
      if (hasDependents || hasDeps) {
        // Async handler has dependency relationships — force synchronous
        console.warn(`[clooks] Warning: async handler "${handler.id}" has dependency relationships, running synchronously`);
        syncHandlers.push(handler);
      } else {
        asyncHandlers.push(handler);
      }
    } else {
      syncHandlers.push(handler);
    }
  }

  // Fire async handlers without awaiting
  for (const handler of asyncHandlers) {
    getState(handler.id).totalFires++;

    if (handler.type === 'llm') {
      executeLLMHandlersBatched([handler as LLMHandlerConfig], input, context ?? {}, input.session_id).then(results => {
        for (const result of results) {
          const state = getState(result.id);
          if (result.ok) state.consecutiveFailures = 0;
          else { state.consecutiveFailures++; state.totalErrors++; if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) state.disabled = true; }
          onAsyncResult?.(result);
        }
      }).catch(() => {}); // never crash
    } else {
      executeOtherHandler(handler, input).then(result => {
        const state = getState(result.id);
        if (result.ok) state.consecutiveFailures = 0;
        else { state.consecutiveFailures++; state.totalErrors++; if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) state.disabled = true; }
        onAsyncResult?.(result);
      }).catch(() => {}); // never crash
    }
  }

  // Execute sync handlers with dependency resolution
  if (syncHandlers.length === 0) {
    return skippedResults;
  }

  // Resolve execution order into waves
  let waves: HandlerConfig[][];
  try {
    waves = resolveExecutionOrder(syncHandlers);
  } catch {
    // If dep resolution fails, fall back to flat parallel execution
    waves = [syncHandlers];
  }

  const allResults: HandlerResult[] = [...skippedResults];
  const handlerOutputs: Record<string, unknown> = {};

  for (const wave of waves) {
    // Mark totalFires for all handlers in this wave
    for (const handler of wave) {
      getState(handler.id).totalFires++;
    }

    // Build input with _handlerOutputs from previous waves
    const waveInput: HookInput = Object.keys(handlerOutputs).length > 0
      ? { ...input, _handlerOutputs: handlerOutputs }
      : input;

    // Separate LLM from script/inline within this wave
    const llmHandlers: LLMHandlerConfig[] = [];
    const otherPromises: Promise<HandlerResult>[] = [];

    for (const handler of wave) {
      if (handler.type === 'llm') {
        llmHandlers.push(handler);
      } else {
        otherPromises.push(executeOtherHandler(handler, waveInput));
      }
    }

    // Execute script/inline handlers in parallel
    const otherResults = otherPromises.length > 0
      ? await Promise.all(otherPromises)
      : [];

    // Execute LLM handlers with batching (scoped to this wave)
    let llmResults: HandlerResult[] = [];
    if (llmHandlers.length > 0) {
      try {
        llmResults = await executeLLMHandlersBatched(llmHandlers, waveInput, context ?? {}, input.session_id);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        llmResults = llmHandlers.map(h => ({
          id: h.id,
          ok: false,
          error: `LLM execution failed: ${errorMsg}`,
          duration_ms: 0,
        }));
      }
    }

    const waveResults = [...otherResults, ...llmResults];

    // Update failure tracking and collect outputs for dependents
    for (const result of waveResults) {
      const state = getState(result.id);
      if (result.ok) {
        state.consecutiveFailures = 0;
      } else {
        state.consecutiveFailures++;
        state.totalErrors++;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          state.disabled = true;
        }
      }

      // Store output for downstream handlers
      handlerOutputs[result.id] = result.output;
    }

    allResults.push(...waveResults);
  }

  return allResults;
}

/**
 * Execute a single script or inline handler with error handling.
 */
async function executeOtherHandler(handler: HandlerConfig, input: HookInput): Promise<HandlerResult> {
  const start = performance.now();
  try {
    if (handler.type === 'script') {
      return await executeScriptHandler(handler, input);
    } else if (handler.type === 'inline') {
      return await executeInlineHandler(handler, input);
    } else {
      return {
        id: handler.id,
        ok: false,
        error: `Unknown handler type: ${(handler as HandlerConfig).type}`,
        duration_ms: 0,
      };
    }
  } catch (err) {
    return {
      id: handler.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: performance.now() - start,
    };
  }
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
