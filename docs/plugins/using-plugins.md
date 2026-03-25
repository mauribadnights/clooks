# Using Plugins

## Overview

clooks plugins are self-contained directories that ship handler definitions in a `clooks-plugin.yaml` file. Install them locally to extend your hook pipeline without editing your manifest.

## Installing a Plugin

```bash
clooks add ./path/to/plugin-directory
```

What happens:

1. Validates `clooks-plugin.yaml` in the source directory
2. Copies the entire directory to `~/.clooks/plugins/{name}/`
3. Resolves `$PLUGIN_DIR` variables in handler commands to the installed path
4. Updates plugin registry (`~/.clooks/plugins/installed.json`)
5. Syncs settings.json with any new HTTP hook entries

## Listing Plugins

```bash
clooks plugins
```

Shows: name, version, handler count, skills (if declared), agents (if declared).

## Removing a Plugin

```bash
clooks remove plugin-name
```

Removes the plugin directory and registry entry. Daemon hot-reloads to drop the handlers.

## How Plugins Merge

- Plugin handlers are namespaced: `plugin-name/handler-id` (prevents ID collisions)
- Prefetch keys are merged (union of user + all plugins)
- Settings come from user manifest only (plugins cannot override port, auth, etc.)
- Handlers from all plugins + user manifest execute together, respecting dependencies

## Plugin Registry

Installed plugins tracked at `~/.clooks/plugins/installed.json`:

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

[Home](../index.md) | [Prev: System Service](../guides/system-service.md) | [Next: Creating Plugins](creating-plugins.md)
