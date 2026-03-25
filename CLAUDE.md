# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is clooks

Persistent HTTP daemon that replaces Claude Code's per-invocation process spawning for hooks. Claude Code POSTs hook events to `127.0.0.1:7890`, which dispatches to handlers defined in `~/.clooks/manifest.yaml`. Three handler types: **script** (subprocess), **inline** (in-process JS import), **llm** (Anthropic API call with prompt templates and batching).

## Commands

```bash
npm run build          # tsc → dist/
npm test               # vitest run (all tests)
npm run test:watch     # vitest watch mode
npx vitest run tests/filter.test.ts   # single test file
npx tsc --noEmit       # type-check only
npm run bench          # performance benchmarks (npx tsx benchmarks/bench.ts)
```

## Architecture

The daemon is a plain Node.js HTTP server (no frameworks). Request flow:

1. **cli.ts** — Commander-based CLI, entry point (`bin: clooks`). Handles start/stop/status/migrate/doctor/plugins/service commands.
2. **server.ts** — HTTP server creation, hook routing (`POST /hooks/:eventName`), auth, session agent caching, deny cache short-circuiting, manifest hot-reload via file watcher.
3. **handlers.ts** — Execution engine. Resolves dependency order into waves (via `deps.ts`), runs each wave in parallel. Separates async (fire-and-forget) from sync handlers. Auto-disables handlers after 3 consecutive failures. Resolves the user's login shell PATH at startup so script handlers work under launchd/systemd.
4. **llm.ts** — LLM handler execution with two backends: `api` (Anthropic SDK, supports batching and cost tracking) and `claude-code` (spawns `claude -p`, supports `--agent`). API handlers sharing a `batchGroup` are combined into a single API call. Cost tracking writes to `~/.clooks/costs.jsonl` (API backend only).
5. **manifest.ts** — Loads and validates `manifest.yaml`. `loadCompositeManifest()` merges user manifest with plugin-contributed handlers.
6. **plugin.ts** — Plugin install/remove/list. Plugins are directories with `clooks-plugin.yaml`. Handler IDs are namespaced (`pluginName/handlerId`).
7. **migrate.ts** — Converts existing `settings.json` command hooks into HTTP hooks pointing at the daemon. Creates backup.
8. **service.ts** — Platform-native service management (launchd on macOS, systemd on Linux).

Supporting modules: `filter.ts` (keyword matching), `prefetch.ts` (transcript/git context), `shortcircuit.ts` (deny cache with 30s TTL), `ratelimit.ts` (auth failure throttling), `deps.ts` (topological sort), `auth.ts` (token generation/validation), `sync.ts` (settings.json ↔ manifest sync), `watcher.ts` (manifest file watching), `metrics.ts` (JSONL metrics + TUI aggregation), `tui.ts` (ANSI dashboard), `agent.ts` (expert agent installer).

## Testing

Tests mirror `src/` — one test file per module in `tests/`. Tests use vitest. Most tests mock the filesystem and child_process to avoid touching `~/.clooks/` or `~/.claude/`. When writing tests, use dependency injection or mocking for paths — never write to real config directories.

## Key design decisions

- **No dependencies beyond commander and yaml.** The Anthropic SDK is an optional peer dependency (only needed for LLM handlers).
- **Handler outputs flow downstream** via `_handlerOutputs` injected into the HookInput for dependent handlers.
- **Merged response format:** `additionalContext` values are concatenated (newline-joined); `hookSpecificOutput`, `decision`, and `reason` use last-writer-wins.
- **Session agent tracking:** The server caches `agent_type` from SessionStart events and uses it for agent-scoped handler filtering on subsequent events in the same session.
- **Orphan recovery:** Multiple paths (start, stop, status, ensure-running) probe the `/health` endpoint to recover daemons that lost their PID file (e.g., after macOS sleep).
