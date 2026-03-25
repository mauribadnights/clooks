import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 10_000); // 3 attempts per 10s
  });

  it('allows requests under the limit', () => {
    expect(limiter.check('source-1')).toBe(true);
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(true);
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(true);
  });

  it('blocks requests over the limit', () => {
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(false);
  });

  it('scopes by source', () => {
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(false);
    expect(limiter.check('source-2')).toBe(true); // different source, still allowed
  });

  it('allows requests after window expires', () => {
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11_000); // Past the 10s window

    expect(limiter.check('source-1')).toBe(true);

    vi.useRealTimers();
  });

  it('cleanup removes expired entries', () => {
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11_000);

    limiter.cleanup();
    // After cleanup, old attempts are gone — should allow again
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(false);

    vi.useRealTimers();
  });

  it('uses default values (10 attempts, 60s)', () => {
    const defaultLimiter = new RateLimiter();
    for (let i = 0; i < 10; i++) {
      defaultLimiter.recordFailure('x');
    }
    expect(defaultLimiter.check('x')).toBe(false);
  });

  it('retryAfter returns 0 when not rate-limited', () => {
    expect(limiter.retryAfter('source-1')).toBe(0);
    limiter.recordFailure('source-1');
    expect(limiter.retryAfter('source-1')).toBe(0);
  });

  it('retryAfter returns positive seconds when rate-limited', () => {
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    limiter.recordFailure('source-1');
    expect(limiter.check('source-1')).toBe(false);
    const retry = limiter.retryAfter('source-1');
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(10);
  });
});
