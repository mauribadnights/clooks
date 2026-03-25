# Deferred Fixes — To Be Addressed in v0.3.0

These issues were identified in the v0.2.1 audit but are deferred because v0.3.0 (plugin ecosystem) will change the underlying architecture they depend on. Fixing them now would mean reworking them during v0.3.0.

## Session Isolation + LLM Batching Violation

**Problem:** Two concurrent sessions with handlers sharing a `batchGroup` will batch together into one API call, violating session isolation guarantees.

**Why deferred:** v0.3.0 adds dependency resolution between handlers. How batch groups work across plugins (and across sessions) needs to be designed holistically — not patched onto the current system.

**Fix direction:** Pass `session_id` into `executeLLMHandlersBatched()`. Batch groups should be scoped to `{batchGroup}:{session_id}`. The plugin spec should define whether a plugin's batch group is session-scoped or global.

## Auth Token Rotation

**Problem:** Token is generated once at `clooks init`. No expiration, no revocation. If compromised, manual edit of manifest + settings.json + daemon restart required.

**Why deferred:** Plugin install/uninstall will need to manage auth for plugin-contributed hooks. Token lifecycle (generation, rotation, per-plugin tokens vs global token) should be designed alongside the plugin lifecycle.

**Fix direction:** `clooks rotate-token` command that generates a new token, updates manifest, rewrites settings.json headers, and hot-reloads the daemon. Plugins could optionally have per-plugin tokens scoped to their handlers.

## Manifest Reload Doesn't Trigger Session Reset

**Problem:** File watcher reloads manifest but doesn't call `resetSessionIsolatedHandlers()`. New config takes effect with stale handler state from the previous manifest version.

**Why deferred:** v0.3.0 changes manifest structure — plugins contribute handler entries, and the manifest becomes a composite of user config + installed plugins. The reload mechanism will be redesigned to handle plugin additions/removals, at which point handler state lifecycle gets a proper design.

**Fix direction:** Manifest reload should diff old vs new handlers. New handlers get fresh state. Removed handlers get their state cleaned up. Changed handlers with `sessionIsolation: true` get reset.

## Health Endpoint Auth

**Problem:** `/health` bypasses auth, exposing uptime, handler count, and port to unauthenticated clients on localhost.

**Why deferred:** Plugins may need the health endpoint for their own monitoring. The v0.3.0 plugin spec should define what monitoring data is public vs authenticated.

**Fix direction:** Split into `/health` (public, returns only `{ status: "ok" }`) and `/health/detail` (authenticated, returns uptime, handler count, plugin list). Or make it configurable in manifest settings.

## Rate Limiting on Auth Failures

**Problem:** Failed auth attempts are logged but not throttled. Brute force is impractical (32 hex chars) but there's no defense-in-depth.

**Why deferred:** Not urgent given token entropy. When the plugin ecosystem adds more HTTP endpoints (plugin management, dashboard), rate limiting should be designed across all endpoints — not just auth.

**Fix direction:** Simple in-memory rate limiter: after N failed auth attempts from the same source within T seconds, reject with 429. Reset on successful auth.
