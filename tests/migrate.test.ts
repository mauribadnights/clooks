import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { migrate, restore, getSettingsPath } from '../src/migrate.js';

/**
 * SAFETY: All tests pass explicit path overrides via MigratePathOptions.
 * No mocking of os.homedir() or constants is needed.
 * Each helper asserts the path is inside the temp directory before writing.
 */

function assertInTmpDir(path: string, tmpDir: string): void {
  if (!path.startsWith(tmpDir)) {
    throw new Error(
      `SAFETY VIOLATION: path "${path}" is not inside temp dir "${tmpDir}". ` +
      `Refusing to write to real filesystem.`
    );
  }
}

describe('migrate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-migrate-'));
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    mkdirSync(join(tmpDir, '.clooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Safety: verify the real settings.json was NOT modified during this test.
    const realSettings = join(homedir(), '.claude', 'settings.json');
    // We can't know the original mtime, but we CAN verify no test wrote to it
    // by checking that none of our temp paths leaked to real paths.
    // The assertInTmpDir guards above are the primary defense.
  });

  function settingsPath() {
    return join(tmpDir, '.claude', 'settings.json');
  }

  function backupPath() {
    return join(tmpDir, '.clooks', 'settings.backup.json');
  }

  function manifestPath() {
    return join(tmpDir, '.clooks', 'manifest.yaml');
  }

  function pathOptions() {
    return {
      homeDir: tmpDir,
      configDir: join(tmpDir, '.clooks'),
      settingsBackup: backupPath(),
    };
  }

  it('finds settings.json via getSettingsPath', () => {
    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, '{}', 'utf-8');
    const found = getSettingsPath({ homeDir: tmpDir });
    expect(found).toBe(sp);
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

    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, JSON.stringify(settings), 'utf-8');

    const result = migrate(pathOptions());

    expect(result.handlersCreated).toBe(2);
    expect(existsSync(manifestPath())).toBe(true);
    expect(existsSync(backupPath())).toBe(true);

    // Check the rewritten settings has HTTP hooks
    const newSettings = JSON.parse(readFileSync(sp, 'utf-8'));

    const postHooks = newSettings.hooks.PostToolUse as any[];
    expect(Array.isArray(postHooks)).toBe(true);
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
    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, JSON.stringify(original), 'utf-8');

    migrate(pathOptions());

    expect(existsSync(backupPath())).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath(), 'utf-8'));
    expect(backup.custom).toBe('data');
  });

  it('throws when no hooks are found in settings', () => {
    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, JSON.stringify({ someOther: 'config' }), 'utf-8');

    expect(() => migrate(pathOptions())).toThrow('No hooks found');
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

    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, JSON.stringify(settings), 'utf-8');

    expect(() => migrate(pathOptions())).toThrow('already contain HTTP hooks');
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

    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, JSON.stringify(settings), 'utf-8');

    migrate(pathOptions());

    const newSettings = JSON.parse(readFileSync(sp, 'utf-8'));
    const sessionStart = newSettings.hooks.SessionStart as any[];
    expect(sessionStart).toBeDefined();
    expect(Array.isArray(sessionStart)).toBe(true);
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
    expect(() => migrate(pathOptions())).toThrow('Could not find Claude Code settings.json');
  });
});

describe('restore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-restore-'));
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    mkdirSync(join(tmpDir, '.clooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function settingsPath() {
    return join(tmpDir, '.claude', 'settings.json');
  }

  function backupPath() {
    return join(tmpDir, '.clooks', 'settings.backup.json');
  }

  function pathOptions() {
    return {
      homeDir: tmpDir,
      configDir: join(tmpDir, '.clooks'),
      settingsBackup: backupPath(),
    };
  }

  it('restores settings from backup', () => {
    const original = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo original' }] }],
      },
    };
    const bp = backupPath();
    const sp = settingsPath();
    assertInTmpDir(bp, tmpDir);
    assertInTmpDir(sp, tmpDir);
    writeFileSync(bp, JSON.stringify(original), 'utf-8');
    writeFileSync(sp, JSON.stringify({ hooks: { modified: true } }), 'utf-8');

    const restoredPath = restore(pathOptions());

    expect(restoredPath).toBe(sp);
    const restored = JSON.parse(readFileSync(sp, 'utf-8'));
    expect(restored.hooks.PreToolUse).toBeDefined();
  });

  it('throws when no backup exists', () => {
    const sp = settingsPath();
    assertInTmpDir(sp, tmpDir);
    writeFileSync(sp, JSON.stringify({}), 'utf-8');

    const bp = backupPath();
    if (existsSync(bp)) {
      rmSync(bp);
    }

    expect(() => restore(pathOptions())).toThrow('No backup found');
  });
});
