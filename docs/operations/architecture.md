# Architecture

How clooks works internally.

## Overview

clooks is a persistent HTTP daemon that replaces Claude Code's process-spawning hook model. Instead of spawning a new process for each hook event, Claude Code sends HTTP requests to a long-running daemon that manages handler execution.

## System Architecture

```
Claude Code
    |
    | HTTP POST /hooks/:event
    | (Authorization: Bearer token)
    v
clooks daemon (localhost:7890)
    |
    +-- Auth check + rate limiting
    +-- Short-circuit check (deny cache)
    +-- Prefetch context (transcript, git)
    |
    +-- Load composite manifest
    |   +-- User manifest (~/.clooks/manifest.yaml)
    |   +-- Plugin manifests (~/.clooks/plugins/*/clooks-plugin.yaml)
    |
    +-- Filter handlers (enabled, agent, project, keyword)
    |
    +-- Separate async from sync handlers
    |   +-- Async: fire-and-forget (parallel, no await)
    |   +-- Sync: dependency resolution
    |
    +-- Resolve execution order (Kahn's algorithm)
    |   +-- Wave 0: no dependencies (parallel)
    |   +-- Wave 1: depends on Wave 0 (parallel)
    |   +-- Wave N: depends on Wave 0..N-1 (parallel)
    |
    +-- Execute each wave
    |   +-- Script handlers: spawn sh -c, pipe JSON stdin
    |   +-- Inline handlers: dynamic ES module import
    |   +-- LLM handlers: Anthropic API (batched by group)
    |
    +-- Record metrics + costs
    +-- Track deny decisions (short-circuit cache)
    |
    +-- Merge results -> HTTP response
```

## Key Design Decisions

### Persistent Daemon

Traditional Claude Code hooks spawn a new process per event. clooks keeps a daemon running, eliminating:

- Process spawn overhead (~34ms per invocation)
- Cold-start latency for Node.js/Python interpreters
- Redundant SDK initialization for LLM handlers

### Composite Manifests

User handlers and plugin handlers merge into a single execution pipeline. Plugin handlers are namespaced (`plugin/handler`) to prevent ID collisions. Settings (port, auth, logging) come from the user manifest only.

### Wave-Based Execution

Dependency resolution produces "waves" — groups of handlers that can run in parallel. This is the optimal balance between:

- **Maximum parallelism** within each wave
- **Correct ordering** across waves
- **Data flow** — outputs from earlier waves are available to later waves

### LLM Batching

Multiple LLM handlers with the same `batchGroup` are combined into a single API call. One prompt with multiple tasks, one response parsed and distributed. This typically halves cost and latency for multi-handler analysis.

### Hot Reload

The daemon watches `manifest.yaml` for changes. On save:

1. Diffs handler sets (added, removed, changed)
2. Cleans up state for removed handlers
3. Resets state for changed handlers with `sessionIsolation`
4. Swaps the manifest in-place — no restart required

### Short-Circuit

When a PreToolUse handler blocks a tool, PostToolUse is skipped. The denial is cached in memory (keyed by `session_id:tool_name`, 30-second TTL). This avoids wasting execution time on tools that were already denied.

## Process Model

- **Main process:** HTTP server, manifest loading, file watching, metric collection
- **Script handlers:** Spawned as child processes (`sh -c`), piped JSON on stdin/stdout
- **Inline handlers:** Loaded as ES modules in the main process (no subprocess)
- **LLM handlers:** Async HTTP calls to Anthropic API from the main process

## Resilience

- **Auto-disable:** Handlers disabled after 3 consecutive failures
- **Orphan recovery:** `/health` endpoint returns PID, enabling recovery when PID file is stale
- **macOS sleep/wake:** SIGTSTP/SIGCONT tracked; system service auto-restarts
- **Graceful shutdown:** SIGTERM/SIGINT triggers stop watcher, close server, flush metrics, remove PID file, and force-exit after 5 seconds
- **Session agent TTL:** Agent cache entries expire after 24 hours, cleaned every 60 seconds

---

Nav: [Home](../index.md) | [Prev: Troubleshooting](troubleshooting.md)
