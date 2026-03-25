// clooks rate limiting — protect against auth brute-force
//
// IMPORTANT: This rate limiter should ONLY be used when auth is configured.
// It tracks auth failures per source IP. When the limit is exceeded, requests
// from that source are blocked with 429 until the window expires.

export class RateLimiter {
  private attempts = new Map<string, number[]>(); // source → auth failure timestamps
  private maxAttempts: number;
  private windowMs: number;

  constructor(maxAttempts = 10, windowMs = 60_000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  /** Check if source is rate-limited. Returns true if allowed. */
  check(source: string): boolean {
    const now = Date.now();
    const timestamps = this.attempts.get(source);
    if (!timestamps) return true;

    // Count recent auth failures within window
    const recent = timestamps.filter(t => now - t <= this.windowMs);
    return recent.length < this.maxAttempts;
  }

  /** Record an auth failure from source. */
  recordFailure(source: string): void {
    const now = Date.now();
    const timestamps = this.attempts.get(source) ?? [];
    timestamps.push(now);
    this.attempts.set(source, timestamps);
  }

  /**
   * How many seconds until the rate limit resets for a given source.
   * Returns 0 if the source is not rate-limited.
   */
  retryAfter(source: string): number {
    const now = Date.now();
    const timestamps = this.attempts.get(source);
    if (!timestamps) return 0;

    const recent = timestamps.filter(t => now - t <= this.windowMs);
    if (recent.length < this.maxAttempts) return 0;

    // The oldest recent attempt determines when the window expires
    const oldest = Math.min(...recent);
    const expiresAt = oldest + this.windowMs;
    return Math.ceil((expiresAt - now) / 1000);
  }

  /** Clean up old entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [source, timestamps] of this.attempts) {
      const recent = timestamps.filter(t => now - t <= this.windowMs);
      if (recent.length === 0) {
        this.attempts.delete(source);
      } else {
        this.attempts.set(source, recent);
      }
    }
  }
}
