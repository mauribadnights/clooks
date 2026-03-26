# Quickstart

Get your first clooks handler running in 5 minutes.

## 1. Install

```bash
npm install -g @mauribadnights/clooks
```

## 2. Initialize

```bash
clooks init
```

## 3. Start the daemon

```bash
clooks start
```

## 4. Check status

```bash
clooks status
```

You should see the daemon running on port 7890 with zero handlers loaded.

## 5. Add a handler

Open `~/.clooks/manifest.yaml` in your editor and add a handler under `PreToolUse`:

```yaml
handlers:
  PreToolUse:
    - id: bash-logger
      type: script
      command: "echo '{\"additionalContext\": \"Reviewed by clooks\"}'"
      filter: "Bash"
```

This handler fires before every Bash tool call and injects a note into Claude's context.

## 6. Hot-reload

Save the file. The daemon watches `manifest.yaml` and hot-reloads on change -- no restart needed.

You can confirm the reload in the daemon log:

```bash
tail -1 ~/.clooks/daemon.log
```

## 7. Try it

Open Claude Code and run any Bash command. The handler fires automatically. You will see "Reviewed by clooks" appear in the context.

## 8. Check metrics

```bash
clooks stats
```

This launches an interactive TUI showing execution counts, latency, and errors per event. Use `-t` for plain text output.

## What to try next

- Add a `filter` to scope handlers to specific tools
- Try an `llm` handler for AI-powered review (use `backend: claude-code` to skip API key setup)
- Run `clooks migrate` to convert existing command hooks

---

[Home](../index.md) | Prev: [Installation](installation.md) | Next: [Migration](migration.md)
