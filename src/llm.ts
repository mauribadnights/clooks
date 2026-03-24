// clooks LLM handler execution — Anthropic Messages API with batching

import { renderPromptTemplate } from './prefetch.js';
import { DEFAULT_LLM_TIMEOUT, DEFAULT_LLM_MAX_TOKENS, LLM_PRICING } from './constants.js';
import type { LLMHandlerConfig, HandlerResult, HookInput, PrefetchContext, TokenUsage } from './types.js';

/** Lazy-loaded Anthropic SDK client */
let anthropicClient: any = null;

async function getClient(): Promise<any> {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is not set. ' +
        'LLM handlers require a valid API key.'
      );
    }
    try {
      // Dynamic import with variable to avoid TypeScript resolving the module at compile time
      const sdkModule = '@anthropic-ai/sdk';
      const { default: Anthropic } = await import(/* webpackIgnore: true */ sdkModule);
      anthropicClient = new Anthropic();
    } catch (err) {
      throw new Error(
        'Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk\n' +
        'Then set ANTHROPIC_API_KEY environment variable.'
      );
    }
  }
  return anthropicClient;
}

/** Reset client (for testing) */
export function resetClient(): void {
  anthropicClient = null;
}

/**
 * Calculate cost in USD from token usage and model.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = LLM_PRICING[model];
  if (!pricing) return 0;

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Execute a single LLM handler: render prompt, call Messages API, return result.
 */
export async function executeLLMHandler(
  handler: LLMHandlerConfig,
  input: HookInput,
  context: PrefetchContext
): Promise<HandlerResult> {
  const start = performance.now();
  const timeout = handler.timeout ?? DEFAULT_LLM_TIMEOUT;
  const maxTokens = handler.maxTokens ?? DEFAULT_LLM_MAX_TOKENS;

  try {
    const client = await getClient();
    const prompt = renderPromptTemplate(handler.prompt, input, context);

    const apiCall = client.messages.create({
      model: handler.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`LLM handler timed out after ${timeout}ms`)), timeout)
    );

    const response = await Promise.race([apiCall, timeoutPromise]) as any;

    const text = response.content?.[0]?.text ?? '';
    const usage: TokenUsage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    };
    const cost_usd = calculateCost(handler.model, usage);

    return {
      id: handler.id,
      ok: true,
      output: { additionalContext: text },
      duration_ms: performance.now() - start,
      usage,
      cost_usd,
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

/**
 * Execute a batched group of LLM handlers: combine prompts into a single
 * multi-task API call, parse JSON response back into individual results.
 */
async function executeBatchGroup(
  handlers: LLMHandlerConfig[],
  input: HookInput,
  context: PrefetchContext
): Promise<HandlerResult[]> {
  const start = performance.now();

  // Use model from first handler; warn if others differ
  const model = handlers[0].model;
  for (let i = 1; i < handlers.length; i++) {
    if (handlers[i].model !== model) {
      console.warn(
        `[clooks] Batch group "${handlers[0].batchGroup}": handler "${handlers[i].id}" ` +
        `uses model "${handlers[i].model}" but batch uses "${model}". Using "${model}".`
      );
    }
  }

  // Use highest maxTokens and timeout among group members
  const maxTokens = Math.max(...handlers.map(h => h.maxTokens ?? DEFAULT_LLM_MAX_TOKENS));
  const timeout = Math.max(...handlers.map(h => h.timeout ?? DEFAULT_LLM_TIMEOUT));

  // Build combined prompt
  const taskSections = handlers.map((h, i) => {
    const rendered = renderPromptTemplate(h.prompt, input, context);
    return `TASK "${h.id}":\n${rendered}`;
  });

  const combinedPrompt =
    'You must complete multiple analysis tasks. Respond with a JSON object where each key is the task ID and the value is your analysis for that task.\n\n' +
    taskSections.join('\n\n') +
    '\n\nRespond ONLY with valid JSON in this format:\n' +
    '{' + handlers.map(h => `"${h.id}": <your analysis>`).join(', ') + '}';

  try {
    const client = await getClient();

    const apiCall = client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: combinedPrompt }],
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Batched LLM call timed out after ${timeout}ms`)), timeout)
    );

    const response = await Promise.race([apiCall, timeoutPromise]) as any;

    const text = response.content?.[0]?.text ?? '';
    const totalUsage: TokenUsage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    };

    // Try to parse as JSON and split results
    let parsed: Record<string, unknown> = {};
    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // If JSON parsing fails, give all handlers the raw text
      const duration = performance.now() - start;
      return handlers.map(h => ({
        id: h.id,
        ok: true,
        output: { additionalContext: text },
        duration_ms: duration,
        usage: splitUsage(totalUsage, handlers.length),
        cost_usd: calculateCost(model, splitUsage(totalUsage, handlers.length)),
      }));
    }

    // Distribute results to each handler
    const duration = performance.now() - start;
    const perHandlerUsage = splitUsage(totalUsage, handlers.length);

    return handlers.map(h => {
      const handlerResult = parsed[h.id];
      const resultText = typeof handlerResult === 'string'
        ? handlerResult
        : JSON.stringify(handlerResult ?? '');

      return {
        id: h.id,
        ok: true,
        output: { additionalContext: resultText },
        duration_ms: duration,
        usage: perHandlerUsage,
        cost_usd: calculateCost(model, perHandlerUsage),
      };
    });
  } catch (err) {
    const duration = performance.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return handlers.map(h => ({
      id: h.id,
      ok: false,
      error: errorMsg,
      duration_ms: duration,
    }));
  }
}

/**
 * Split total token usage evenly across N handlers (for cost attribution in batches).
 */
function splitUsage(total: TokenUsage, count: number): TokenUsage {
  if (count <= 0) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: Math.ceil(total.input_tokens / count),
    output_tokens: Math.ceil(total.output_tokens / count),
  };
}

/**
 * Execute multiple LLM handlers, batching those with the same batchGroup.
 *
 * Strategy: handlers with the same batchGroup get their prompts combined into
 * a single API call with a structured multi-task prompt. Handlers without a
 * batchGroup are executed individually.
 */
export async function executeLLMHandlersBatched(
  handlers: LLMHandlerConfig[],
  input: HookInput,
  context: PrefetchContext
): Promise<HandlerResult[]> {
  // Group by batchGroup
  const grouped = new Map<string, LLMHandlerConfig[]>();
  const ungrouped: LLMHandlerConfig[] = [];

  for (const handler of handlers) {
    if (handler.batchGroup) {
      const existing = grouped.get(handler.batchGroup) ?? [];
      existing.push(handler);
      grouped.set(handler.batchGroup, existing);
    } else {
      ungrouped.push(handler);
    }
  }

  // Execute all in parallel: individual calls + batch groups
  const promises: Promise<HandlerResult[]>[] = [];

  // Individual (ungrouped) handlers
  for (const handler of ungrouped) {
    promises.push(
      executeLLMHandler(handler, input, context).then(r => [r])
    );
  }

  // Batch groups
  for (const [_groupId, groupHandlers] of grouped) {
    if (groupHandlers.length === 1) {
      // Single handler in group — no point batching
      promises.push(
        executeLLMHandler(groupHandlers[0], input, context).then(r => [r])
      );
    } else {
      promises.push(executeBatchGroup(groupHandlers, input, context));
    }
  }

  const resultArrays = await Promise.all(promises);
  return resultArrays.flat();
}
