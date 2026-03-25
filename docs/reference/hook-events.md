# Hook Events

Claude Code sends hook events to clooks via HTTP POST. Each event carries a HookInput payload with common fields plus event-specific data. There are 9 events in total.

---

## Common Fields

All events include these fields in the HookInput payload:

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Claude Code session identifier |
| `transcript_path` | `string` | Path to the session transcript file |
| `cwd` | `string` | Current working directory |
| `permission_mode` | `string` | Active permission level |
| `hook_event_name` | `string` | Event name (matches the route) |

---

## Events

### SessionStart

Fired when a Claude Code session begins.

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | How the session was started |
| `agent_type` | `string` | Active agent name (e.g., `"builder"`, `"coo"`) |

clooks caches `agent_type` for the duration of the session. Handlers with `sessionIsolation: true` are reset on this event.

### UserPromptSubmit

Fired when the user submits a prompt.

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The user's prompt text |

### PreToolUse

Fired before Claude Code executes a tool. Handlers can block tool execution by returning a deny decision.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Tool being called (e.g., `"Bash"`, `"Write"`, `"Read"`) |
| `tool_input` | `object` | Tool arguments |

A handler can return the following to prevent execution:

```json
{
  "decision": "block",
  "reason": "Destructive command detected"
}
```

### PostToolUse

Fired after a tool completes.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | `string` | Tool that was called |
| `tool_input` | `object` | Tool arguments |

> **Note:** This event is skipped if PreToolUse returned a `block` decision for the same tool invocation (short-circuit behavior).

### Stop

Fired when a session is ending.

| Field | Type | Description |
|-------|------|-------------|
| `stop_hook_active` | `boolean` | Whether the stop hook is active |

### SubagentStart

Fired when a subagent is spawned.

| Field | Type | Description |
|-------|------|-------------|
| `agent_type` | `string` | Subagent type |

### SubagentStop

Fired when a subagent completes. No additional fields beyond the common set.

### Notification

Fired when a system notification is sent. No additional fields beyond the common set.

### ConfigChange

Fired when Claude Code configuration changes. No additional fields beyond the common set.

---

## Event Flow

A typical session produces events in this order:

```
SessionStart
  UserPromptSubmit
    PreToolUse  -> (if allowed) -> PostToolUse
    PreToolUse  -> (if blocked) -> [no PostToolUse]
    ...
  UserPromptSubmit
    ...
Stop
```

Subagent events nest within the parent session:

```
SessionStart
  SubagentStart
    PreToolUse -> PostToolUse
  SubagentStop
Stop
```

---

[Home](../index.md) | [Prev: CLI Reference](cli.md) | [Next: HTTP API](http-api.md)
