# LLM Handlers

LLM handlers call the Anthropic Messages API directly from the manifest, with prompt templates, automatic batching, and cost tracking. This guide covers advanced usage beyond the basics in [Handlers](handlers.md).

## Basics

LLM handlers require an Anthropic API key. Provide it in one of two ways:

1. **Environment variable:** `ANTHROPIC_API_KEY=sk-ant-...`
2. **Manifest setting:** `settings.anthropicApiKey: sk-ant-...`

The Anthropic SDK is lazy-loaded on the first LLM handler invocation. If the SDK is not installed, the handler fails with an actionable error message.

### Supported Models

| Model | Best For |
|-------|----------|
| `claude-haiku-4-5` | Fast, cheap checks (guards, simple reviews) |
| `claude-sonnet-4-6` | Balanced analysis (code review, context synthesis) |
| `claude-opus-4-6` | Deep reasoning (security audits, architecture review) |

## Prompt Templates

Prompts support `$VARIABLE` interpolation. Variables are replaced with actual values before the API call.

| Variable | Requires Prefetch | Source |
|----------|-------------------|--------|
| `$TRANSCRIPT` | Yes (`transcript`) | Session transcript, last 50KB |
| `$GIT_STATUS` | Yes (`git_status`) | `git status --porcelain` output |
| `$GIT_DIFF` | Yes (`git_diff`) | `git diff --stat` output, max 20KB |
| `$ARGUMENTS` | No | JSON-serialized `tool_input` (PreToolUse/PostToolUse) |
| `$TOOL_NAME` | No | Tool name string (PreToolUse/PostToolUse) |
| `$PROMPT` | No | User prompt text (UserPromptSubmit) |
| `$CWD` | No | Current working directory |

Variables that require prefetch will resolve to an empty string if the corresponding prefetch key is not listed in the manifest's `prefetch` array.

```yaml
prefetch:
  - transcript
  - git_status

handlers:
  PreToolUse:
    - id: reviewer
      type: llm
      model: claude-haiku-4-5
      prompt: |
        You are reviewing a tool call in a Claude Code session.

        Tool: $TOOL_NAME
        Arguments: $ARGUMENTS
        Working directory: $CWD
        Git status: $GIT_STATUS

        Flag any issues. Be concise.
```

## Batching

Handlers with the same `batchGroup` value that fire on the same event are combined into a single API call. This reduces latency and cost when multiple LLM handlers need to analyze the same context.

### How It Works

1. Handlers sharing a `batchGroup` are collected.
2. Their prompts are rendered individually, then combined into a structured multi-task prompt.
3. A single API call is made. The model is instructed to return a JSON object keyed by handler ID.
4. The response is parsed and each handler receives its portion of the result.
5. Token usage and cost are split evenly across group members.

### Scoping

Batch groups are scoped by `session_id`. Two different Claude Code sessions firing the same batch group at the same time will produce separate API calls. There is no cross-session contamination.

### Edge Cases

- **Single-handler groups:** If a batch group contains only one handler, it falls through to individual execution (no batching overhead).
- **Mixed models:** If handlers in a group specify different models, the first handler's model is used and a warning is logged.
- **JSON parse failure:** If the batched response is not valid JSON, all handlers in the group receive the raw text as `additionalContext`.

### Example

```yaml
handlers:
  PreToolUse:
    - id: security-check
      type: llm
      model: claude-haiku-4-5
      prompt: |
        Check this tool call for security issues:
        Tool: $TOOL_NAME
        Arguments: $ARGUMENTS
      batchGroup: pre-tool-review
      filter: "Write|Bash"

    - id: style-check
      type: llm
      model: claude-haiku-4-5
      prompt: |
        Check if this tool call follows project conventions:
        Tool: $TOOL_NAME
        Arguments: $ARGUMENTS
      batchGroup: pre-tool-review
      filter: "Write|Bash"
```

Both handlers fire on the same `PreToolUse` event with the same `batchGroup`. clooks combines them into one API call, halving latency and cost compared to two separate calls.

## Cost Tracking

All LLM handler invocations are logged to `~/.clooks/costs.jsonl`. Each entry records the timestamp, event, handler ID, model, token usage, cost in USD, and whether the call was batched.

View cost data with:

```bash
clooks costs
```

### Pricing

Pricing per million tokens (as of March 2026):

| Model | Input | Output |
|-------|-------|--------|
| `claude-haiku-4-5` | $0.80 | $4.00 |
| `claude-sonnet-4-6` | $3.00 | $15.00 |
| `claude-opus-4-6` | $15.00 | $75.00 |

For batched calls, the total token cost is split evenly across all handlers in the group.

## Best Practices

**Use Haiku for simple checks.** Guards, keyword detection, and light reviews run well on Haiku at a fraction of the cost. Reserve Sonnet and Opus for tasks that require deeper reasoning.

**Use batchGroup to combine related analyses.** If two handlers analyze the same tool call from different angles, batching them saves an API round-trip and reduces total tokens (the shared context is sent once).

**Set maxTokens conservatively.** Most handler responses are short. Setting `maxTokens: 256` or `maxTokens: 512` prevents runaway token usage on verbose responses.

**Use filter to avoid unnecessary API calls.** An LLM handler without a filter fires on every matching event. Adding `filter: "Write|Edit"` ensures the API is only called when relevant tools are invoked.

**Prefer prefetch over inline context.** If your prompt needs git status or the transcript, add the key to `prefetch` rather than running shell commands in a script handler. Prefetched data is fetched once and shared across all handlers.

---

[Home](../index.md) | [Prev: Handlers](handlers.md) | [Next: Filtering](filtering.md)
