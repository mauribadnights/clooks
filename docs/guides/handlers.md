# Handlers

clooks supports three handler types: **script**, **inline**, and **llm**. Each type trades off between flexibility and performance. This guide covers how each type works, when to use it, and how to structure the output.

## Script Handlers

Script handlers run shell commands via `sh -c`. They are the most portable option -- any language that reads stdin and writes stdout works.

### How They Work

1. clooks spawns a child process with the handler's `command`.
2. The full `HookInput` JSON is piped to the process's stdin.
3. The process writes its response to stdout.
4. If stdout is valid JSON, it is used directly. If not, the raw text is wrapped as `{"additionalContext": "..."}`.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Shell command to execute via `sh -c` |

### Default Timeout

5000ms. Override with the `timeout` field.

### Example Configuration

```yaml
handlers:
  PreToolUse:
    - id: bash-guard
      type: script
      command: "node ~/.clooks/hooks/bash-guard.js"
      filter: "Bash"
      timeout: 3000
```

### Example Script (Node.js)

```javascript
#!/usr/bin/env node

// Read HookInput from stdin
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(data);

  // Check if the Bash command looks dangerous
  const args = input.tool_input || {};
  const command = args.command || '';

  if (command.includes('rm -rf /')) {
    // Block the tool call
    console.log(JSON.stringify({
      decision: 'block',
      reason: 'Dangerous rm -rf command detected'
    }));
  } else {
    // Add context for Claude
    console.log(JSON.stringify({
      additionalContext: `Bash command reviewed: ${command.slice(0, 80)}`
    }));
  }
});
```

> **Note:** Non-zero exit codes are treated as handler failures. Stderr output is captured and included in the error message.

## Inline Handlers

Inline handlers import an ES module in-process. There is no subprocess overhead, making them the fastest handler type.

### How They Work

1. clooks dynamically imports the module specified by `module`.
2. The module's default export is called with the `HookInput` object.
3. The return value becomes the handler output.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `module` | string | Path to a `.js` or `.ts` file with a default export function |

### Default Timeout

5000ms. Override with the `timeout` field.

### Example Configuration

```yaml
handlers:
  PreToolUse:
    - id: context-injector
      type: inline
      module: ~/.clooks/hooks/context.js
      filter: "Write|Edit"
```

### Example Module

```typescript
// ~/.clooks/hooks/context.ts
import type { HookInput } from '@mauribadnights/clooks';

export default async function(input: HookInput) {
  const toolName = input.tool_name ?? 'unknown';
  const cwd = input.cwd;

  // Return value becomes handler output
  return {
    additionalContext: `Tool ${toolName} executing in ${cwd}`
  };
}
```

> **Note:** The module must have a default export that is a function. If the export is missing or not a function, the handler fails with an error message identifying the module.

## LLM Handlers

LLM handlers run AI-powered analysis with prompt templates. They support two backends: the Anthropic Messages API (`api`, default) and Claude Code CLI spawn (`claude-code`).

### How They Work

1. The handler's `prompt` template is rendered by replacing `$VARIABLES` with actual values.
2. **API backend:** The rendered prompt is sent to the Anthropic API using the specified `model`.
3. **Claude Code backend:** The rendered prompt is passed to `claude -p`, optionally with `--agent` and `--model`.
4. The response text is returned as `{"additionalContext": "..."}`.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | Prompt template with `$VARIABLE` interpolation |
| `model` | string | `claude-haiku-4-5`, `claude-sonnet-4-6`, or `claude-opus-4-6`. Required for `api` backend, optional for `claude-code`. |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `api` | `api` (Anthropic API) or `claude-code` (CLI spawn) |
| `llmAgent` | string | — | Agent name for `claude-code` backend (`--agent` flag) |
| `maxTokens` | number | 1024 | Maximum tokens in the response |
| `temperature` | number | 1.0 | Sampling temperature |
| `batchGroup` | string | — | Group ID for batching into one API call (`api` backend only) |

### Default Timeout

30000ms. Override with the `timeout` field.

### Prompt Variables

| Variable | Source |
|----------|--------|
| `$TRANSCRIPT` | Session transcript (requires `transcript` in prefetch) |
| `$GIT_STATUS` | `git status --porcelain` (requires `git_status` in prefetch) |
| `$GIT_DIFF` | `git diff --stat` (requires `git_diff` in prefetch) |
| `$ARGUMENTS` | JSON-serialized `tool_input` (PreToolUse/PostToolUse) |
| `$TOOL_NAME` | Tool name (PreToolUse/PostToolUse) |
| `$PROMPT` | User prompt text (UserPromptSubmit) |
| `$CWD` | Current working directory |

### Example Configuration

```yaml
prefetch:
  - git_status

handlers:
  PreToolUse:
    # API backend (default) — fast, supports batching and cost tracking
    - id: code-reviewer
      type: llm
      model: claude-haiku-4-5
      prompt: |
        Review this tool call for potential issues.
        Tool: $TOOL_NAME
        Arguments: $ARGUMENTS
        Git status: $GIT_STATUS

        If there is a problem, explain it briefly. Otherwise say "Looks good."
      filter: "Write|Edit"
      maxTokens: 256

    # Claude Code backend — supports agents, no API key needed
    - id: agent-review
      type: llm
      backend: claude-code
      llmAgent: security-reviewer
      prompt: "Audit this tool call for security issues: $TOOL_NAME $ARGUMENTS"
      filter: "Bash|Write"
```

See [LLM Handlers](llm-handlers.md) for backends, batching, cost tracking, and advanced usage.

## Handler Output Format

Handlers communicate back to Claude Code through their output. There are two primary output shapes.

### Adding Context

Return an `additionalContext` string to inject information into Claude's context window:

```json
{
  "additionalContext": "Information to inject into Claude's context"
}
```

This is the most common output. Claude sees this text as additional context when deciding its next action.

### Blocking a Tool (PreToolUse only)

PreToolUse handlers can block a tool call by returning a `decision` of `"block"`:

```json
{
  "decision": "block",
  "reason": "This operation is not allowed because..."
}
```

When a handler blocks a tool, Claude receives the reason and must find an alternative approach. Multiple handlers can run for the same event -- if any handler blocks, the tool is blocked.

### No Output

Returning nothing (empty stdout for scripts, `undefined` for inline) is valid. The handler is recorded as successful with no output.

## Auto-Disable

Handlers that fail repeatedly are automatically disabled to prevent cascading problems:

- After **3 consecutive failures**, the handler is marked as disabled.
- Disabled handlers are skipped on subsequent invocations (logged as auto-disabled).
- State is tracked per handler ID in memory.

To re-enable a disabled handler:

- **Edit the manifest** -- any manifest reload resets state for changed handlers.
- **Use `sessionIsolation: true`** -- state resets automatically on every `SessionStart` event.
- **Restart the daemon** -- `clooks restart` clears all in-memory state.

Check current handler status with `clooks stats`, which shows error counts and disabled state per handler.

---

[Home](../index.md) | [Prev: Manifest](manifest.md) | [Next: LLM Handlers](llm-handlers.md)
