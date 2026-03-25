import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeHandlers,
  executeScriptHandler,
  resetHandlerStates,
  getHandlerStates,
  resetSessionIsolatedHandlers,
} from '../src/handlers.js';
import type { HandlerConfig, HookInput } from '../src/types.js';

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
