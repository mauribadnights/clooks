# Config Files

All configuration, state, and data files used by clooks, with their locations, formats, and schemas.

---

## File Map

| Path | Format | Purpose |
|------|--------|---------|
| `~/.clooks/` | Directory | Configuration root |
| `~/.clooks/manifest.yaml` | YAML | Handler definitions and settings |
| `~/.clooks/daemon.pid` | Text | Running daemon PID |
| `~/.clooks/daemon.log` | Text | Daemon log output |
| `~/.clooks/metrics.jsonl` | JSONL | Hook execution metrics (max 5MB, rotated) |
| `~/.clooks/costs.jsonl` | JSONL | LLM cost tracking (max 1MB, rotated) |
| `~/.clooks/hooks/` | Directory | Built-in hook scripts |
| `~/.clooks/plugins/` | Directory | Installed plugin directories |
| `~/.clooks/plugins/installed.json` | JSON | Plugin registry |
| `~/.clooks/settings.backup.json` | JSON | Pre-migration settings backup |
| `~/.claude/settings.json` | JSON | Claude Code settings (HTTP hooks added here) |
| `~/.claude/settings.local.json` | JSON | Local settings override |
| `~/.claude/agents/clooks.md` | Markdown | clooks expert agent |

---

## Metrics File Format

`metrics.jsonl` stores one JSON object per line. Each entry records a single handler execution.

**Standard entry:**

```json
{
  "ts": "2026-03-25T10:00:00.000Z",
  "event": "PreToolUse",
  "handler": "bash-guard",
  "duration_ms": 12,
  "ok": true,
  "filtered": false,
  "session_id": "abc123",
  "agent_type": "builder"
}
```

**LLM handler entry** (includes additional fields):

```json
{
  "ts": "2026-03-25T10:00:00.000Z",
  "event": "PreToolUse",
  "handler": "code-review",
  "duration_ms": 850,
  "ok": true,
  "filtered": false,
  "session_id": "abc123",
  "agent_type": "builder",
  "usage": { "input_tokens": 150, "output_tokens": 80 },
  "cost_usd": 0.00045
}
```

---

## Cost File Format

`costs.jsonl` tracks LLM-specific cost data, one entry per LLM handler invocation using the `api` backend. Handlers using the `claude-code` backend do not produce cost entries.

```json
{
  "ts": "2026-03-25T10:00:00.000Z",
  "event": "PreToolUse",
  "handler": "code-review",
  "model": "claude-haiku-4-5",
  "usage": { "input_tokens": 200, "output_tokens": 100 },
  "cost_usd": 0.00056,
  "batched": true
}
```

---

## Plugin Registry Format

`installed.json` tracks all plugins installed via `clooks add`.

```json
{
  "plugins": [
    {
      "name": "security-suite",
      "version": "1.0.0",
      "path": "/Users/you/.clooks/plugins/security-suite",
      "installedAt": "2026-03-25T10:00:00.000Z"
    }
  ]
}
```

---

## File Rotation

Data files are rotated when they exceed their size limit:

| File | Max Size | Rotated To |
|------|----------|------------|
| `metrics.jsonl` | 5MB | `metrics.jsonl.1` |
| `costs.jsonl` | 1MB | `costs.jsonl.1` |

Only one rotated copy is kept. When rotation occurs, the existing `.1` file is overwritten.

---

## Service Files

System service files are platform-specific:

| Platform | Path |
|----------|------|
| macOS | `~/Library/LaunchAgents/com.clooks.daemon.plist` |
| Linux | `~/.config/systemd/user/clooks.service` |
| Windows | Task Scheduler task named `"clooks"` |

These are managed by `clooks service install` and `clooks service uninstall`. Do not edit them manually.

---

[Home](../index.md) | [Prev: HTTP API](http-api.md) | [Next: Types](types.md)
