import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stable reference for the fake home directory that mocks can read
const testEnv = { home: '' };

// Mock os.homedir so getSettingsPath finds our temp settings.json
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return {
    ...original,
    homedir: () => testEnv.home || original.homedir(),
  };
});

// Mock constants to use dynamic getters pointing to temp dirs
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/constants.js')>();
  return {
    ...original,
    get CONFIG_DIR() {
      if (!testEnv.home) return original.CONFIG_DIR;
      const { join } = require('path');
      return join(testEnv.home, '.cchooks');
    },
    get SETTINGS_BACKUP() {
      if (!testEnv.home) return original.SETTINGS_BACKUP;
      const { join } = require('path');
      return join(testEnv.home, '.cchooks', 'settings.backup.json');
    },
    get MANIFEST_PATH() {
      if (!testEnv.home) return original.MANIFEST_PATH;
      const { join } = require('path');
      return join(testEnv.home, '.cchooks', 'manifest.yaml');
    },
  };
});

const { migrate, restore, getSettingsPath } = await import('../src/migrate.js');

describe('migrate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cchooks-migrate-'));
    testEnv.home = tmpDir;
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    mkdirSync(join(tmpDir, '.cchooks'), { recursive: true });
  });

  afterEach(() => {
    testEnv.home = '';
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function settingsPath() {
    return join(tmpDir, '.claude', 'settings.json');
  }

  function backupPath() {
    return join(tmpDir, '.cchooks', 'settings.backup.json');
  }

  function manifestPath() {
    return join(tmpDir, '.cchooks', 'manifest.yaml');
  }

  it('finds settings.json via getSettingsPath', () => {
    writeFileSync(settingsPath(), '{}', 'utf-8');
    const found = getSettingsPath();
    expect(found).toBe(settingsPath());
  });

  it('migrates command hooks to manifest + HTTP hooks', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { type: 'command', command: 'node /path/to/logger.js' },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node /path/to/guard.js' },
            ],
          },
        ],
      },
    };

    writeFileSync(settingsPath(), JSON.stringify(settings), 'utf-8');

    const result = migrate();

    expect(result.handlersCreated).toBe(2);
    expect(existsSync(manifestPath())).toBe(true);
    expect(existsSync(backupPath())).toBe(true);

    // Check the rewritten settings has HTTP hooks
    const newSettings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));

    // The migrate function produces nested rule groups in the rewritten settings.
    // Each event maps to an array of rule group objects with { hooks: [...] }.
    const postHooks = newSettings.hooks.PostToolUse as any[];
    expect(Array.isArray(postHooks)).toBe(true);
    // Find the HTTP hook entry (may be nested inside a rule group's hooks array or flat)
    const findHttpHook = (arr: any[], eventName: string) => {
      for (const item of arr) {
        if (item.type === 'http' && item.url?.includes(`/hooks/${eventName}`)) return item;
        if (Array.isArray(item.hooks)) {
          const found = item.hooks.find((h: any) => h.type === 'http' && h.url?.includes(`/hooks/${eventName}`));
          if (found) return found;
        }
      }
      return undefined;
    };
    expect(findHttpHook(postHooks, 'PostToolUse')).toBeDefined();

    const preHooks = newSettings.hooks.PreToolUse as any[];
    expect(Array.isArray(preHooks)).toBe(true);
    expect(findHttpHook(preHooks, 'PreToolUse')).toBeDefined();

    // SessionStart should exist
    expect(newSettings.hooks.SessionStart).toBeDefined();
  });

  it('backs up original settings', () => {
    const original = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
      custom: 'data',
    };
    writeFileSync(settingsPath(), JSON.stringify(original), 'utf-8');

    migrate();

    expect(existsSync(backupPath())).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath(), 'utf-8'));
    expect(backup.custom).toBe('data');
  });

  it('throws when no hooks are found in settings', () => {
    writeFileSync(settingsPath(), JSON.stringify({ someOther: 'config' }), 'utf-8');

    expect(() => migrate()).toThrow('No hooks found');
  });

  it('throws when already migrated (HTTP hooks detected)', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { type: 'http', url: 'http://localhost:7890/hooks/PostToolUse' },
            ],
          },
        ],
      },
    };

    writeFileSync(settingsPath(), JSON.stringify(settings), 'utf-8');

    expect(() => migrate()).toThrow('already contain HTTP hooks');
  });

  it('adds SessionStart ensure-running command even if no hooks for that event', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { type: 'command', command: 'echo hello' },
            ],
          },
        ],
      },
    };

    writeFileSync(settingsPath(), JSON.stringify(settings), 'utf-8');

    migrate();

    const newSettings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    const sessionStart = newSettings.hooks.SessionStart as any[];
    expect(sessionStart).toBeDefined();
    expect(Array.isArray(sessionStart)).toBe(true);
    // Should contain an ensure-running command (may be flat or nested in a rule group)
    const findEnsure = (arr: any[]) => {
      for (const item of arr) {
        if (item.type === 'command' && item.command?.includes('ensure-running')) return item;
        if (Array.isArray(item.hooks)) {
          const found = item.hooks.find((h: any) => h.type === 'command' && h.command?.includes('ensure-running'));
          if (found) return found;
        }
      }
      return undefined;
    };
    expect(findEnsure(sessionStart)).toBeDefined();
  });

  it('throws when settings.json cannot be found', () => {
    // Don't create settings.json — getSettingsPath returns null
    expect(() => migrate()).toThrow('Could not find Claude Code settings.json');
  });
});

describe('restore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cchooks-restore-'));
    testEnv.home = tmpDir;
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    mkdirSync(join(tmpDir, '.cchooks'), { recursive: true });
  });

  afterEach(() => {
    testEnv.home = '';
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function settingsPath() {
    return join(tmpDir, '.claude', 'settings.json');
  }

  function backupPath() {
    return join(tmpDir, '.cchooks', 'settings.backup.json');
  }

  it('restores settings from backup', () => {
    const original = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo original' }] }],
      },
    };
    writeFileSync(backupPath(), JSON.stringify(original), 'utf-8');
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { modified: true } }), 'utf-8');

    const restoredPath = restore();

    expect(restoredPath).toBe(settingsPath());
    const restored = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(restored.hooks.PreToolUse).toBeDefined();
  });

  it('throws when no backup exists', () => {
    writeFileSync(settingsPath(), JSON.stringify({}), 'utf-8');

    const bp = backupPath();
    if (existsSync(bp)) {
      rmSync(bp);
    }

    expect(() => restore()).toThrow('No backup found');
  });
});
