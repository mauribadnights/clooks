# Short-Circuit

## Overview

When a PreToolUse handler blocks a tool call (returns `decision: "block"`), clooks automatically skips PostToolUse handlers for that same tool. This prevents wasted execution on tools that were already denied.

## How It Works

1. PreToolUse handler returns `{ decision: "block", reason: "..." }`
2. Server records denial in an in-memory DenyCache, keyed by `session_id:tool_name`
3. When PostToolUse fires for the same session + tool, clooks checks the DenyCache
4. If denied: PostToolUse handlers are skipped entirely
5. Cache entries expire after 30 seconds (prevents memory leaks)

## Configuration

This is automatic — no configuration needed. It works for all PreToolUse handlers that return a `block` decision.

The server also checks for `hookSpecificOutput.permissionDecision: "deny"` as an alternative denial signal.

## Cache Lifecycle

- Entries auto-expire after 30 seconds
- Periodic cleanup runs every 60 seconds
- Cache is in-memory only — cleared on daemon restart

> **Note:** The 30-second TTL is deliberately short. It only needs to survive long enough for the matching PostToolUse event to arrive, which typically happens within milliseconds of the PreToolUse denial.

---

[Home](../index.md) | [Prev: Async Handlers](async-handlers.md) | [Next: System Service](system-service.md)
