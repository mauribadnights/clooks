# clooks

Persistent hook runtime for Claude Code — eliminate cold starts, get observability.

## The Problem

Claude Code spawns a fresh process for every hook invocation. Power users with multiple hooks (safety guards, context injectors, custom scripts) accumulate **100+ process spawns per session**. Each Node.js cold start costs 50-100ms. That's 6-11 seconds of pure overhead per session — and you get zero visibility into what your hooks are doing.

## How clooks Fixes It

One persistent HTTP server handles all your hooks. Claude Code's [built-in HTTP hook support](https://docs.anthropic.com/en/docs/claude-code/hooks) POSTs to `localhost:7890` instead of spawning processes. **One process instead of hundreds.**

```
┌─────────────┐     POST /hooks/PreToolUse     ┌──────────────────┐
│             │ ──────────────────────────────► │                  │
│ Claude Code │     POST /hooks/Stop           │  clooks daemon  │
│             │ ──────────────────────────────► │  (persistent)    │
│             │     POST /hooks/...            │                  │
│             │ ──────────────────────────────► │  ┌────────────┐ │
│             │                                │  │ handler A  │ │
│             │ ◄────────────── JSON ───────── │  │ handler B  │ │
│             │                                │  │ handler C  │ │
└─────────────┘                                │  └────────────┘ │
                                               │  metrics.jsonl  │
                                               └──────────────────┘
```

## Quick Start

```bash
npm install -g clooks

# If you have existing hooks in settings.json:
clooks migrate    # converts command hooks → HTTP hooks + manifest

# Or start fresh:
clooks init       # creates ~/.clooks/manifest.yaml

clooks start      # starts the daemon
```

That's it. Claude Code will now POST to your daemon instead of spawning processes.

## Commands

| Command | Description |
|---|---|
| `clooks start` | Start the daemon (background by default, `--foreground` for debug) |
| `clooks stop` | Stop the daemon |
| `clooks status` | Show daemon status, uptime, and handler count |
| `clooks stats` | Show hook execution metrics (fires, errors, latency) |
| `clooks migrate` | Convert `settings.json` command hooks to HTTP hooks |
| `clooks restore` | Restore original `settings.json` from backup |
| `clooks doctor` | Run diagnostic health checks |
| `clooks init` | Create default config directory and example manifest |
| `clooks ensure-running` | Start daemon if not running (used by SessionStart hook) |

## Manifest Format

Handlers are defined in `~/.clooks/manifest.yaml`:

```yaml
handlers:
  PreToolUse:
    - id: safety-guard
      type: script
      command: node ~/hooks/guard.js
      timeout: 3000
      enabled: true

    - id: context-injector
      type: inline
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
- `script` — runs a shell command, pipes hook JSON to stdin, reads JSON from stdout
- `inline` — imports a JS module and calls its default export (faster, no subprocess)

## Stats

```
$ clooks stats

Event               Fires     Errors    Avg (ms)    Min (ms)    Max (ms)
------------------------------------------------------------------------
PreToolUse          47        0         1.2         0.8         3.1
Stop                12        0         2.4         1.1         5.6
UserPromptSubmit    12        1         1.8         0.9         4.2

Total fires: 71 | Total errors: 1 | Spawns saved: ~71
```

## How It Works with Claude Code

After `clooks migrate`, your `settings.json` looks like this:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [
      { "type": "command", "command": "clooks ensure-running" }
    ]}],
    "PreToolUse": [{ "hooks": [
      { "type": "http", "url": "http://localhost:7890/hooks/PreToolUse" }
    ]}]
  }
}
```

The `SessionStart` command hook ensures the daemon is running (fast no-op if already up). All other hooks are HTTP POSTs — no process spawning, no cold starts.

Handlers that fail 3 times consecutively are auto-disabled to prevent cascading failures.

## Configuration

| Item | Default |
|---|---|
| Port | `7890` |
| Config directory | `~/.clooks/` |
| Manifest | `~/.clooks/manifest.yaml` |
| Metrics | `~/.clooks/metrics.jsonl` |
| Daemon log | `~/.clooks/daemon.log` |
| PID file | `~/.clooks/daemon.pid` |

## Comparison

|  | Without clooks | With clooks |
|---|---|---|
| **Process model** | New process per hook invocation | One persistent HTTP server |
| **Cold start** | 50-100ms per invocation | 0ms (already running) |
| **State** | Stateless — each invocation starts fresh | Persistent — share state across invocations |
| **Observability** | None | Metrics, stats, logs, doctor diagnostics |
| **Failure handling** | Silent | Auto-disable after 3 consecutive failures |

## License

MIT

## Roadmap

- **v0.2:** Matcher support in manifest, LLM call batching, token cost tracking
- **v0.3:** Plugin ecosystem, dependency resolution between handlers
