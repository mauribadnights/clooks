# PLAN: clooks v0.3.0 — Plugin Ecosystem + Deferred Fixes

## Intent (INVARIANT)
Add a plugin ecosystem so tools (GSD, Claude Quest, ALM) can ship `clooks-plugin.yaml` specs, be installed/removed via CLI, and have their handlers managed by the daemon. Add dependency resolution between handlers and short-circuit chains. Fix all deferred issues from v0.2.1 audit.

Success criteria:
- [ ] Plugin spec format defined and validated (clooks-plugin.yaml)
- [ ] `clooks add <path>` installs a plugin from local directory
- [ ] `clooks remove <name>` uninstalls a plugin
- [ ] `clooks plugins` lists installed plugins
- [ ] Daemon loads user manifest + all plugin manifests as composite
- [ ] Handler `depends` field works — executes in topological order
- [ ] PreToolUse deny short-circuits PostToolUse handlers
- [ ] LLM batch groups scoped by session_id (deferred fix)
- [ ] `clooks rotate-token` rotates auth token (deferred fix)
- [ ] Manifest reload diffs handlers and resets state (deferred fix)
- [ ] /health split into public/detail (deferred fix)
- [ ] Rate limiting on auth failures (deferred fix)
- [ ] All tests pass (old + new), no regressions

## Current Phase
Phase 1: Types + plugin spec format

## Method

### Phase 1: Types, plugin spec, constants [active]
- [ ] PluginManifest type (name, version, description, author, handlers, prefetch, depends)
- [ ] Plugin registry type (installed.json schema)
- [ ] HandlerConfig gets optional `depends: string[]` field
- [ ] Constants: PLUGINS_DIR, INSTALLED_PLUGINS_FILE
- [ ] Validate plugin manifest (same as user manifest + plugin-specific fields)

### Phase 2: Plugin loader + composite manifest [planned]
- [ ] loadPlugins(): reads all plugin dirs, parses clooks-plugin.yaml
- [ ] mergeManifests(): user manifest + plugin manifests → composite
- [ ] Handler ID namespacing: plugin handlers get `{pluginName}/{handlerId}` IDs
- [ ] Prefetch merging: union of user + plugin prefetch keys
- [ ] Server uses composite manifest instead of user manifest alone
- [ ] File watcher watches plugins/ dir too

### Phase 3: Install/uninstall CLI commands [planned]
- [ ] `clooks add <path>` — validate plugin.yaml, copy to plugins dir, register
- [ ] `clooks remove <name>` — remove from plugins dir and registry
- [ ] `clooks plugins` — list with name, version, handler count
- [ ] Settings.json gets HTTP hooks for plugin events automatically
- [ ] `$PLUGIN_DIR` variable in plugin commands resolved to actual path

### Phase 4: Dependency resolution [planned]
- [ ] Build directed acyclic graph from `depends` fields
- [ ] Detect cycles (throw error)
- [ ] Execute in topological order — parallel where no deps
- [ ] Pass previous handler output to dependent handlers via extended input
- [ ] Works across user + plugin handlers

### Phase 5: Short-circuit chains [planned]
- [ ] Server tracks denied PreToolUse calls (keyed by session_id + tool_name)
- [ ] PostToolUse checks deny cache before executing handlers
- [ ] Cache entries expire after 30s (prevent memory leak)
- [ ] Configurable per handler: `shortCircuit: true` (default true for PreToolUse)

### Phase 6: Deferred fixes [planned]
- [ ] LLM batch groups scoped by session_id
- [ ] `clooks rotate-token` command
- [ ] Manifest reload diffs handlers, resets session-isolated state for changed handlers
- [ ] /health (public, minimal) vs /health/detail (authenticated, full)
- [ ] Rate limiter: 10 failures per 60s from same source → 429

### Phase 7: Tests [planned]
- [ ] Plugin spec validation tests
- [ ] Plugin loader + merge tests
- [ ] Install/uninstall tests (temp dirs)
- [ ] Dependency resolution tests (DAG, cycles, topological order)
- [ ] Short-circuit chain tests
- [ ] Deferred fix tests (session-scoped batching, token rotation, rate limiting)
- [ ] All v0.2 tests still pass

### Phase 8: Version bump, README, publish [planned]
- [ ] Bump to 0.3.0
- [ ] Update README with plugin docs
- [ ] Update DEFERRED-FIXES.md (mark all as resolved)
- [ ] npm publish
- [ ] Git tag v0.3.0

## Decision Points
- After Phase 2: Does composite manifest work? Do existing features still work?
- After Phase 4: Does dependency resolution handle all edge cases?
- After Phase 7: All tests green?

## Decision Log
| Turn | Decision | Rationale |
|------|----------|-----------|
| 1 | Plugins are local directories, not npm packages (for v0.3) | Keep it simple. npm-based plugin install can come in v0.4. Local paths cover the main use case. |
| 1 | Handler IDs namespaced as pluginName/handlerId | Prevent ID collisions between plugins and user handlers. |
| 1 | Short-circuit uses in-memory cache with TTL | Simple, no persistence needed. Denied calls are transient by nature. |
| 1 | Rate limiter is per-source-IP, in-memory | Simple defense-in-depth. No persistence needed. |
