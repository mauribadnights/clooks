// clooks short-circuit chains — deny cache for PreToolUse → PostToolUse

/**
 * In-memory cache of denied PreToolUse calls.
 * Keyed by session_id + tool_name.
 * Entries expire after TTL_MS (30 seconds).
 */
export class DenyCache {
  private cache = new Map<string, number>(); // key → timestamp
  private static TTL_MS = 30_000;

  private makeKey(sessionId: string, toolName: string): string {
    return `${sessionId}:${toolName}`;
  }

  /** Record a denied PreToolUse. */
  recordDeny(sessionId: string, toolName: string): void {
    this.cache.set(this.makeKey(sessionId, toolName), Date.now());
  }

  /** Check if a tool call was recently denied. */
  isDenied(sessionId: string, toolName: string): boolean {
    const ts = this.cache.get(this.makeKey(sessionId, toolName));
    if (ts === undefined) return false;
    if (Date.now() - ts > DenyCache.TTL_MS) {
      this.cache.delete(this.makeKey(sessionId, toolName));
      return false;
    }
    return true;
  }

  /** Clean up expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.cache) {
      if (now - ts > DenyCache.TTL_MS) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Get current cache size (for testing). */
  get size(): number {
    return this.cache.size;
  }
}
