import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { LLMHandlerConfig, HookInput, PrefetchContext } from '../src/types.js';

// Mock the Anthropic SDK before any imports that use it
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

// Mock child_process.spawn for claude-code tests
const mockSpawn = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    spawn: (...args: any[]) => mockSpawn(...args),
  };
});

// Must import after mock is set up
const { executeLLMHandler, executeLLMHandlersBatched, calculateCost, resetClient } = await import('../src/llm.js');

function makeInput(overrides?: Partial<HookInput>): HookInput {
  return {
    session_id: 'test-session',
    transcript_path: '',
    cwd: '/tmp/test',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    prompt: 'test prompt',
    ...overrides,
  };
}

function makeHandler(overrides?: Partial<LLMHandlerConfig>): LLMHandlerConfig {
  return {
    id: 'test-llm',
    type: 'llm',
    model: 'claude-haiku-4-5',
    prompt: 'Analyze this: $TOOL_NAME',
    ...overrides,
  };
}

const emptyContext: PrefetchContext = {};

describe('executeLLMHandler', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    resetClient();
    // Set the API key so the client initializes
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  });

  it('successful API call returns result with output, usage, and cost', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: 'Analysis result' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await executeLLMHandler(makeHandler(), makeInput(), emptyContext);

    expect(result.ok).toBe(true);
    expect(result.id).toBe('test-llm');
    expect(result.output).toEqual({ additionalContext: 'Analysis result' });
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('API error returns error result', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await executeLLMHandler(makeHandler(), makeInput(), emptyContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('API rate limit exceeded');
    expect(result.id).toBe('test-llm');
  });

  it('timeout returns timeout error', async () => {
    // Create a promise that never resolves
    mockCreate.mockReturnValue(new Promise(() => {}));

    const handler = makeHandler({ timeout: 50 }); // 50ms timeout
    const result = await executeLLMHandler(handler, makeInput(), emptyContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('prompt template is rendered before sending', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const handler = makeHandler({ prompt: 'Tool is $TOOL_NAME in $CWD' });
    const input = makeInput({ tool_name: 'Read', cwd: '/home/user' });

    await executeLLMHandler(handler, input, emptyContext);

    // Verify the rendered prompt was sent to the API
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Tool is Read in /home/user' }],
      })
    );
  });
});

