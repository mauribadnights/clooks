import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DenyCache } from '../src/shortcircuit.js';

describe('DenyCache', () => {
  let cache: DenyCache;

  beforeEach(() => {
    cache = new DenyCache();
  });

  it('returns false for non-denied tool calls', () => {
    expect(cache.isDenied('session-1', 'Read')).toBe(false);
  });

  it('returns true after recording a deny', () => {
    cache.recordDeny('session-1', 'Write');
    expect(cache.isDenied('session-1', 'Write')).toBe(true);
  });

  it('scopes denies by session_id', () => {
    cache.recordDeny('session-1', 'Write');
    expect(cache.isDenied('session-1', 'Write')).toBe(true);
    expect(cache.isDenied('session-2', 'Write')).toBe(false);
  });

  it('scopes denies by tool_name', () => {
    cache.recordDeny('session-1', 'Write');
    expect(cache.isDenied('session-1', 'Write')).toBe(true);
    expect(cache.isDenied('session-1', 'Read')).toBe(false);
  });

  it('expires entries after TTL', () => {
    cache.recordDeny('session-1', 'Bash');

    // Fast-forward time past TTL (30s)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31_000);

    expect(cache.isDenied('session-1', 'Bash')).toBe(false);

    vi.useRealTimers();
  });

  it('clear removes all entries', () => {
    cache.recordDeny('s1', 'Write');
    cache.recordDeny('s2', 'Read');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.isDenied('s1', 'Write')).toBe(false);
  });

  it('cleanup removes expired entries', () => {
    cache.recordDeny('s1', 'Write');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31_000);

    cache.cleanup();
    expect(cache.size).toBe(0);

    vi.useRealTimers();
  });

  it('cleanup keeps non-expired entries', () => {
    cache.recordDeny('s1', 'Write');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000); // Only 5s passed, TTL is 30s

    cache.cleanup();
    expect(cache.size).toBe(1);

    vi.useRealTimers();
  });
});
