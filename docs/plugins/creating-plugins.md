# Creating Plugins

## Overview

A clooks plugin is a directory containing a `clooks-plugin.yaml` manifest and any handler scripts/modules it references. Plugins let you distribute reusable hook configurations.

## Plugin Structure

```
my-plugin/
├── clooks-plugin.yaml      # Required: plugin manifest
├── README.md               # Recommended: usage docs
├── handlers/
│   ├── guard.js            # Handler scripts
│   └── analyzer.js
└── assets/                 # Optional: supporting files
    └── rules.json
```

## Plugin Manifest (clooks-plugin.yaml)

```yaml
name: my-plugin                    # Required: unique name
version: 1.0.0                    # Required: semver
description: Security hooks suite  # Optional
author: Your Name                  # Optional

handlers:
  PreToolUse:
    - id: bash-guard
      type: inline
      module: $PLUGIN_DIR/handlers/guard.js
      filter: "Bash|Execute"
      timeout: 3000

    - id: write-guard
      type: inline
      module: $PLUGIN_DIR/handlers/guard.js
      filter: "Write|Edit"

  PostToolUse:
    - id: usage-tracker
      type: script
      command: "node $PLUGIN_DIR/handlers/tracker.js"
      async: true

prefetch:
  - git_status

extras:
  skills:
    - security-audit
    - permission-guard
  agents:
    - security-reviewer
  readme: README.md
```

## The $PLUGIN_DIR Variable

Use `$PLUGIN_DIR` in `command` and `module` paths. When the plugin is installed, clooks resolves this to the absolute installation path (e.g., `~/.clooks/plugins/my-plugin/`).

> **Note:** Always use `$PLUGIN_DIR` instead of relative paths. Plugins are copied to the plugins directory on install, so relative paths from the source won't work.

## Required Fields

- `name` (string) — Unique plugin identifier. Used as namespace prefix for handler IDs.
- `version` (string) — Semantic version.

## Optional Fields

- `description` (string) — Shown in `clooks plugins` output
- `author` (string) — Plugin author
- `handlers` — Same format as user manifest handlers (all 3 types supported)
- `prefetch` — Keys to pre-fetch (merged with user manifest)
- `extras` — Freeform metadata:
  - `skills` (string[]) — Skill names the plugin provides
  - `agents` (string[]) — Agent names the plugin registers
  - `readme` (string) — Relative path to README (resolved to absolute on install)
  - Any other keys (extensible)

## Handler Namespacing

When installed, handler IDs become `plugin-name/handler-id`:

- Source: `id: bash-guard` → Installed: `my-plugin/bash-guard`
- Dependencies within the same plugin are auto-namespaced
- Cross-plugin deps use full namespaced ID: `depends: [other-plugin/handler-id]`

## Writing Inline Handlers for Plugins

```javascript
// handlers/guard.js
export default async function(input) {
  const { tool_name, tool_input } = input;

  if (tool_name === 'Bash' && tool_input?.command?.includes('rm -rf')) {
    return {
      decision: 'block',
      reason: 'Destructive command blocked by security plugin'
    };
  }

  return { additionalContext: 'Security check passed' };
}
```

## Writing Script Handlers for Plugins

```javascript
#!/usr/bin/env node
// handlers/tracker.js
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));

// Do tracking work...
const result = { additionalContext: `Tracked ${input.hook_event_name}` };
console.log(JSON.stringify(result));
```

## Testing Your Plugin

Before publishing:

1. Validate manifest: install locally with `clooks add ./my-plugin`
2. Check handlers load: `clooks plugins` should show your plugin
3. Test execution: trigger the relevant hook events
4. Check metrics: `clooks stats` shows handler execution data
5. Remove: `clooks remove my-plugin`

## Distribution

Currently plugins are installed from local directories:

```bash
clooks add /path/to/my-plugin
```

Share plugins as git repos or tarballs. Users clone/extract and `clooks add` the directory.

---

[Home](../index.md) | [Prev: Using Plugins](using-plugins.md) | [Next: CC Plugin Import](cc-plugin-import.md)
