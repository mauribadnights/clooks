# Deferred Fixes (Historical)

> **All issues in this document were resolved in v0.3.0. This file is kept for historical reference.**

These issues were identified in the v0.2.1 audit and deferred to v0.3.0.

## Session Isolation + LLM Batching Violation -- RESOLVED

**Problem:** Two concurrent sessions with handlers sharing a `batchGroup` would batch together into one API call, violating session isolation guarantees.

**Resolution:** Batch groups are now scoped to `{batchGroup}:{session_id}`. Session ID is passed into `executeLLMHandlersBatched()` and plugins can declare batch groups as session-scoped or global.

## Auth Token Rotation -- RESOLVED

**Problem:** Token was generated once at `clooks init` with no expiration or revocation mechanism.

**Resolution:** `clooks rotate-token` generates a new token, updates manifest and settings.json, and hot-reloads the daemon without restart.

## Manifest Reload Doesn't Trigger Session Reset -- RESOLVED

**Problem:** File watcher reloaded manifest but didn't reset session-isolated handler state.

**Resolution:** Manifest reload now diffs old vs new handlers. New handlers get fresh state, removed handlers get cleaned up, and changed handlers with `sessionIsolation: true` are reset.

## Health Endpoint Auth -- RESOLVED

**Problem:** `/health` bypassed auth, exposing operational details to unauthenticated clients.

**Resolution:** Split into `/health` (public, returns `{ status: "ok" }` only) and `/health/detail` (authenticated, returns uptime, handler count, plugin list).

## Rate Limiting on Auth Failures -- RESOLVED

**Problem:** Failed auth attempts were logged but not throttled.

**Resolution:** In-memory rate limiter rejects with 429 after repeated failed auth attempts within a time window. Resets on successful auth.
