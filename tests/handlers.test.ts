import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeHandlers,
  executeScriptHandler,
  resetHandlerStates,
  getHandlerStates,
  resetSessionIsolatedHandlers,
  matchAgent,
  matchProject,
} from '../src/handlers.js';
import type { HandlerConfig, HandlerResult, HookInput } from '../src/types.js';

const makeInput = (overrides?: Partial<HookInput>): HookInput => ({
  session_id: 'test-session',
  transcript_path: '/tmp/test-transcript',
  cwd: '/tmp',
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  ...overrides,
});

describe('handlers', () => {
  beforeEach(() => {
    resetHandlerStates();
  });

  describe('executeScriptHandler', () => {
    it('executes a script that returns valid JSON', async () => {
      const handler: HandlerConfig = {
        id: 'json-handler',
        type: 'script',
        command: 'echo \'{"additionalContext":"hello from handler"}\'',
        timeout: 5000,
      };

      const result = await executeScriptHandler(handler, makeInput());

      expect(result.ok).toBe(true);
      expect(result.id).toBe('json-handler');
      expect(result.output).toEqual({ additionalContext: 'hello from handler' });
      expect(result.duration_ms).toBeGreaterThan(0);
    });

    it('wraps non-JSON stdout as additionalContext', async () => {
      const handler: HandlerConfig = {
        id: 'text-handler',
        type: 'script',
        command: 'echo "plain text output"',
        timeout: 5000,
      };

      const result = await executeScriptHandler(handler, makeInput());

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ additionalContext: 'plain text output' });
    });

    it('returns ok with undefined output when stdout is empty', async () => {
      const handler: HandlerConfig = {
        id: 'silent-handler',
        type: 'script',
        command: 'true',
        timeout: 5000,
      };

      const result = await executeScriptHandler(handler, makeInput());

      expect(result.ok).toBe(true);
      expect(result.output).toBeUndefined();
    });

    it('reports failure on non-zero exit code', async () => {
      const handler: HandlerConfig = {
        id: 'fail-handler',
        type: 'script',
        command: 'exit 1',
        timeout: 5000,
      };

      const result = await executeScriptHandler(handler, makeInput());

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Exit code');
    });

    it('reports failure with stderr on non-zero exit code', async () => {
      const handler: HandlerConfig = {
        id: 'stderr-handler',
        type: 'script',
        command: 'echo "something went wrong" >&2; exit 2',
        timeout: 5000,
      };

      const result = await executeScriptHandler(handler, makeInput());

      expect(result.ok).toBe(false);
      expect(result.error).toContain('something went wrong');
    });

    it('kills the process on timeout', async () => {
      const handler: HandlerConfig = {
        id: 'timeout-handler',
        type: 'script',
        command: 'sleep 30',
        timeout: 200, // very short timeout
      };

      const start = performance.now();
      const result = await executeScriptHandler(handler, makeInput());
      const elapsed = performance.now() - start;

      expect(result.ok).toBe(false);
      // Should complete well before the 30s sleep
      expect(elapsed).toBeLessThan(5000);
    });

    it('pipes input JSON to stdin', async () => {
      const handler: HandlerConfig = {
        id: 'stdin-handler',
        type: 'script',
        // Read stdin with cat, extract session_id with node
        command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(JSON.stringify({additionalContext:j.session_id}))})\"",
        timeout: 5000,
      };

      const result = await executeScriptHandler(handler, makeInput({ session_id: 'my-session-123' }));

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ additionalContext: 'my-session-123' });
    });
  });

  describe('executeHandlers', () => {
    it('runs multiple handlers in parallel', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'h1', type: 'script', command: 'echo \'{"additionalContext":"one"}\'' },
        { id: 'h2', type: 'script', command: 'echo \'{"additionalContext":"two"}\'' },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('skips manifest-disabled handlers', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'active', type: 'script', command: 'echo ok', enabled: true },
        { id: 'disabled', type: 'script', command: 'exit 1', enabled: false },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      expect(results).toHaveLength(2);
      // The disabled handler should return ok with no output (skipped)
      const disabledResult = results.find((r) => r.id === 'disabled')!;
      expect(disabledResult.ok).toBe(true);
      expect(disabledResult.duration_ms).toBe(0);
    });

    it('auto-disables handler after 3 consecutive failures', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'flaky', type: 'script', command: 'exit 1', timeout: 1000 },
      ];

      // Fire 3 times to trigger auto-disable
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);

      // Check state
      const states = getHandlerStates();
      const state = states.get('flaky')!;
      expect(state.disabled).toBe(true);
      expect(state.consecutiveFailures).toBe(3);

      // 4th call should return auto-disabled error
      const results = await executeHandlers('PostToolUse', makeInput(), handlers);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toContain('Auto-disabled');
      expect(results[0].duration_ms).toBe(0);
    });

    it('resets consecutive failures on success', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'recovers', type: 'script', command: 'exit 1', timeout: 1000 },
      ];

      // 2 failures
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);

      let states = getHandlerStates();
      expect(states.get('recovers')!.consecutiveFailures).toBe(2);

      // Now succeed
      handlers[0].command = 'echo ok';
      await executeHandlers('PostToolUse', makeInput(), handlers);

      states = getHandlerStates();
      expect(states.get('recovers')!.consecutiveFailures).toBe(0);
      expect(states.get('recovers')!.disabled).toBe(false);
    });
  });

  describe('resetHandlerStates', () => {
    it('clears all tracked handler state', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'tracked', type: 'script', command: 'echo ok' },
      ];

      await executeHandlers('PostToolUse', makeInput(), handlers);
      expect(getHandlerStates().size).toBe(1);

      resetHandlerStates();
      expect(getHandlerStates().size).toBe(0);
    });
  });

  describe('async handlers', () => {
    it('dispatches async handler but does not include it in results', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'async-bg', type: 'script', command: 'echo \'{"additionalContext":"bg"}\'', async: true },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      // Async handler should NOT appear in the returned results
      expect(results).toHaveLength(0);
    });

    it('sync handlers still block and return results', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'sync-one', type: 'script', command: 'echo \'{"additionalContext":"one"}\'' },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].id).toBe('sync-one');
    });

    it('mixed sync/async: only sync results returned, async runs in background', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'sync-h', type: 'script', command: 'echo \'{"additionalContext":"sync"}\'' },
        { id: 'async-h', type: 'script', command: 'echo \'{"additionalContext":"async"}\'', async: true },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      // Only the sync handler should be in the results
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('sync-h');
    });

    it('async handler with depends triggers synchronous fallback', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'dep-target', type: 'script', command: 'echo \'{"additionalContext":"target"}\'' },
        { id: 'async-with-dep', type: 'script', command: 'echo \'{"additionalContext":"dependent"}\'', async: true, depends: ['dep-target'] },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      // Both should be in results because the async handler was forced sync
      expect(results).toHaveLength(2);
      expect(results.find(r => r.id === 'async-with-dep')).toBeDefined();
      expect(results.find(r => r.id === 'dep-target')).toBeDefined();
    });

    it('onAsyncResult callback fires when async handler completes', async () => {
      const asyncResults: HandlerResult[] = [];
      const handlers: HandlerConfig[] = [
        { id: 'async-cb', type: 'script', command: 'echo \'{"additionalContext":"done"}\'', async: true },
      ];

      const results = await executeHandlers(
        'PostToolUse',
        makeInput(),
        handlers,
        undefined,
        (result) => { asyncResults.push(result); }
      );

      // No sync results
      expect(results).toHaveLength(0);

      // Wait for the async handler to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(asyncResults).toHaveLength(1);
      expect(asyncResults[0].id).toBe('async-cb');
      expect(asyncResults[0].ok).toBe(true);
    });

    it('async handler does NOT delay the response', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'sync-fast', type: 'script', command: 'echo ok' },
        { id: 'async-slow', type: 'script', command: 'sleep 0.2 && echo ok', async: true },
      ];

      const start = performance.now();
      const results = await executeHandlers('PostToolUse', makeInput(), handlers);
      const elapsed = performance.now() - start;

      // Should return quickly (well under 200ms for the async handler)
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('sync-fast');
      // The response should not have waited for the 200ms async handler
      expect(elapsed).toBeLessThan(150);
    });

    it('async handler that is depended upon runs synchronously', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'async-depended', type: 'script', command: 'echo \'{"additionalContext":"base"}\'', async: true },
        { id: 'sync-dependent', type: 'script', command: 'echo \'{"additionalContext":"child"}\'', depends: ['async-depended'] },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      // Both should be in results because the async handler was forced sync (it's depended upon)
      expect(results).toHaveLength(2);
      expect(results.find(r => r.id === 'async-depended')).toBeDefined();
      expect(results.find(r => r.id === 'sync-dependent')).toBeDefined();
    });
  });

  describe('agent matching', () => {
    it('fires handler when agent matches', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'builder-only', type: 'script', command: 'echo ok', agent: 'builder' },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers, undefined, undefined, 'builder');

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].filtered).toBeUndefined();
    });

    it('skips handler when agent does not match', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'builder-only', type: 'script', command: 'echo ok', agent: 'builder' },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers, undefined, undefined, 'coo');

      expect(results).toHaveLength(1);
      expect(results[0].filtered).toBe(true);
      expect(results[0].duration_ms).toBe(0);
    });

    it('skips handler when no agent is active', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'builder-only', type: 'script', command: 'echo ok', agent: 'builder' },
      ];

      const results = await executeHandlers('PostToolUse', makeInput(), handlers);

      expect(results).toHaveLength(1);
      expect(results[0].filtered).toBe(true);
    });

    it('fires handler with comma-separated agents matching either', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'multi-agent', type: 'script', command: 'echo ok', agent: 'builder,coo' },
      ];

      const resultBuilder = await executeHandlers('PostToolUse', makeInput(), handlers, undefined, undefined, 'builder');
      expect(resultBuilder).toHaveLength(1);
      expect(resultBuilder[0].ok).toBe(true);
      expect(resultBuilder[0].filtered).toBeUndefined();

      resetHandlerStates();

      const resultCoo = await executeHandlers('PostToolUse', makeInput(), handlers, undefined, undefined, 'coo');
      expect(resultCoo).toHaveLength(1);
      expect(resultCoo[0].ok).toBe(true);
      expect(resultCoo[0].filtered).toBeUndefined();
    });

    it('agent matching is case-insensitive', () => {
      expect(matchAgent('Builder', 'builder')).toBe(true);
      expect(matchAgent('builder', 'BUILDER')).toBe(true);
    });
  });

  describe('project matching', () => {
    it('fires handler when project pattern matches cwd', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'driffusion-only', type: 'script', command: 'echo ok', project: '*/Driffusion/*' },
      ];

      const results = await executeHandlers(
        'PostToolUse',
        makeInput({ cwd: '/Users/mauricio/Mindicio/Areas/Driffusion/code' }),
        handlers,
      );

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].filtered).toBeUndefined();
    });

    it('skips handler when project pattern does not match cwd', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'driffusion-only', type: 'script', command: 'echo ok', project: '*/Driffusion/*' },
      ];

      const results = await executeHandlers(
        'PostToolUse',
        makeInput({ cwd: '/Users/mauricio/Mindicio/Areas/Master/code' }),
        handlers,
      );

      expect(results).toHaveLength(1);
      expect(results[0].filtered).toBe(true);
      expect(results[0].duration_ms).toBe(0);
    });

    it('exact path match works without wildcards', () => {
      expect(matchProject('/Users/mauricio/projects/myapp', '/Users/mauricio/projects/myapp')).toBe(true);
      expect(matchProject('/Users/mauricio/projects/myapp', '/Users/mauricio/projects/other')).toBe(false);
    });

    it('prefix match works without wildcards', () => {
      expect(matchProject('/Users/mauricio/projects', '/Users/mauricio/projects/myapp')).toBe(true);
    });
  });

  describe('combined agent + project + filter', () => {
    it('fires when all conditions match', async () => {
      const handlers: HandlerConfig[] = [
        {
          id: 'scoped',
          type: 'script',
          command: 'echo ok',
          agent: 'builder',
          project: '*/Driffusion/*',
          filter: 'Bash',
        },
      ];

      const results = await executeHandlers(
        'PreToolUse',
        makeInput({ cwd: '/home/user/Driffusion/code', tool_name: 'Bash', hook_event_name: 'PreToolUse' }),
        handlers,
        undefined,
        undefined,
        'builder',
      );

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].filtered).toBeUndefined();
    });

    it('skips when agent matches but project does not', async () => {
      const handlers: HandlerConfig[] = [
        {
          id: 'scoped',
          type: 'script',
          command: 'echo ok',
          agent: 'builder',
          project: '*/Driffusion/*',
        },
      ];

      const results = await executeHandlers(
        'PostToolUse',
        makeInput({ cwd: '/home/user/OtherProject/code' }),
        handlers,
        undefined,
        undefined,
        'builder',
      );

      expect(results).toHaveLength(1);
      expect(results[0].filtered).toBe(true);
    });
  });

  describe('resetSessionIsolatedHandlers', () => {
    it('resets state for handlers with sessionIsolation: true', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'isolated', type: 'script', command: 'exit 1', timeout: 1000, sessionIsolation: true },
      ];

      // Fail 3 times to trigger auto-disable
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);

      let states = getHandlerStates();
      expect(states.get('isolated')!.disabled).toBe(true);
      expect(states.get('isolated')!.consecutiveFailures).toBe(3);

      // Reset session-isolated handlers
      resetSessionIsolatedHandlers(handlers);

      states = getHandlerStates();
      expect(states.get('isolated')!.disabled).toBe(false);
      expect(states.get('isolated')!.consecutiveFailures).toBe(0);
      expect(states.get('isolated')!.totalFires).toBe(0);
      expect(states.get('isolated')!.totalErrors).toBe(0);
    });

    it('does NOT reset handlers without sessionIsolation', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'persistent', type: 'script', command: 'exit 1', timeout: 1000 },
      ];

      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);

      let states = getHandlerStates();
      expect(states.get('persistent')!.disabled).toBe(true);

      // Reset session-isolated — this handler should NOT be reset
      resetSessionIsolatedHandlers(handlers);

      states = getHandlerStates();
      expect(states.get('persistent')!.disabled).toBe(true);
      expect(states.get('persistent')!.consecutiveFailures).toBe(3);
    });

    it('handles mix of isolated and non-isolated handlers', async () => {
      const handlers: HandlerConfig[] = [
        { id: 'iso', type: 'script', command: 'exit 1', timeout: 1000, sessionIsolation: true },
        { id: 'non-iso', type: 'script', command: 'exit 1', timeout: 1000 },
      ];

      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);
      await executeHandlers('PostToolUse', makeInput(), handlers);

      resetSessionIsolatedHandlers(handlers);

      const states = getHandlerStates();
      expect(states.get('iso')!.disabled).toBe(false);
      expect(states.get('non-iso')!.disabled).toBe(true);
    });
  });
});
