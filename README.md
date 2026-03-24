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

Requires `@anthropic-ai/sdk` as a peer dependency and `ANTHROPIC_API_KEY` env var.

### Intelligent Filtering

Skip handlers based on keywords. Supports OR (`|`) and NOT (`!`) operators. Matching is case-insensitive against the full hook input JSON.

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

### Cost Tracking

Track LLM token usage and costs per handler and model. Pricing is built-in for Haiku 4.5, Sonnet 4.6, and Opus 4.6.

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

Cost data also appears in `clooks stats` when LLM handlers have been used.

## Roadmap

- **v0.3:** Plugin ecosystem, dependency resolution between handlers
- **v0.4:** Visual dashboard for hook management and metrics

## Contributing

Issues and pull requests are welcome. Run the test suite before submitting:

```bash
npm test
npm run bench
```

## License

MIT
