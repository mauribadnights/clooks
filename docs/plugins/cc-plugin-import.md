# CC Plugin Import

## Overview

If you have Claude Code plugins installed (in `~/.claude/plugins/`), clooks can discover their hook definitions and convert them to clooks handlers.

## Import Command

```bash
clooks import-plugins
```

## What It Does

1. Scans `~/.claude/plugins/cache/` for installed CC plugins
2. Reads each plugin's `plugin.json` and `hooks/hooks.json`
3. Converts command-type hooks to clooks ScriptHandlerConfig entries
4. Optionally reads `clooks.yaml` enhancement overlay from each plugin
5. Removes previously imported handlers (re-import is idempotent)
6. Merges new handlers into manifest.yaml
7. Syncs settings.json

## Claude Code Hook Types

Only `command` type CC hooks are imported. Other types (http, prompt, agent) are skipped.

## clooks.yaml Enhancement Overlay

CC plugins can include an optional `clooks.yaml` file to enhance their hooks when imported into clooks:

```yaml
handler-name:
  filter: "Bash|Write"          # Add keyword filtering
  project: "*/my-project/*"     # Scope to specific projects
  agent: "builder"              # Scope to specific agents
  async: true                   # Make fire-and-forget
  depends: [other-handler]      # Add dependencies
  sessionIsolation: true        # Reset on session start
  batchGroup: analysis          # Group for LLM batching
  type: llm                     # Convert to LLM handler
  model: claude-haiku-4-5       # LLM model
  prompt: "Analyze: $ARGUMENTS" # LLM prompt
  maxTokens: 512
  temperature: 0.5
```

This lets CC plugin authors provide clooks-specific enhancements without requiring clooks as a dependency.

## Automatic Import

`clooks migrate` automatically runs plugin import as part of the migration process.

---

[Home](../index.md) | [Prev: Creating Plugins](creating-plugins.md) | [Next: CLI Reference](../reference/cli.md)
