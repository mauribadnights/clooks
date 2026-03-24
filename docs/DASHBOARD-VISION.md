# Dashboard Vision — Visual Hook Manager

> **Status:** Future feature idea — NOT to be implemented now.
> **Target version:** v0.4 or later, after the plugin ecosystem (v0.3) is in place.

## Overview

A web-based dashboard (accessible at `localhost:7890/dashboard` or similar) that provides a graphical interface for creating, configuring, and monitoring hooks — no YAML editing required.

## Hook Builder UI

The core feature: a visual hook creator.

### Event Selection

- Dropdown to select the hook event: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, etc.
- Visual explanation of when each event fires and how often

### Handler Type

- Dropdown: **Script**, **Inline**, **LLM** (v0.2+)
- Each type shows its relevant configuration fields dynamically

### Configuration

- **Script handlers**: text field for the command, timeout slider, enable/disable toggle
- **LLM handlers**: model selector dropdown (Haiku/Sonnet/Opus), prompt textarea with syntax highlighting, temperature slider, max tokens input, batch group selector
- **Inline handlers**: file picker for the JS module

### Pre-built Actions (Quick Hooks)

Predefined hook templates users can enable with one click:

| Quick Hook | Description |
|---|---|
| Auto-commit on Stop | Commits staged changes when Claude stops |
| Dangerous command guard | Blocks `rm -rf`, `git push --force` on PreToolUse |
| Session logger | Records session start/stop times |
| Cost tracker | Monitors LLM usage across hooks |
| Context warning | Alerts when context window is running low |
| Custom | Blank template to build your own |

### Filter Configuration

- Visual filter builder: keyword chips, include/exclude toggle
- Preview: shows sample inputs and whether the filter would match

## Monitoring Dashboard

- Real-time view of hook fires, handler execution times, errors
- Per-handler graphs (fires over time, latency distribution)
- LLM cost tracker with daily/weekly charts
- Health status of all handlers (green/yellow/red)

## Manifest Sync

- Dashboard reads and writes `~/.clooks/manifest.yaml`
- Changes are live-reloaded by the daemon (no restart needed)
- Shows diff of pending changes before applying
- Version history of manifest changes

## Technology

- Served by the clooks daemon itself (add routes to existing HTTP server)
- Frontend: lightweight — could be vanilla HTML/CSS/JS or a small framework like Preact
- No build step for the dashboard — serve static files from a `dashboard/` directory
