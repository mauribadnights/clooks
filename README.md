# clooks

**Persistent hook runtime for Claude Code.** Eliminate cold starts. Get observability.

[![npm version](https://img.shields.io/npm/v/@mauribadnights/clooks.svg)](https://www.npmjs.com/package/@mauribadnights/clooks)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Performance

| Metric | Without clooks | With clooks | Improvement |
|--------|---------------|-------------|-------------|
| Single hook invocation | ~34.6ms | ~0.31ms | **112x faster** |
| Full session (120 invocations) | ~3,986ms | ~23ms | **99% time saved** |
| 5 parallel handlers | ~424ms | ~96ms | **4.4x faster** |

> Benchmarked on Apple Silicon (M-series), Node v24.4.1. Run `npm run bench` to reproduce.

## The Problem

Claude Code spawns a fresh process for every hook invocation. Each Node.js cold start costs 30-40ms. Power users with multiple hooks accumulate 100+ process spawns per session -- that is 4-6 seconds of pure overhead, with zero visibility into what your hooks are doing or how they fail.

## Quick Start

```bash
npm install -g @mauribadnights/clooks

# Option A: Migrate existing hooks automatically
clooks migrate     # converts command hooks to HTTP hooks + manifest
clooks start       # starts the daemon

# Option B: Start fresh
clooks init        # creates ~/.clooks/manifest.yaml
clooks start
```

That is it. Claude Code will now POST to your daemon instead of spawning processes.

## How It Works

```
Claude Code                          clooks daemon (localhost:7890)
    |                                        |
    |-- SessionStart ------> POST /hooks/SessionStart ------> [handler1, handler2]
    |-- UserPromptSubmit --> POST /hooks/UserPromptSubmit --> [handler3]
    |-- PreToolUse (x50) --> POST /hooks/PreToolUse --------> [handler4, handler5]
    |-- Stop --------------> POST /hooks/Stop ---------------> [handler6]
    |                                        |
    |<-------------- JSON responses ---------|
```

One persistent process. Zero cold starts. Full observability.

After `clooks migrate`, your `settings.json` is rewritten so that `SessionStart` runs a single command hook (`clooks ensure-running`) and all other hooks become HTTP POSTs. The daemon loads handlers from `~/.clooks/manifest.yaml` and dispatches them in parallel per event. Handlers that fail 3 times consecutively are auto-disabled to prevent cascading failures.

## Commands

| Command | Description |
|---------|-------------|
| `clooks start` | Start the daemon (background by default, `--foreground` for debug) |
| `clooks stop` | Stop the daemon |
| `clooks status` | Show daemon status, uptime, and handler count |
| `clooks stats` | Show hook execution metrics (fires, errors, latency) |
| `clooks migrate` | Convert `settings.json` command hooks to HTTP hooks |
| `clooks restore` | Restore original `settings.json` from backup |
| `clooks doctor` | Run diagnostic health checks |
| `clooks init` | Create default config directory and example manifest |
| `clooks ensure-running` | Start daemon if not already running (used by SessionStart hook) |
| `clooks add <path>` | Install a plugin from a local directory |
| `clooks remove <name>` | Uninstall a plugin and its contributed handlers |
| `clooks plugins` | List installed plugins and their handlers |
| `clooks rotate-token` | Generate a new auth token, update manifest + settings.json, hot-reload daemon |
| `clooks costs` | Show LLM token usage and cost breakdown |

## Manifest Format

Handlers are defined in `~/.clooks/manifest.yaml`:

```yaml
handlers:
  PreToolUse:
    - id: safety-guard
      type: script                    # runs a shell command
      command: node ~/hooks/guard.js
      timeout: 3000
      enabled: true

    - id: context-injector
      type: inline                    # imports a JS module directly (no subprocess)
      module: ~/hooks/context.js
      timeout: 2000

  Stop:
    - id: session-logger
      type: script
      command: ~/hooks/log-session.sh

settings:
  port: 7890
  logLevel: info
```

**Handler types:**
- `script` -- runs a shell command, pipes hook JSON to stdin, reads JSON from stdout.
- `inline` -- imports a JS module and calls its default export. Faster; no subprocess overhead.
- `llm` -- calls Anthropic Messages API. Supports prompt templates, batching, and cost tracking. *(v0.2+)*

## Observability

### Execution Metrics

```
$ clooks stats

Event               Fires     Errors    Avg (ms)    Min (ms)    Max (ms)
------------------------------------------------------------------------
PreToolUse          47        0         1.2         0.8         3.1
Stop                12        0         2.4         1.1         5.6
UserPromptSubmit    12        1         1.8         0.9         4.2

Total fires: 71 | Total errors: 1 | Spawns saved: ~71
```

### Diagnostics

```
$ clooks doctor

[pass] Daemon is running (PID 44721, uptime 2h 13m)
[pass] Port 7890 is responding
[pass] Manifest loaded: 4 handlers across 3 events
[pass] settings.json has HTTP hooks pointing to clooks
[pass] No handlers in circuit-breaker state
[warn] 1 handler error in last 24h (session-logger on Stop)
```

## Comparison

| | Without clooks | With clooks |
|---|---|---|
| **Process model** | New process per hook invocation | One persistent HTTP server |
| **Cold start overhead** | 30-40ms per invocation | 0ms (already running) |
| **State management** | Stateless -- each invocation starts fresh | Persistent -- share state across invocations |
| **Observability** | None | Metrics, stats, logs, doctor diagnostics |
| **Error handling** | Silent failures | Auto-disable after 3 consecutive failures |

## Configuration Reference

| Option | Default | Description |
|--------|---------|-------------|
| Port | `7890` | HTTP server port |
| Config directory | `~/.clooks/` | Root configuration directory |
| Manifest | `~/.clooks/manifest.yaml` | Handler definitions |
| Metrics | `~/.clooks/metrics.jsonl` | Execution metrics log |
| Daemon log | `~/.clooks/daemon.log` | Server output log |
| PID file | `~/.clooks/daemon.pid` | Process ID file |

## v0.2 Features

### LLM Handlers

Call the Anthropic Messages API directly from your manifest. Handlers with the same `batchGroup` are combined into a single API call, saving tokens and latency.

```yaml
handlers:
  PreToolUse:
    - id: code-review
      type: llm
      model: claude-haiku-4-5
      prompt: "Review this tool call for $TOOL_NAME with args: $ARGUMENTS"
      batchGroup: analysis
      timeout: 15000

    - id: security-check
      type: llm
      model: claude-haiku-4-5
      prompt: "Check for security issues in $TOOL_NAME call: $ARGUMENTS"
      batchGroup: analysis    # batched with code-review into one API call
```

**Setup:**

```bash
npm install @anthropic-ai/sdk    # peer dependency, only needed for llm handlers
export ANTHROPIC_API_KEY=sk-...  # or set in manifest: settings.anthropicApiKey
```

**Prompt template variables:**

| Variable | Source | Description |
|----------|--------|-------------|
| `$TRANSCRIPT` | Pre-fetched transcript file | Last 50KB of session transcript |
| `$GIT_STATUS` | `git status --porcelain` | Current working tree status |
| `$GIT_DIFF` | `git diff --stat` | Changed files summary (max 20KB) |
| `$ARGUMENTS` | `hook_input.tool_input` | JSON-stringified tool arguments |
| `$TOOL_NAME` | `hook_input.tool_name` | Name of the tool being called |
| `$PROMPT` | `hook_input.prompt` | User's prompt (UserPromptSubmit only) |
| `$CWD` | `hook_input.cwd` | Current working directory |

**LLM handler options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | required | `claude-haiku-4-5`, `claude-sonnet-4-6`, or `claude-opus-4-6` |
| `prompt` | string | required | Prompt template with `$VARIABLE` interpolation |
| `batchGroup` | string | optional | Group ID -- handlers with same group make one API call |
| `maxTokens` | number | `1024` | Maximum output tokens |
| `temperature` | number | `1.0` | Sampling temperature |
| `filter` | string | optional | Keyword filter (see Filtering) |
| `timeout` | number | `30000` | Timeout in milliseconds |

**How batching works:**

When multiple LLM handlers share a `batchGroup` on the same event, clooks combines their prompts into a single multi-task API call and splits the structured response back to each handler. This means 3 Haiku calls become 1, saving ~2/3 of the input token cost and eliminating 2 round-trips.

### Intelligent Filtering

Skip handlers based on keywords. The `filter` field works on **all handler types** -- script, inline, and llm.

**Filter syntax:**

```
filter: "word1|word2"      # run if input contains word1 OR word2
filter: "!word"            # run unless input contains word
filter: "word1|!word2"     # run if word1 present AND word2 absent
```

Matching is case-insensitive against the full JSON-serialized hook input.

```yaml
handlers:
  PreToolUse:
    - id: bash-guard
      type: script
      command: node ~/hooks/guard.js
      filter: "Bash|Execute|!Read"   # runs for Bash/Execute, never for Read
```

### Shared Context Pre-fetch

Fetch transcript, git status, or git diff once per hook event and share across all handlers. Avoids redundant I/O when multiple handlers need the same data. Use `$VARIABLE` interpolation in LLM prompts.

```yaml
prefetch:
  - transcript
  - git_status
  - git_diff

handlers:
  Stop:
    - id: session-summary
      type: llm
      model: claude-haiku-4-5
      prompt: "Summarize this session:\n$TRANSCRIPT\n\nGit changes:\n$GIT_DIFF"
```

**Available prefetch keys:**

| Key | Source | Max size | Description |
|-----|--------|----------|-------------|
| `transcript` | `transcript_path` file | 50KB (tail) | Session conversation history |
| `git_status` | `git status --porcelain` | unbounded | Working tree status |
| `git_diff` | `git diff --stat` | 20KB | Changed files summary |

Pre-fetched data is cached for the duration of a single event dispatch. Errors on individual keys are silently caught -- a failed `git_status` won't prevent `transcript` from loading.

### Cost Tracking

Track LLM token usage and costs per handler and model.

```
$ clooks costs

LLM Cost Summary
  Total: $0.0142 (4,280 tokens)

  By Model:
    claude-haiku-4-5       $0.0142 (4,280 tokens)

  By Handler:
    code-review            $0.0089 (12 calls, avg 178 tokens)
    security-check         $0.0053 (12 calls, avg 178 tokens)
```

- Costs are persisted to `~/.clooks/costs.jsonl`
- Built-in pricing (per million tokens): Haiku ($0.80 / $4.00), Sonnet ($3.00 / $15.00), Opus ($15.00 / $75.00)
- Batching savings are estimated based on shared input tokens
- Cost data also appears in `clooks stats` when LLM handlers have been used

## v0.3 Features

### Plugin System

Plugins let you package and share sets of handlers. A plugin is any directory with a `clooks-plugin.yaml` spec:

```yaml
# clooks-plugin.yaml
name: my-security-suite
version: 1.0.0
description: Security guards for tool calls
handlers:
  PreToolUse:
    - id: bash-guard
      type: inline
      module: ./handlers/bash-guard.js
      timeout: 3000
    - id: file-guard
      type: inline
      module: ./handlers/file-guard.js
      timeout: 2000
```

Install, remove, and list plugins:

```bash
clooks add ./my-security-suite     # install from local path
clooks remove my-security-suite    # uninstall
clooks plugins                     # list installed plugins + handlers
```

Handler IDs are namespaced to the plugin (`my-security-suite:bash-guard`) to avoid collisions with user-defined handlers or other plugins.

### Dependency Resolution

Handlers can declare dependencies on other handlers using the `depends` field. clooks resolves dependencies into topological execution waves -- handlers in the same wave run in parallel, waves execute sequentially.

```yaml
handlers:
  PreToolUse:
    - id: context-loader
      type: inline
      module: ~/hooks/context.js

    - id: security-check
      type: llm
      model: claude-haiku-4-5
      prompt: "Check $TOOL_NAME for issues given context: $CONTEXT"
      depends: [context-loader]    # waits for context-loader to finish first
```

In this example, `context-loader` runs in wave 1, and `security-check` runs in wave 2 after it completes. Handlers with no dependencies (or whose dependencies are already satisfied) run in parallel within the same wave.

### Short-Circuit Chains

When a `PreToolUse` handler returns a deny decision, clooks automatically skips the corresponding `PostToolUse` handlers for that tool call. This avoids wasted work (and wasted LLM calls) on tool invocations that were blocked.

Deny results are cached with a 30-second TTL, so repeated calls to the same tool with the same arguments short-circuit without re-evaluating handlers.

### Other v0.3 Improvements

- **Auth token rotation:** `clooks rotate-token` generates a new token, updates manifest and settings.json, and hot-reloads the daemon -- no restart required.
- **Health endpoint split:** `/health` is now public (returns `{ status: "ok" }` only). `/health/detail` requires auth and returns uptime, handler count, and plugin list.
- **Rate limiting on auth failures:** In-memory rate limiter rejects with 429 after repeated failed auth attempts within a time window. Resets on successful auth.
- **Session-scoped LLM batch groups:** Batch groups are now scoped to `{batchGroup}:{session_id}`, preventing cross-session batching violations.
- **Manifest reload resets handler state:** Reloading the manifest now diffs old vs new handlers and resets session-isolated state for changed or new handlers.

## Roadmap

- **v0.4:** Visual dashboard for hook management and metrics

## Contributing

Issues and pull requests are welcome. Run the test suite before submitting:

```bash
npm test
npm run bench
```

## License

MIT
