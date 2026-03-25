# System Service

## Overview

clooks can install itself as a system service that starts automatically on login and restarts on crash. Supports macOS (launchd), Linux (systemd), and Windows (Task Scheduler).

## Install

```bash
clooks service install
```

This is also done automatically by `clooks init` and `clooks migrate`.

## Uninstall

```bash
clooks service uninstall
```

## Check Status

```bash
clooks service status    # running | stopped | not-installed
clooks status            # Full daemon status including service
```

## Platform Details

### macOS (launchd)

- Plist: `~/Library/LaunchAgents/com.clooks.daemon.plist`
- Runs `clooks start --foreground`
- Auto-restarts on crash
- Survives sleep/wake cycles
- Commands used: `launchctl load/unload`

### Linux (systemd)

- Service file: `~/.config/systemd/user/clooks.service`
- User service (no root required)
- Auto-restarts with 3-second delay
- Commands: `systemctl --user enable/start/stop`

### Windows (Task Scheduler)

- Task name: `clooks`
- Created via `schtasks`
- Triggers on user login

## Daemon Resilience

- PID file at `~/.clooks/daemon.pid` tracks running process
- `clooks start` detects stale PIDs (e.g., after macOS sleep) and cleans up
- `/health` endpoint used for orphan recovery when PID file is missing
- `clooks ensure-running` (called by SessionStart hook) auto-starts if needed

> **Note:** On macOS, launchd handles restart-on-crash natively. The PID staleness check is a secondary safety net for edge cases like hard reboots or force-kills that leave a stale PID file behind.

---

[Home](../index.md) | [Prev: Short-Circuit](short-circuit.md) | [Next: Using Plugins](../plugins/using-plugins.md)
