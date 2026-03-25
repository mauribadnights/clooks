# Migration

Migrate existing Claude Code command hooks to clooks in one command.

## What migration does

`clooks migrate` converts your `settings.json` command hooks into clooks HTTP hooks backed by the daemon, with equivalent handlers defined in the manifest. Your original command hooks continue to work -- they just route through clooks instead of spawning processes directly.

## Run the migration

```bash
clooks migrate
```

## Step-by-step breakdown

When you run `clooks migrate`, the following happens in order:

1. **Reads settings** -- Loads `~/.claude/settings.json` (or `settings.local.json` if present).
2. **Backs up original** -- Saves a copy to `~/.clooks/settings.backup.json`.
3. **Extracts command hooks** -- Parses all command hooks from the settings file and creates corresponding handlers in `~/.clooks/manifest.yaml`.
4. **Rewrites settings** -- Replaces command hooks with HTTP hooks pointing to `http://localhost:7890`.
5. **Adds ensure-running** -- Injects a `clooks ensure-running` command into `SessionStart` so the daemon auto-starts when Claude Code launches.
6. **Imports plugin hooks** -- Detects and imports any Claude Code plugin hooks into the manifest.
7. **Installs system service** -- Sets up launchd (macOS) or systemd (Linux) for auto-start on login and crash recovery.

## Verify

```bash
clooks doctor
```

A passing report confirms that the daemon is running, the manifest is valid, and `settings.json` points to clooks.

## Rollback

If anything goes wrong, restore your original settings:

```bash
clooks restore
```

This replaces `settings.json` with the backup created during migration. Your command hooks return to their original state.

## Keeping settings in sync

After migration, if you add new handlers to the manifest, run:

```bash
clooks sync
```

This updates `settings.json` to include HTTP hook entries for any new events in your manifest. You do not need to edit `settings.json` manually.

> **Note:** `clooks sync` only adds missing entries. It never removes or modifies existing hooks in `settings.json`.

## Summary

| Command | What it does |
|---------|-------------|
| `clooks migrate` | Full migration: backup, convert, rewrite, install service |
| `clooks restore` | Rollback to pre-migration settings.json |
| `clooks sync` | Add missing HTTP hook entries for new manifest events |
| `clooks doctor` | Verify everything is wired up correctly |

---

[Home](../index.md) | Prev: [Quickstart](quickstart.md) | Next: [Manifest Guide](../guides/manifest.md)
