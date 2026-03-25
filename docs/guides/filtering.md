# Filtering

Handlers can be scoped to fire only under specific conditions. clooks provides three filtering mechanisms: keyword filters, agent scoping, and project scoping. All filters are AND'd together -- a handler only fires if every applicable filter passes.

## Keyword Filters

The `filter` field applies a keyword match against the JSON-stringified hook input. Matching is case-insensitive.

### Syntax

| Pattern | Meaning |
|---------|---------|
| `"word1\|word2"` | Match if ANY keyword is found (OR) |
| `"!word"` | Exclude if keyword is found (NOT) |
| `"word1\|!word2"` | Match if word1 is present AND word2 is absent |

The filter string is split on `|`. Each term is classified as positive (no prefix) or negative (`!` prefix). The rules are:

1. If ANY negative term is found in the input, the handler is **blocked**.
2. If there are positive terms, at least ONE must be found for the handler to **fire**.
3. If there are only negative terms and none matched, the handler **fires**.

### Examples

**Fire only for Bash or Execute tools:**

```yaml
- id: bash-guard
  type: script
  command: "node ~/hooks/guard.js"
  filter: "Bash|Execute"
```

**Fire for everything except Read and Glob:**

```yaml
- id: write-logger
  type: inline
  module: ~/hooks/logger.js
  filter: "!Read|!Glob"
```

This works because both `Read` and `Glob` are negative terms. The handler fires whenever neither term appears in the input.

**Fire for Write unless "test" appears in the input:**

```yaml
- id: write-review
  type: llm
  model: claude-haiku-4-5
  prompt: "Review: $ARGUMENTS"
  filter: "Write|!test"
```

Here `Write` is a positive term and `test` is negative. The handler fires when the input contains "Write" but does not contain "test".

> **Note:** The filter matches against the entire JSON-stringified hook input, not just the tool name. This means field values, file paths, and argument content are all searchable.

## Agent Scoping

The `agent` field restricts a handler to specific Claude Code agent sessions.

### Syntax

A comma-separated list of agent names (case-insensitive). The handler only fires when the current session's agent matches one of the listed names.

```yaml
- id: builder-guard
  type: script
  command: "node ~/hooks/builder-guard.js"
  agent: "builder"
```

```yaml
- id: multi-agent-hook
  type: inline
  module: ~/hooks/shared.js
  agent: "builder,coo"
```

### How Agent Detection Works

The agent name is extracted from the `agent_type` field of the `SessionStart` event payload. clooks caches this per `session_id`. Subsequent events in the same session use the cached value.

If `agent` is omitted from a handler, it fires in all sessions regardless of agent type.

## Project Scoping

The `project` field restricts a handler to sessions running in specific directories. It is matched against the `cwd` field of the hook input.

### Matching Rules

- **With wildcards (`*`):** The pattern is split on `*` and each literal segment must appear in the cwd path. Order does not matter.
- **Without wildcards:** The cwd must start with the pattern (prefix match) or equal it exactly.

### Examples

**Only fire in Driffusion projects:**

```yaml
- id: driffusion-lint
  type: script
  command: "node ~/hooks/driffusion-lint.js"
  project: "*/Driffusion/*"
```

This matches any cwd containing `/Driffusion/` anywhere in the path.

**Only fire in a specific directory:**

```yaml
- id: work-hook
  type: inline
  module: ~/hooks/work.js
  project: "/Users/me/work"
```

This matches any cwd that starts with `/Users/me/work`.

## Combining Filters

All filters are evaluated in order. A handler fires only if every condition passes:

1. `enabled` is not `false`.
2. The handler is not auto-disabled (consecutive failures < 3).
3. `agent` matches the current session agent (if specified).
4. `project` matches the session cwd (if specified).
5. `filter` keyword match passes (if specified).

If any condition fails, the handler is skipped. Skipped handlers are recorded in metrics with `filtered: true` and zero execution time.

### Full Example

```yaml
handlers:
  PreToolUse:
    - id: targeted-review
      type: llm
      model: claude-haiku-4-5
      prompt: "Review: $ARGUMENTS"
      filter: "Write|Edit"
      agent: "builder"
      project: "*/Driffusion/*"
```

This handler fires only when:
- The tool call input contains "Write" or "Edit".
- The session is running the `builder` agent.
- The working directory contains `/Driffusion/` in its path.

---

[Home](../index.md) | [Prev: LLM Handlers](llm-handlers.md) | [Next: Dependencies](dependencies.md)
