import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml } from 'yaml';
import { validateManifest } from '../src/manifest.js';
import type { Manifest } from '../src/types.js';

describe('manifest', () => {
  describe('validateManifest', () => {
    it('accepts a valid manifest with script handlers', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: [
            { id: 'guard', type: 'script', command: 'echo ok' },
          ],
          PostToolUse: [
            { id: 'logger', type: 'script', command: 'echo done' },
          ],
        },
        settings: { port: 7890, logLevel: 'info' },
      };

      expect(() => validateManifest(manifest)).not.toThrow();
    });

    it('accepts a valid manifest with inline handlers', () => {
      const manifest: Manifest = {
        handlers: {
          Stop: [
            { id: 'inline-stop', type: 'inline', module: './handlers/stop.js' },
          ],
        },
      };

      expect(() => validateManifest(manifest)).not.toThrow();
    });

    it('accepts empty handlers object', () => {
      const manifest: Manifest = { handlers: {} };
      expect(() => validateManifest(manifest)).not.toThrow();
    });

    it('throws when handlers is missing', () => {
      expect(() => validateManifest({} as Manifest)).toThrow('must have a "handlers" object');
    });

    it('throws when handlers is not an object', () => {
      expect(() => validateManifest({ handlers: 'bad' } as unknown as Manifest)).toThrow(
        'must have a "handlers" object',
      );
    });

    it('throws on duplicate handler IDs', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: [{ id: 'dup', type: 'script', command: 'echo 1' }],
          PostToolUse: [{ id: 'dup', type: 'script', command: 'echo 2' }],
        },
      };

      expect(() => validateManifest(manifest)).toThrow('Duplicate handler id: "dup"');
    });

    it('throws on unknown event names', () => {
      const manifest: Manifest = {
        handlers: {
          InvalidEvent: [{ id: 'x', type: 'script', command: 'echo x' }],
        } as Manifest['handlers'],
      };

      expect(() => validateManifest(manifest)).toThrow('Unknown hook event: "InvalidEvent"');
    });

    it('throws when script handler has no command', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: [{ id: 'no-cmd', type: 'script' }],
        },
      };

      expect(() => validateManifest(manifest)).toThrow(
        'Script handler "no-cmd" must have a "command" field',
      );
    });

    it('throws when inline handler has no module', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: [{ id: 'no-mod', type: 'inline' }],
        },
      };

      expect(() => validateManifest(manifest)).toThrow(
        'Inline handler "no-mod" must have a "module" field',
      );
    });

    it('throws when handler has no id', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: [{ type: 'script', command: 'echo' } as any],
        },
      };

      expect(() => validateManifest(manifest)).toThrow('must have a string "id"');
    });

    it('throws when handler has invalid type', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: [{ id: 'bad-type', type: 'webhook' as any, command: 'echo' }],
        },
      };

      expect(() => validateManifest(manifest)).toThrow('must have type "script" or "inline"');
    });

    it('throws when handlers for an event is not an array', () => {
      const manifest: Manifest = {
        handlers: {
          PreToolUse: { id: 'x' } as any,
        },
      };

      expect(() => validateManifest(manifest)).toThrow('must be an array');
    });

    describe('settings validation', () => {
      it('accepts valid port and logLevel', () => {
        const manifest: Manifest = {
          handlers: {},
          settings: { port: 8080, logLevel: 'debug' },
        };
        expect(() => validateManifest(manifest)).not.toThrow();
      });

      it('accepts all valid log levels', () => {
        for (const logLevel of ['debug', 'info', 'warn', 'error'] as const) {
          const manifest: Manifest = {
            handlers: {},
            settings: { logLevel },
          };
          expect(() => validateManifest(manifest)).not.toThrow();
        }
      });

      it('throws on invalid port (negative)', () => {
        const manifest: Manifest = {
          handlers: {},
          settings: { port: -1 },
        };
        expect(() => validateManifest(manifest)).toThrow('settings.port must be a number between 1 and 65535');
      });

      it('throws on invalid port (too high)', () => {
        const manifest: Manifest = {
          handlers: {},
          settings: { port: 70000 },
        };
        expect(() => validateManifest(manifest)).toThrow('settings.port must be a number between 1 and 65535');
      });

      it('throws on invalid port (not a number)', () => {
        const manifest: Manifest = {
          handlers: {},
          settings: { port: 'abc' as any },
        };
        expect(() => validateManifest(manifest)).toThrow('settings.port must be a number between 1 and 65535');
      });

      it('throws on invalid logLevel', () => {
        const manifest: Manifest = {
          handlers: {},
          settings: { logLevel: 'trace' as any },
        };
        expect(() => validateManifest(manifest)).toThrow('settings.logLevel must be one of');
      });
    });
  });

  describe('loadManifest (via YAML parsing)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'clooks-manifest-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('parses valid YAML into a manifest', async () => {
      const manifest: Manifest = {
        handlers: {
          PostToolUse: [
            { id: 'test-handler', type: 'script', command: 'echo hello', timeout: 3000, enabled: true },
          ],
        },
        settings: { port: 9999, logLevel: 'warn' },
      };

      const yamlPath = join(tmpDir, 'manifest.yaml');
      writeFileSync(yamlPath, stringifyYaml(manifest), 'utf-8');

      // We can't easily call loadManifest with a custom path,
      // but we can parse the YAML and validate it ourselves
      const { parse: parseYaml } = await import('yaml');
      const { readFileSync } = await import('fs');
      const raw = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(raw) as Manifest;

      expect(() => validateManifest(parsed)).not.toThrow();
      expect(parsed.handlers.PostToolUse).toHaveLength(1);
      expect(parsed.handlers.PostToolUse![0].id).toBe('test-handler');
      expect(parsed.settings?.port).toBe(9999);
    });

    it('throws on invalid YAML content (when not an object)', () => {
      // Validate that non-object parsed YAML would fail validation
      expect(() => validateManifest(null as any)).toThrow();
    });
  });
});
