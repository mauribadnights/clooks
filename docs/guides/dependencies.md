# Dependencies

Handlers can declare dependencies on other handlers using the `depends` field. clooks resolves dependencies into execution "waves" using topological sort (Kahn's algorithm), running independent handlers in parallel while respecting ordering constraints.

## Overview

Without dependencies, all handlers for an event run in parallel. With dependencies, handlers are grouped into sequential waves:

- **Wave 0:** Handlers with no dependencies.
- **Wave 1:** Handlers whose dependencies are all in wave 0.
- **Wave N:** Handlers whose dependencies are all in waves 0 through N-1.

Handlers within the same wave run in parallel. Waves execute sequentially.

## How It Works

1. The dependency graph is built from `depends` fields across all eligible handlers for the event.
2. Handlers are sorted into waves using Kahn's algorithm (BFS topological sort).
3. Wave 0 executes first. All handlers in wave 0 run in parallel.
4. When wave 0 completes, wave 1 starts. Its handlers can access outputs from wave 0.
5. This continues until all waves have executed.

## Example

```yaml
handlers:
  PreToolUse:
    - id: context-loader
      type: inline
      module: ~/hooks/context.js
      # No depends -- Wave 0

    - id: security-check
      type: llm
      model: claude-haiku-4-5
      prompt: "Check security of $TOOL_NAME with args: $ARGUMENTS"
      # No depends -- Wave 0 (parallel with context-loader)

    - id: deep-review
      type: llm
      model: claude-sonnet-4-6
      prompt: "Perform deep review with full context: $ARGUMENTS"
      depends: [context-loader, security-check]
      # Both deps in Wave 0 -- this runs in Wave 1
```

Execution order:

```
Wave 0: context-loader + security-check (parallel)
   |
   v
Wave 1: deep-review (after both wave 0 handlers complete)
```

## Accessing Dependency Outputs

Handlers in wave N receive outputs from all previous waves via the `_handlerOutputs` field injected into their input:

```json
{
  "session_id": "...",
  "cwd": "...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "_handlerOutputs": {
    "context-loader": {
      "additionalContext": "Loaded project context..."
    },
    "security-check": {
      "additionalContext": "No security issues found."
    }
  }
}
```

For inline handlers, access it directly from the input object:

```javascript
export default async function(input) {
  const priorResults = input._handlerOutputs || {};
  const securityResult = priorResults['security-check'];

  // Use prior results to inform this handler's logic
  if (securityResult?.additionalContext?.includes('issue')) {
    return { decision: 'block', reason: 'Security issue detected upstream' };
  }

  return { additionalContext: 'All clear after deep review.' };
}
```

For LLM handlers, dependency outputs are available in the input but not directly interpolable into prompt templates. Use an inline handler as a dependency to prepare context that downstream LLM handlers can consume.

## Cycle Detection

Circular dependencies are detected at execution time. If a cycle exists, clooks throws an error identifying the affected handler IDs:

```
Error: Dependency cycle detected among handlers: handler-a, handler-b
```

The daemon logs the error and skips all handlers involved in the cycle. Other handlers in the same event that are not part of the cycle execute normally.

## Cross-Plugin Dependencies

Plugin handlers are namespaced as `pluginName/handlerId`. Dependency references follow these rules:

| Reference Style | Resolves To |
|-----------------|-------------|
| `depends: [other-handler]` | Same-plugin handler (auto-namespaced) |
| `depends: [other-plugin/handler-id]` | Handler from a different plugin |
| `depends: [user-handler-id]` | Handler defined in the user manifest |

Example with a plugin handler depending on a user-defined handler:

```yaml
# In clooks-plugin.yaml (plugin: my-plugin)
handlers:
  PreToolUse:
    - id: plugin-review
      type: llm
      model: claude-haiku-4-5
      prompt: "Review after context load: $ARGUMENTS"
      depends: [context-loader]  # References user manifest handler
```

The fully qualified ID of this handler is `my-plugin/plugin-review`. Other plugins or user handlers can depend on it using that full name.

## Async and Dependencies

Async handlers (`async: true`) that participate in dependency relationships are forced to run synchronously. This applies when:

- An async handler has `depends` referencing other handlers in the same event.
- Other handlers in the same event list an async handler in their `depends`.

In both cases, clooks logs a warning and runs the handler synchronously:

```
[clooks] Warning: async handler "my-handler" has dependency relationships, running synchronously
```

This is because fire-and-forget execution cannot guarantee dependency ordering. If you need a handler to be truly async, remove it from all dependency chains.

## Dependencies and Filtering

Dependencies are resolved after filtering. If a handler's dependency is filtered out (by keyword filter, agent, or project scope), the dependency is treated as satisfied. The dependent handler will not find that dependency's output in `_handlerOutputs`, but it will not be blocked waiting for it.

Only dependencies referencing handlers within the current event's eligible set are considered. References to unknown handler IDs are silently ignored.

---

[Home](../index.md) | [Prev: Filtering](filtering.md) | [Next: Async Handlers](async-handlers.md)
