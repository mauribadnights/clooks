import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncSettings } from '../src/sync.js';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Manifest } from '../src/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `clooks-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('syncSettings', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    settingsPath = join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const baseManifest: Manifest = {
    handlers: {
      PreToolUse: [
        { id: 'guard', type: 'script', command: 'echo ok', timeout: 3000 },
      ],
      Notification: [
        { id: 'notifier', type: 'script', command: 'echo notify', timeout: 3000 },
      ],
    },
    settings: { port: 7890 },
  };

  it('adds HTTP hooks for events with handlers', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    const added = syncSettings({ settingsPath, manifest: baseManifest });

    expect(added).toContain('PreToolUse');
    expect(added).toContain('Notification');
    expect(added).toContain('SessionStart'); // ensure-running always added

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Check PreToolUse has HTTP hook
    const preToolRules = settings.hooks.PreToolUse;
    expect(preToolRules).toBeDefined();
    const httpHooks = preToolRules.flatMap((r: { hooks: Array<{ type: string; url?: string }> }) =>
      r.hooks.filter((h: { type: string }) => h.type === 'http')
    );
    expect(httpHooks.length).toBe(1);
    expect(httpHooks[0].url).toBe('http://localhost:7890/hooks/PreToolUse');
  });

  it('does not duplicate existing HTTP hooks', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'http', url: 'http://localhost:7890/hooks/PreToolUse' },
            ],
          },
        ],
      },
    }, null, 2));

    const added = syncSettings({ settingsPath, manifest: baseManifest });

    // PreToolUse should NOT be in added (already exists)
    expect(added).not.toContain('PreToolUse');
    // Notification should be added
    expect(added).toContain('Notification');

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const preToolRules = settings.hooks.PreToolUse;
    const httpHooks = preToolRules.flatMap((r: { hooks: Array<{ type: string }> }) =>
      r.hooks.filter((h: { type: string }) => h.type === 'http')
    );
    expect(httpHooks.length).toBe(1); // Still only one
  });

  it('ensures SessionStart has ensure-running command hook', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    syncSettings({ settingsPath, manifest: baseManifest });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const sessionRules = settings.hooks.SessionStart;
    expect(sessionRules).toBeDefined();

    const cmdHooks = sessionRules.flatMap((r: { hooks: Array<{ type: string; command?: string }> }) =>
      r.hooks.filter((h: { type: string; command?: string }) => h.type === 'command' && h.command === 'clooks ensure-running')
    );
    expect(cmdHooks.length).toBe(1);
  });

  it('does not duplicate ensure-running if already present', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'clooks ensure-running' },
            ],
          },
        ],
      },
    }, null, 2));

    const manifest: Manifest = { handlers: {}, settings: { port: 7890 } };
    const added = syncSettings({ settingsPath, manifest });

    expect(added).toEqual([]); // Nothing to add

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const cmdHooks = settings.hooks.SessionStart.flatMap((r: { hooks: Array<{ type: string; command?: string }> }) =>
      r.hooks.filter((h: { type: string; command?: string }) => h.type === 'command' && h.command === 'clooks ensure-running')
    );
    expect(cmdHooks.length).toBe(1);
  });

  it('includes Authorization header when auth token is configured', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    const manifest: Manifest = {
      handlers: {
        PreToolUse: [
          { id: 'guard', type: 'script', command: 'echo ok', timeout: 3000 },
        ],
      },
      settings: { port: 7890, authToken: 'my-secret-token' },
    };

    syncSettings({ settingsPath, manifest });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const httpHooks = settings.hooks.PreToolUse.flatMap((r: { hooks: Array<{ type: string; headers?: Record<string, string> }> }) =>
      r.hooks.filter((h: { type: string }) => h.type === 'http')
    );
    expect(httpHooks[0].headers).toEqual({ Authorization: 'Bearer my-secret-token' });
  });

  it('returns empty array when settings file does not exist', () => {
    const added = syncSettings({ settingsPath: join(tmpDir, 'nonexistent.json'), manifest: baseManifest });
    expect(added).toEqual([]);
  });

  it('returns empty array when already in sync', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'clooks ensure-running' },
            ],
          },
        ],
        PreToolUse: [
          { hooks: [{ type: 'http', url: 'http://localhost:7890/hooks/PreToolUse' }] },
        ],
        Notification: [
          { hooks: [{ type: 'http', url: 'http://localhost:7890/hooks/Notification' }] },
        ],
      },
    }, null, 2));

    const added = syncSettings({ settingsPath, manifest: baseManifest });
    expect(added).toEqual([]);
  });

  it('preserves existing non-clooks hooks', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'echo custom-guard' },
            ],
          },
        ],
      },
    }, null, 2));

    syncSettings({ settingsPath, manifest: baseManifest });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Original matcher-based rule should still exist
    const matcherRule = settings.hooks.PreToolUse.find((r: { matcher?: string }) => r.matcher === 'Bash');
    expect(matcherRule).toBeDefined();
    expect(matcherRule.hooks[0].command).toBe('echo custom-guard');
  });

  it('appends to existing unmatched rule group', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'echo existing' },
            ],
          },
        ],
      },
    }, null, 2));

    syncSettings({ settingsPath, manifest: baseManifest });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Should append HTTP hook to the existing unmatched rule, not create a new one
    const unmatchedRule = settings.hooks.PreToolUse.find((r: { matcher?: string }) => !r.matcher);
    expect(unmatchedRule).toBeDefined();
    expect(unmatchedRule.hooks.length).toBe(2); // existing command + new http
    expect(unmatchedRule.hooks[0].type).toBe('command');
    expect(unmatchedRule.hooks[1].type).toBe('http');
  });
});
