# Async Handlers

## Overview

Set `async: true` on any handler to execute it without blocking Claude Code's response. The handler runs in the background; its output is NOT included in the hook response.

## Use Cases

- Logging and analytics
- Session tracking
- Background notifications
- Non-critical metric collection

## Configuration

```yaml
handlers:
  UserPromptSubmit:
    - id: prompt-analytics
      type: inline
      module: ~/hooks/analytics.js
      async: true
```

## Behavior

- Fires immediately, does not await completion
- Errors are swallowed (logged to `daemon.log` but don't affect response)
- Results delivered via internal `onAsyncResult` callback
- Metrics still recorded for async handlers

## Limitations

- Output NOT included in hook response to Claude Code
- If `depends` is set on an async handler, it is forced synchronous (with warning)
- Cannot be depended upon by other handlers

> **Note:** Async handlers are ideal for side effects that should never slow down the user experience. If you need the handler's output to influence Claude's behavior, use a synchronous handler instead.

---

[Home](../index.md) | [Prev: Dependencies](dependencies.md) | [Next: Short-Circuit](short-circuit.md)
