import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { generateAuthToken, validateAuth, rotateToken } from '../src/auth.js';

describe('generateAuthToken', () => {
  it('generates a 32-character hex string', () => {
    const token = generateAuthToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique tokens each time', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateAuthToken());
    }
    expect(tokens.size).toBe(100);
  });
});

describe('validateAuth', () => {
  const token = 'abc123def456abc123def456abc123de';

  it('returns true when no expected token (no auth required)', () => {
    expect(validateAuth(undefined, '')).toBe(true);
    expect(validateAuth('anything', '')).toBe(true);
  });

  it('returns false when expected token set but no header', () => {
    expect(validateAuth(undefined, token)).toBe(false);
  });

  it('validates raw token in header', () => {
    expect(validateAuth(token, token)).toBe(true);
  });

  it('validates Bearer token format', () => {
    expect(validateAuth(`Bearer ${token}`, token)).toBe(true);
  });

  it('rejects wrong token', () => {
    expect(validateAuth('wrong-token-value-xxxxxxxxxxxxx', token)).toBe(false);
  });

  it('rejects token of different length', () => {
    expect(validateAuth('short', token)).toBe(false);
  });

  it('rejects Bearer with wrong token', () => {
    expect(validateAuth('Bearer wrong-token-xxxxxxxxxxxxx', token)).toBe(false);
  });

  it('is timing-safe (does not short-circuit on length match)', () => {
    // This is a structural test — we can't truly measure timing, but we verify
    // that the function handles same-length different tokens correctly
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(validateAuth(a, b)).toBe(false);
  });
});

describe('rotateToken', () => {
  let tmpDir: string;
  let manifestPath: string;
  let settingsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-auth-rotate-'));
    manifestPath = join(tmpDir, 'manifest.yaml');
    settingsDir = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates new token and updates manifest file', () => {
    const manifest = {
      handlers: {
        PreToolUse: [{ id: 'guard', type: 'script', command: 'echo ok' }],
      },
      settings: { port: 7890 },
    };
    writeFileSync(manifestPath, stringifyYaml(manifest), 'utf-8');

    const newToken = rotateToken({ manifestPath, settingsDir });

    expect(newToken).toHaveLength(32);
    expect(newToken).toMatch(/^[0-9a-f]{32}$/);

    // Verify manifest was updated
    const updatedRaw = readFileSync(manifestPath, 'utf-8');
    const updated = parseYaml(updatedRaw);
    expect(updated.settings.authToken).toBe(newToken);
  });

  it('updates settings.json Authorization headers for HTTP hooks', () => {
    // Create manifest
    const manifest = { handlers: {}, settings: {} };
    writeFileSync(manifestPath, stringifyYaml(manifest), 'utf-8');

    // Create settings.json with an HTTP hook pointing at localhost
    const settingsPath = join(settingsDir, 'settings.json');
    const settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://localhost:7890/hook',
                headers: { Authorization: 'Bearer old-token' },
              },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    const newToken = rotateToken({ manifestPath, settingsDir });

    // Verify settings.json was updated
    const updatedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hook = updatedSettings.hooks.PreToolUse[0].hooks[0];
    expect(hook.headers.Authorization).toBe(`Bearer ${newToken}`);
  });

  it('throws when manifest does not exist', () => {
    expect(() => rotateToken({ manifestPath: join(tmpDir, 'nonexistent.yaml'), settingsDir })).toThrow(
      'Manifest not found',
    );
  });

  it('preserves comment header in manifest', () => {
    const yamlContent = '# My clooks config\n# Version 2\n\n' + stringifyYaml({
      handlers: {},
      settings: { port: 7890 },
    });
    writeFileSync(manifestPath, yamlContent, 'utf-8');

    rotateToken({ manifestPath, settingsDir });

    const updated = readFileSync(manifestPath, 'utf-8');
    expect(updated.startsWith('# My clooks config\n# Version 2\n')).toBe(true);
  });
});
