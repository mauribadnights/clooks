# Security

clooks uses a local-only security model with Bearer token authentication, rate limiting, and constant-time token comparison.

## Authentication

### Token Generation

```bash
clooks init           # Generates token on first setup
clooks rotate-token   # Rotate to a new token
```

Tokens are 32 hex characters (16 bytes of cryptographic random).

### Token Storage

- Stored in `~/.clooks/manifest.yaml` under `settings.authToken`
- Referenced in `~/.claude/settings.json` HTTP hook headers

### How Auth Works

1. Claude Code sends an HTTP request with `Authorization: Bearer <token>` header
2. clooks validates using constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks
3. If no token is configured, auth is disabled (all requests accepted)

### Public Endpoints

`GET /health` is always public (no auth required). It is used for daemon discovery and PID recovery.

## Rate Limiting

Auth failures are rate-limited:

- **Threshold:** 10 failures per 60 seconds per source IP
- **Response:** 429 Too Many Requests with `Retry-After` header
- **Cleanup:** Expired entries pruned every 60 seconds
- **Storage:** In-memory (cleared on daemon restart)

## Network Security

- Binds to `localhost` only — not accessible from the network
- No TLS (localhost-only; no sensitive data in transit on loopback)
- Port 7890 by default (configurable)

## Token Rotation

```bash
clooks rotate-token
```

This command:

1. Generates a new random token
2. Updates `manifest.yaml` (preserves YAML comments)
3. Updates all HTTP hook headers in `settings.json`
4. Daemon hot-reloads the new token automatically

> **Note:** No daemon restart is required. The file watcher detects the manifest change and swaps the token in-place.

## File Permissions

All config files are in `~/.clooks/`, protected by standard Unix user permissions. The auth token is stored in plaintext in the manifest; protect the file accordingly.

## Plugin Security

- Plugins run with the same permissions as the daemon
- Review plugin code before installing (`clooks add` copies the directory)
- Plugin handlers are namespaced but execute in the same process
- No sandboxing — trust plugins the same way you trust any npm package

> **Note:** There is no privilege separation between plugins and the core daemon. A malicious plugin has full access to everything the daemon process can reach.

---

Nav: [Home](../index.md) | [Prev: Monitoring](monitoring.md) | [Next: Troubleshooting](troubleshooting.md)
