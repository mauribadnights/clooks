# Installation

## Prerequisites

- **Node.js 18+** -- check with `node --version`
- **Claude Code** -- installed and working (`claude --version`)

## Install

```bash
npm install -g @mauribadnights/clooks
```

## Initialize

```bash
clooks init
```

This creates your configuration directory and everything clooks needs to run. No existing hooks are modified -- use `clooks migrate` for that (see [Migration](migration.md)).

## Verify

```bash
clooks doctor
```

Doctor runs health checks on the daemon, port, manifest, settings, and handler state. A passing report means clooks is ready.

## What `clooks init` creates

| Item | Path | Description |
|------|------|-------------|
| Manifest | `~/.clooks/manifest.yaml` | Handler definitions, settings, and prefetch config |
| Hooks directory | `~/.clooks/hooks/` | Built-in hook scripts |
| Auth token | Stored in manifest | Generated once and shown at init. Used to authenticate requests to the daemon. |
| System service | launchd (macOS) / systemd (Linux) | Auto-starts the daemon on login, restarts on crash |
| Expert agent | `~/.claude/agents/clooks.md` | Invoke with `claude --agent clooks` for clooks-specific help |

> **Note:** The auth token is displayed once during init. It is stored in your manifest under `settings.authToken`. If you lose it, run `clooks rotate-token` to generate a new one.

## Next steps

Start the daemon and add your first handler:

```bash
clooks start
```

---

[Home](../index.md) | Next: [Quickstart](quickstart.md)