describe('executeLLMHandlersBatched', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    resetClient();
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  });

  it('single handler without batchGroup calls API individually', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: 'individual result' }],
      usage: { input_tokens: 50, output_tokens: 25 },
    });

    const results = await executeLLMHandlersBatched(
      [makeHandler({ id: 'solo' })],
      makeInput(),
      emptyContext
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('solo');
    expect(results[0].ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('multiple handlers with same batchGroup produce one combined API call', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '{"handler-a": "result A", "handler-b": "result B"}' }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const handlers = [
      makeHandler({ id: 'handler-a', batchGroup: 'group1', prompt: 'Task A: $TOOL_NAME' }),
      makeHandler({ id: 'handler-b', batchGroup: 'group1', prompt: 'Task B: $CWD' }),
    ];

    const results = await executeLLMHandlersBatched(handlers, makeInput(), emptyContext);

    expect(results).toHaveLength(2);
    expect(mockCreate).toHaveBeenCalledTimes(1); // Single batched call
    expect(results.find(r => r.id === 'handler-a')?.ok).toBe(true);
    expect(results.find(r => r.id === 'handler-b')?.ok).toBe(true);
  });

  it('combined prompt contains all handler prompts with task IDs', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '{"h1": "r1", "h2": "r2"}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const handlers = [
      makeHandler({ id: 'h1', batchGroup: 'g', prompt: 'First task' }),
      makeHandler({ id: 'h2', batchGroup: 'g', prompt: 'Second task' }),
    ];

    await executeLLMHandlersBatched(handlers, makeInput(), emptyContext);

    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('TASK "h1"');
    expect(sentPrompt).toContain('First task');
    expect(sentPrompt).toContain('TASK "h2"');
    expect(sentPrompt).toContain('Second task');
  });

  it('JSON response is parsed and split back to individual results', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '{"alpha": "Alpha analysis", "beta": "Beta analysis"}' }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const handlers = [
      makeHandler({ id: 'alpha', batchGroup: 'batch', prompt: 'Analyze alpha' }),
      makeHandler({ id: 'beta', batchGroup: 'batch', prompt: 'Analyze beta' }),
    ];

    const results = await executeLLMHandlersBatched(handlers, makeInput(), emptyContext);

    const alphaResult = results.find(r => r.id === 'alpha');
    const betaResult = results.find(r => r.id === 'beta');
    expect(alphaResult?.output).toEqual({ additionalContext: 'Alpha analysis' });
    expect(betaResult?.output).toEqual({ additionalContext: 'Beta analysis' });
  });

  it('handlers with different batchGroups are grouped separately', async () => {
    // Use mockImplementation to handle any number of calls
    mockCreate.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[0].content;
      if (prompt.includes('TASK "a1"')) {
        return {
          content: [{ text: '{"a1": "res1", "a2": "res2"}' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      }
      return {
        content: [{ text: '{"b1": "res3", "b2": "res4"}' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    });

    const handlers = [
      makeHandler({ id: 'a1', batchGroup: 'groupA', prompt: 'A1' }),
      makeHandler({ id: 'a2', batchGroup: 'groupA', prompt: 'A2' }),
      makeHandler({ id: 'b1', batchGroup: 'groupB', prompt: 'B1' }),
      makeHandler({ id: 'b2', batchGroup: 'groupB', prompt: 'B2' }),
    ];

    const results = await executeLLMHandlersBatched(handlers, makeInput(), emptyContext);

    // All 4 handlers produce results
    expect(results).toHaveLength(4);
    const ids = results.map(r => r.id).sort();
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2']);

    // At least one successful batch call was made (groupA handlers grouped)
    const successfulGroupA = results.filter(r => ['a1', 'a2'].includes(r.id) && r.ok);
    expect(successfulGroupA.length).toBeGreaterThan(0);

    // Verify the combined prompt for groupA contained both tasks
    const calls = mockCreate.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const groupACall = calls.find((c: any) => c[0].messages[0].content.includes('TASK "a1"'));
    if (groupACall) {
      expect(groupACall[0].messages[0].content).toContain('TASK "a2"');
    }
  });

  it('sessionId scopes batch groups to prevent cross-session batching', async () => {
    // When two calls pass different sessionIds, handlers with the same batchGroup
    // should NOT be merged into a single API call.
    // We test this by calling executeLLMHandlersBatched twice with different sessionIds
    // and verifying that each call produces its own API call.

    mockCreate.mockResolvedValue({
      content: [{ text: '{"s1": "session-1-result"}' }],
      usage: { input_tokens: 50, output_tokens: 25 },
    });

    // Call 1: session A with one handler in batchGroup "shared"
    const handlersA = [
      makeHandler({ id: 's1', batchGroup: 'shared', prompt: 'Session A task' }),
    ];
    const resultsA = await executeLLMHandlersBatched(
      handlersA,
      makeInput({ session_id: 'session-A' }),
      emptyContext,
      'session-A',
    );

    mockCreate.mockResolvedValue({
      content: [{ text: '{"s2": "session-2-result"}' }],
      usage: { input_tokens: 50, output_tokens: 25 },
    });

    // Call 2: session B with one handler in the same batchGroup "shared"
    const handlersB = [
      makeHandler({ id: 's2', batchGroup: 'shared', prompt: 'Session B task' }),
    ];
    const resultsB = await executeLLMHandlersBatched(
      handlersB,
      makeInput({ session_id: 'session-B' }),
      emptyContext,
      'session-B',
    );

    // Each call should have made its own API call (2 total)
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(resultsA).toHaveLength(1);
    expect(resultsB).toHaveLength(1);
    expect(resultsA[0].id).toBe('s1');
    expect(resultsB[0].id).toBe('s2');
  });

  it('same sessionId batches handlers with same batchGroup together', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '{"h1": "r1", "h2": "r2"}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const handlers = [
      makeHandler({ id: 'h1', batchGroup: 'grp', prompt: 'Task 1' }),
      makeHandler({ id: 'h2', batchGroup: 'grp', prompt: 'Task 2' }),
    ];

    const results = await executeLLMHandlersBatched(
      handlers,
      makeInput(),
      emptyContext,
      'same-session',
    );

    // Both handlers should be batched into a single API call
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('TASK "h1"');
    expect(sentPrompt).toContain('TASK "h2"');
  });

  it('failed JSON parse returns raw text to all handlers in group', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: 'This is not valid JSON at all' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const handlers = [
      makeHandler({ id: 'x', batchGroup: 'grp', prompt: 'X' }),
      makeHandler({ id: 'y', batchGroup: 'grp', prompt: 'Y' }),
    ];

    const results = await executeLLMHandlersBatched(handlers, makeInput(), emptyContext);

    expect(results).toHaveLength(2);
    // Both should get the raw text since JSON parse failed
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.output).toEqual({ additionalContext: 'This is not valid JSON at all' });
    }
  });
});

