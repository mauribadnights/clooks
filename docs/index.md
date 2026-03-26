# clooks

clooks is a persistent hook runtime for Claude Code that eliminates process spawning overhead -- making hooks 112x faster.

## Why clooks?

- **Performance.** A single long-lived HTTP daemon replaces per-invocation process spawning. Hook latency drops from ~35ms to ~0.3ms.
- **LLM handlers.** Define AI-powered hooks with prompt templates, variable interpolation, and automatic batching -- no scripts required.
- **Plugin ecosystem.** Package and share reusable handler sets as plugins. Install with `clooks add`, namespace automatically.
- **Dependency resolution.** Declare `depends` between handlers. clooks resolves them into topological execution waves -- parallel where possible, sequential where required.

## Quick Navigation

```
docs/
├── Getting Started
│   ├── installation.md
│   ├── quickstart.md
│   └── migration.md
├── Guides
│   ├── manifest.md
│   ├── handlers.md
│   ├── llm-handlers.md
│   ├── filtering.md
│   ├── dependencies.md
│   ├── async-handlers.md
│   ├── short-circuit.md
│   └── system-service.md
├── Plugins
│   ├── using-plugins.md
│   ├── creating-plugins.md
│   └── cc-plugin-import.md
├── Reference
│   ├── cli.md
│   ├── hook-events.md
│   ├── http-api.md
│   ├── config-files.md
│   └── types.md
└── Operations
    ├── monitoring.md
    ├── security.md
    ├── troubleshooting.md
    └── architecture.md
```

### Getting Started

- [Installation](getting-started/installation.md) -- prerequisites, install, and init
- [Quickstart](getting-started/quickstart.md) -- first handler in 5 minutes
- [Migration](getting-started/migration.md) -- convert existing command hooks to clooks

### Guides

- [Manifest](guides/manifest.md) -- manifest.yaml structure and fields
- [Handlers](guides/handlers.md) -- script, inline, and LLM handler types
- [LLM Handlers](guides/llm-handlers.md) -- prompt templates, batching, cost tracking, Claude Code CLI backend
- [Filtering](guides/filtering.md) -- keyword-based handler filtering
- [Dependencies](guides/dependencies.md) -- topological execution waves
- [Async Handlers](guides/async-handlers.md) -- fire-and-forget execution
- [Short-Circuit](guides/short-circuit.md) -- deny caching and PostToolUse skipping
- [System Service](guides/system-service.md) -- launchd and systemd auto-start

### Plugins

- [Using Plugins](plugins/using-plugins.md) -- install, remove, and list plugins
- [Creating Plugins](plugins/creating-plugins.md) -- plugin manifest and packaging
- [CC Plugin Import](plugins/cc-plugin-import.md) -- importing Claude Code plugin hooks

### Reference

- [CLI](reference/cli.md) -- all commands and flags
- [Hook Events](reference/hook-events.md) -- event types and payloads
- [HTTP API](reference/http-api.md) -- daemon endpoints
- [Config Files](reference/config-files.md) -- paths, formats, defaults
- [Types](reference/types.md) -- TypeScript type definitions

### Operations

- [Monitoring](operations/monitoring.md) -- metrics, costs, and stats TUI
- [Security](operations/security.md) -- auth tokens and access control
- [Troubleshooting](operations/troubleshooting.md) -- common issues and clooks doctor
- [Architecture](operations/architecture.md) -- system design and internals

## Performance

| Metric | Command Hooks | clooks | Improvement |
|--------|---------------|--------|-------------|
| Single invocation | ~34.6ms | ~0.31ms | 112x faster |
| Full session (120 calls) | ~3,986ms | ~23ms | 99% time saved |
| 5 parallel handlers | ~424ms | ~96ms | 4.4x faster |

> **Note:** Benchmarked on Apple Silicon (M-series), Node v24.4.1. Run `npm run bench` to reproduce.

---

Next: [Installation](getting-started/installation.md)
