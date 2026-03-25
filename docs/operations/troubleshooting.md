# Troubleshooting

Common issues and their solutions. When in doubt, start with the diagnostic tool.

## Diagnostic Tool

Always start here:

```bash
clooks doctor
```

This checks:

- Config directory exists and is readable
- Manifest is valid YAML
- Daemon process is running
- Port is reachable
- Script commands are in PATH
- `settings.json` hooks are configured
- PID file is fresh and matches a running process
- Auth token is consistent between manifest and settings
- Plugin health (manifests valid, handlers resolvable)
- System service status
- Agent installation

## Common Issues

### Daemon won't start

**Symptom:** `clooks start` exits without starting.

**Checks:**

1. **Port already in use:** `lsof -i :7890`
2. **Stale PID file:** `cat ~/.clooks/daemon.pid` — if the process does not exist, delete the file
3. **Manifest errors:** `clooks doctor` will report YAML parsing failures
4. **Check logs:** `tail ~/.clooks/daemon.log`

### Hooks not firing

**Symptom:** Claude Code runs but hooks do not execute.

**Checks:**

1. **Daemon running:** `clooks status`
2. **Settings.json has HTTP hooks:** `clooks doctor` checks this
3. **Missing sync:** run `clooks sync` to add HTTP hook entries
4. **Handler filtered:** check `filter`, `agent`, and `project` fields in the manifest
5. **Handler auto-disabled:** `clooks stats` shows error counts
6. **Check daemon log:** `tail ~/.clooks/daemon.log`

### Auth failures (401)

**Symptom:** Daemon returns 401 Unauthorized.

**Checks:**

1. **Token mismatch** between manifest and settings.json: run `clooks rotate-token` to reset both
2. **Rate limited (429):** wait 60 seconds or restart the daemon
3. **Missing header:** run `clooks sync` to ensure headers are set

### Handler auto-disabled

**Symptom:** Handler stops firing after working initially.

**Cause:** 3 consecutive failures trigger auto-disable.

**Fix:**

1. Check `clooks stats` for error details
2. Fix the underlying handler error
3. Save the manifest to trigger a reload (resets state)
4. Or restart the daemon: `clooks stop && clooks start`

### macOS sleep/wake issues

**Symptom:** Daemon stops responding after laptop sleep.

**Cause:** macOS may terminate background processes during sleep.

**Fix:**

1. **System service auto-restarts:** `clooks service install`
2. **SessionStart hook auto-recovers:** `clooks ensure-running` runs on each new session
3. **Stale PID cleanup:** `clooks start` detects stale PIDs and cleans up

### Plugin not loading

**Symptom:** `clooks plugins` shows the plugin but handlers do not fire.

**Checks:**

1. **Plugin manifest valid:** remove and re-add (`clooks remove name && clooks add path`)
2. **`$PLUGIN_DIR` resolved correctly:** check installed path in `clooks plugins`
3. **Handler module exists** at the resolved path
4. **Settings.json synced:** run `clooks sync`

## Log Locations

| Log | Path | Content |
|-----|------|---------|
| Daemon | `~/.clooks/daemon.log` | Server events, errors |
| Metrics | `~/.clooks/metrics.jsonl` | Handler execution data |
| Costs | `~/.clooks/costs.jsonl` | LLM token usage |

## Reset Everything

Nuclear option — start completely fresh:

```bash
clooks stop
clooks restore              # Restore original settings.json
rm -rf ~/.clooks             # Remove all clooks config
clooks init                  # Start fresh
clooks start
```

> **Note:** This destroys all metrics, cost history, plugins, and custom configuration. Use only as a last resort.

---

Nav: [Home](../index.md) | [Prev: Security](security.md) | [Next: Architecture](architecture.md)