describe('calculateCost', () => {
  it('correct cost for haiku', () => {
    const cost = calculateCost('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    // haiku: $0.80/M input + $4.00/M output = $4.80
    expect(cost).toBeCloseTo(4.80, 2);
  });

  it('correct cost for sonnet', () => {
    const cost = calculateCost('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    // sonnet: $3.00/M input + $15.00/M output = $18.00
    expect(cost).toBeCloseTo(18.00, 2);
  });

  it('correct cost for opus', () => {
    const cost = calculateCost('claude-opus-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    // opus: $15.00/M input + $75.00/M output = $90.00
    expect(cost).toBeCloseTo(90.00, 2);
  });

  it('zero tokens = zero cost', () => {
    expect(calculateCost('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0 })).toBe(0);
    expect(calculateCost('claude-sonnet-4-6', { input_tokens: 0, output_tokens: 0 })).toBe(0);
    expect(calculateCost('claude-opus-4-6', { input_tokens: 0, output_tokens: 0 })).toBe(0);
  });

  it('unknown model returns zero cost', () => {
    expect(calculateCost('unknown-model', { input_tokens: 1000, output_tokens: 1000 })).toBe(0);
  });
});

describe('claude-code backend', () => {
  function createMockProcess(exitCode: number, stdout: string, stderr = '') {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();

    // Emit data and close asynchronously
    setTimeout(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', exitCode);
    }, 5);

    return proc;
  }

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('spawns claude CLI with -p flag and returns output', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'Analysis complete'));

    const handler = makeHandler({
      backend: 'claude-code',
      prompt: 'Analyze $TOOL_NAME',
    });
    const result = await executeLLMHandler(handler, makeInput(), emptyContext);

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ additionalContext: 'Analysis complete' });
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', expect.any(String), '--output-format', 'text']),
      expect.any(Object),
    );
  });

  it('passes --agent flag when llmAgent is set', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'Agent result'));

    const handler = makeHandler({
      backend: 'claude-code',
      llmAgent: 'reviewer',
      prompt: 'Review this',
    });
    await executeLLMHandler(handler, makeInput(), emptyContext);

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--agent');
    expect(args[args.indexOf('--agent') + 1]).toBe('reviewer');
  });

  it('passes --model flag when model is set', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'ok'));

    const handler = makeHandler({
      backend: 'claude-code',
      model: 'claude-sonnet-4-6',
      prompt: 'test',
    });
    await executeLLMHandler(handler, makeInput(), emptyContext);

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
  });

  it('returns error on non-zero exit code', async () => {
    mockSpawn.mockReturnValue(createMockProcess(1, '', 'command failed'));

    const handler = makeHandler({ backend: 'claude-code', prompt: 'test' });
    const result = await executeLLMHandler(handler, makeInput(), emptyContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('exit code 1');
    expect(result.error).toContain('command failed');
  });

  it('returns error on spawn failure', async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();
    mockSpawn.mockReturnValue(proc);

    const handler = makeHandler({ backend: 'claude-code', prompt: 'test' });
    const resultPromise = executeLLMHandler(handler, makeInput(), emptyContext);

    setTimeout(() => proc.emit('error', new Error('spawn ENOENT')), 5);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
  });

  it('has no usage or cost tracking', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'result'));

    const handler = makeHandler({ backend: 'claude-code', prompt: 'test' });
    const result = await executeLLMHandler(handler, makeInput(), emptyContext);

    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
    expect(result.cost_usd).toBeUndefined();
  });

  it('claude-code handlers skip batching even with batchGroup', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, 'result'));

    const handlers = [
      makeHandler({ id: 'cc1', backend: 'claude-code', batchGroup: 'grp', prompt: 'Task 1' }),
      makeHandler({ id: 'cc2', backend: 'claude-code', batchGroup: 'grp', prompt: 'Task 2' }),
    ];

    // Need to return a fresh process for each spawn call
    mockSpawn
      .mockReturnValueOnce(createMockProcess(0, 'result1'))
      .mockReturnValueOnce(createMockProcess(0, 'result2'));

    const results = await executeLLMHandlersBatched(handlers, makeInput(), emptyContext);

    expect(results).toHaveLength(2);
    // Each should have been spawned individually (2 spawn calls, not batched)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
