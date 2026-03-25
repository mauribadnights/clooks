# Monitoring and Observability

clooks provides built-in metrics, cost tracking, and structured logging for all handler execution.

## Metrics

clooks logs every handler execution to `~/.clooks/metrics.jsonl`. Each entry records:

- Event type, handler ID, duration, success/failure
- Session ID and agent type
- Token usage and cost for LLM handlers
- Whether the handler was filtered (skipped)

Metrics are held in a ring buffer of 1000 entries in memory and persisted to disk. The file is rotated at 5MB.

## Viewing Metrics

### Interactive Dashboard

```bash
clooks stats
```

Opens a TUI with paging and navigation showing:

- **Event summary** — fires, errors, average/min/max duration
- **Per-handler breakdown** — individual handler performance
- **Cost summary** — aggregate LLM handler spend (if applicable)
- **Totals** — total fires, spawns saved, error count

### Text Output

```bash
clooks stats -t          # Force plain text output
clooks stats | less      # Auto-detects piped output, switches to text
```

## Cost Tracking

LLM handler costs are logged to `~/.clooks/costs.jsonl`, rotated at 1MB.

```bash
clooks costs
```

Shows:

- Total spend and token count
- Breakdown by model (Haiku, Sonnet, Opus)
- Breakdown by handler (calls, tokens, cost)
- Estimated batching savings

### Pricing Reference (per million tokens)

| Model | Input | Output |
|-------|-------|--------|
| claude-haiku-4-5 | $0.80 | $4.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-opus-4-6 | $15.00 | $75.00 |

## Daemon Logs

```bash
tail -f ~/.clooks/daemon.log
```

Logs include:

- Server start/stop events
- Handler execution (with log level filtering)
- Manifest reloads
- Auth failures
- Errors and stack traces

Set the log level in your manifest:

```yaml
settings:
  logLevel: debug    # debug | info | warn | error
```

## Handler Auto-Disable

Handlers are automatically disabled after 3 consecutive failures. Check state via `clooks stats` — error counts and disabled status are visible in the per-handler breakdown.

To reset a disabled handler:

- **Edit and save the manifest** — triggers a reload, which resets handler state
- **Set `sessionIsolation: true`** on the handler — state resets on each new session
- **Restart the daemon** — `clooks stop && clooks start`

---

Nav: [Home](../index.md) | [Prev: Types Reference](../reference/types.md) | [Next: Security](security.md)
