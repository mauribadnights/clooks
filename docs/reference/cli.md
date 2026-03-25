# CLI Reference

clooks provides a single `clooks` command with subcommands for daemon management, configuration, plugins, observability, and system service control.

All commands read configuration from `~/.clooks/manifest.yaml` unless otherwise noted.

---

## Daemon

### `clooks start`

Start the daemon process.

| Flag | Description |
|------|-------------|
| `-f, --foreground` | Run in foreground instead of detaching |
| `--no-watch` | Disable manifest file watching |

```bash
clooks start           # Background (detached)
clooks start -f        # Foreground (for debugging)
clooks start --no-watch  # Background, no manifest hot-reload
```

> **Note:** When started in background mode, the daemon writes its PID to `~/.clooks/daemon.pid` and logs to `~/.clooks/daemon.log`.

### `clooks stop`

Stop the running daemon. Tries the PID file first, then falls back to the health endpoint for orphan recovery.

```bash
clooks stop
```

### `clooks status`

Show daemon status including: running/stopped, PID, port, uptime, handler count, plugin count, and service status.

```bash
clooks status
```

### `clooks ensure-running`

Start the daemon if it is not already running. This is a no-op if the daemon is healthy.

Used internally by the SessionStart hook to guarantee the daemon is available before a Claude Code session begins.

```bash
clooks ensure-running
```

---

## Configuration

### `clooks init`

Create default configuration. Generates the `~/.clooks/` directory tree, a starter `manifest.yaml`, an auth token, and installs the clooks agent and system service.

```bash
clooks init
```

> **Note:** Safe to run multiple times. Existing configuration is not overwritten.

### `clooks migrate`

Migrate existing Claude Code command hooks to clooks HTTP hooks. Backs up `settings.json`, creates manifest entries from existing hooks, and rewrites the hooks to HTTP POST calls.

```bash
clooks migrate
```

The original settings are saved to `~/.clooks/settings.backup.json` and can be restored with `clooks restore`.

### `clooks restore`

Restore the original `settings.json` from the backup created during `clooks migrate`.

```bash
clooks restore
```

### `clooks sync`

Sync `settings.json` with the manifest. Ensures HTTP hook entries exist in Claude Code settings for every event that has handlers defined in the manifest.

```bash
clooks sync
```

### `clooks rotate-token`

Generate a new auth token. Updates both `manifest.yaml` and `settings.json` with the new token.

```bash
clooks rotate-token
```

### `clooks update`

Update clooks to the latest npm version. Restarts the daemon automatically if it was running.

```bash
clooks update
```

---

## Plugins

### `clooks add <path>`

Install a plugin from a local directory. Validates the plugin manifest, copies files to the plugins directory, and syncs settings.

```bash
clooks add ./my-plugin
clooks add ~/plugins/security-suite
```

### `clooks remove <name>`

Uninstall a plugin by name.

```bash
clooks remove security-suite
```

### `clooks plugins`

List installed plugins with name, version, handler count, skills, and agents.

```bash
clooks plugins
```

### `clooks import-plugins`

Discover and import hooks from Claude Code plugins located in `~/.claude/plugins/`.

```bash
clooks import-plugins
```

---

## Observability

### `clooks stats`

Show hook execution metrics. Displays an interactive TUI by default.

| Flag | Description |
|------|-------------|
| `-t, --text` | Plain text output (auto-detected when piped) |

```bash
clooks stats            # Interactive TUI
clooks stats -t         # Plain text output
clooks stats | head     # Auto-selects text mode when piped
```

### `clooks costs`

Show LLM cost breakdown by model and handler.

```bash
clooks costs
```

### `clooks doctor`

Run diagnostic health checks across config, manifest, daemon, port, settings, plugins, service, and agent.

```bash
clooks doctor
```

Each check reports `ok`, `warn`, or `error` with a human-readable message.

---

## System Service

### `clooks service install`

Install clooks as a system service using the platform-native mechanism (launchd on macOS, systemd on Linux, Task Scheduler on Windows). Enables auto-start on login and auto-restart on crash.

```bash
clooks service install
```

### `clooks service uninstall`

Remove the system service.

```bash
clooks service uninstall
```

### `clooks service status`

Show service status: `running`, `stopped`, or `not-installed`.

```bash
clooks service status
```

---

[Home](../index.md) | [Prev: CC Plugin Import](../plugins/cc-plugin-import.md) | [Next: Hook Events](hook-events.md)
