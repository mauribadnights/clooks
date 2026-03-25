// clooks rate limiting — protect against auth brute-force

export class RateLimiter {
  private attempts = new Map<string, number[]>(); // source → timestamps
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

    // Count recent attempts within window
    const recent = timestamps.filter(t => now - t <= this.windowMs);
    return recent.length < this.maxAttempts;
  }

  /** Record an attempt from source. */
  record(source: string): void {
    const now = Date.now();
    const timestamps = this.attempts.get(source) ?? [];
    timestamps.push(now);
    this.attempts.set(source, timestamps);
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
