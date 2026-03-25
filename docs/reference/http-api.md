# HTTP API

clooks runs an HTTP server on localhost (default port 7890). Claude Code sends hook events as HTTP POST requests. The API also exposes health endpoints for monitoring and orchestration.

---

## Authentication

If `settings.authToken` is configured in `manifest.yaml`, all requests except `GET /health` must include the token:

```
Authorization: Bearer <token>
```

Failed authentication returns `401 Unauthorized`.

Rate limiting applies to authentication failures: after 10 failures within 60 seconds from the same source IP, the server returns `429 Too Many Requests` with a `Retry-After` header.

---

## Endpoints

### GET /health

Public health check. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "pid": 12345
}
```

### GET /health/detail

Authenticated detailed health check.

**Response:**

```json
{
  "status": "ok",
  "pid": 12345,
  "uptime": 3600,
  "handlers": 8,
  "port": 7890
}
```

### POST /hooks/:eventName

Main hook dispatch endpoint. Accepts a HookInput JSON body, executes all matching handlers for the event, and returns the merged result.

The `:eventName` parameter must be one of the 9 valid hook events (see [Hook Events](hook-events.md)).

**Request:**

```bash
curl -X POST http://localhost:7890/hooks/PreToolUse \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "abc123",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": { "command": "ls -la" },
    "cwd": "/home/user/project",
    "transcript_path": "/tmp/transcript.jsonl",
    "permission_mode": "default"
  }'
```

**Response:**

```json
{
  "additionalContext": "Handler 1 output\nHandler 2 output",
  "decision": "allow",
  "reason": "All checks passed"
}
```

---

## Response Merging

When multiple handlers return results for the same event, fields are merged as follows:

| Field | Strategy |
|-------|----------|
| `additionalContext` | Concatenated with newlines |
| `decision` | Last writer wins (latest handler in execution order) |
| `reason` | Last writer wins |
| `hookSpecificOutput` | Last writer wins |

> **Note:** Handler execution order is determined by the order in `manifest.yaml`, modified by any `depends` declarations. See [Types](types.md) for the `HandlerConfig.depends` field.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| `400` | Invalid event name or malformed JSON body |
| `401` | Missing or invalid auth token |
| `404` | Unknown route |
| `429` | Rate limited (too many authentication failures) |
| `500` | Internal server error |

All error responses return a JSON body:

```json
{
  "error": "Description of the problem"
}
```

---

[Home](../index.md) | [Prev: Hook Events](hook-events.md) | [Next: Config Files](config-files.md)
