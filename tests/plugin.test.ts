import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml } from 'yaml';
import {
  validatePluginManifest,
  installPlugin,
  uninstallPlugin,
  loadPlugins,
  mergeManifests,
  listPlugins,
  loadRegistry,
  saveRegistry,
} from '../src/plugin.js';
import type { PluginManifest, Manifest } from '../src/types.js';

/** Helper: create a valid plugin manifest object. */
function makePluginManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    handlers: {
      PreToolUse: [
        { id: 'guard', type: 'script', command: 'echo deny' },
      ],
    },
    ...overrides,
  };
}

/** Helper: write a plugin directory on disk with a clooks-plugin.yaml. */
function writePluginDir(parentDir: string, manifest: PluginManifest): string {
  const pluginDir = join(parentDir, manifest.name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'clooks-plugin.yaml'), stringifyYaml(manifest), 'utf-8');
  return pluginDir;
}

// ---------------------------------------------------------------------------
// validatePluginManifest
// ---------------------------------------------------------------------------
describe('validatePluginManifest', () => {
  it('valid plugin manifest passes', () => {
    expect(() => validatePluginManifest(makePluginManifest())).not.toThrow();
  });

  it('missing name throws', () => {
    const m = makePluginManifest();
    (m as any).name = '';
    expect(() => validatePluginManifest(m)).toThrow('"name"');
  });

  it('missing version throws', () => {
    const m = makePluginManifest();
    (m as any).version = '';
    expect(() => validatePluginManifest(m)).toThrow('"version"');
  });

  it('invalid handler type throws', () => {
    const m = makePluginManifest({
      handlers: {
        PreToolUse: [
          { id: 'bad', type: 'webhook' as any, command: 'echo' } as any,
        ],
      },
    });
    expect(() => validatePluginManifest(m)).toThrow('must have type');
  });

  it('valid handlers pass (script, inline, llm)', () => {
    const m = makePluginManifest({
      handlers: {
        PreToolUse: [
          { id: 'h-script', type: 'script', command: 'echo ok' },
        ],
        PostToolUse: [
          { id: 'h-inline', type: 'inline', module: './handler.js' },
        ],
        Stop: [
          { id: 'h-llm', type: 'llm', model: 'claude-haiku-4-5', prompt: 'analyze' } as any,
        ],
      },
    });
    expect(() => validatePluginManifest(m)).not.toThrow();
  });

  it('missing handlers object throws', () => {
    const m = makePluginManifest();
    (m as any).handlers = undefined;
    expect(() => validatePluginManifest(m)).toThrow('"handlers"');
  });

  it('duplicate handler ids throw', () => {
    const m = makePluginManifest({
      handlers: {
        PreToolUse: [
          { id: 'dup', type: 'script', command: 'echo 1' },
          { id: 'dup', type: 'script', command: 'echo 2' },
        ],
      },
    });
    expect(() => validatePluginManifest(m)).toThrow('Duplicate handler id');
  });

  it('unknown hook event throws', () => {
    const m = makePluginManifest({
      handlers: {
        FakeEvent: [{ id: 'x', type: 'script', command: 'echo' }],
      } as any,
    });
    expect(() => validatePluginManifest(m)).toThrow('Unknown hook event');
  });

  it('invalid prefetch key throws', () => {
    const m = makePluginManifest({ prefetch: ['bogus' as any] });
    expect(() => validatePluginManifest(m)).toThrow('Invalid prefetch key');
  });

  it('valid prefetch keys pass', () => {
    const m = makePluginManifest({ prefetch: ['transcript', 'git_status'] });
    expect(() => validatePluginManifest(m)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// installPlugin
// ---------------------------------------------------------------------------
describe('installPlugin', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-plugin-install-'));
    pluginsDir = join(tmpDir, 'plugins');
    registryPath = join(pluginsDir, 'installed.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs from local directory to plugins dir', () => {
    const sourceDir = writePluginDir(tmpDir, makePluginManifest());

    const entry = installPlugin(sourceDir, pluginsDir, registryPath);

    expect(entry.name).toBe('test-plugin');
    expect(entry.version).toBe('1.0.0');
    expect(existsSync(join(pluginsDir, 'test-plugin', 'clooks-plugin.yaml'))).toBe(true);
  });

  it('creates installed.json entry', () => {
    const sourceDir = writePluginDir(tmpDir, makePluginManifest());

    installPlugin(sourceDir, pluginsDir, registryPath);

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].name).toBe('test-plugin');
    expect(registry.plugins[0].version).toBe('1.0.0');
    expect(registry.plugins[0].installedAt).toBeTruthy();
  });

  it('resolves $PLUGIN_DIR in handler commands', () => {
    const manifest = makePluginManifest({
      handlers: {
        PreToolUse: [
          { id: 'run', type: 'script', command: '$PLUGIN_DIR/bin/check.sh' },
        ],
      },
    });
    const sourceDir = writePluginDir(tmpDir, manifest);

    installPlugin(sourceDir, pluginsDir, registryPath);

    const installedYaml = readFileSync(
      join(pluginsDir, 'test-plugin', 'clooks-plugin.yaml'),
      'utf-8',
    );
    const expectedPath = join(pluginsDir, 'test-plugin');
    expect(installedYaml).toContain(expectedPath + '/bin/check.sh');
    expect(installedYaml).not.toContain('$PLUGIN_DIR');
  });

  it('throws if clooks-plugin.yaml does not exist', () => {
    const emptyDir = join(tmpDir, 'empty-plugin');
    mkdirSync(emptyDir, { recursive: true });

    expect(() => installPlugin(emptyDir, pluginsDir, registryPath)).toThrow(
      'No clooks-plugin.yaml found',
    );
  });

  it('reinstalls if plugin already installed (overwrites)', () => {
    const manifest = makePluginManifest({ version: '1.0.0' });
    const sourceDir = writePluginDir(tmpDir, manifest);

    installPlugin(sourceDir, pluginsDir, registryPath);

    // Update version and reinstall
    const manifestV2 = makePluginManifest({ version: '2.0.0' });
    writeFileSync(join(sourceDir, 'clooks-plugin.yaml'), stringifyYaml(manifestV2), 'utf-8');

    const entry = installPlugin(sourceDir, pluginsDir, registryPath);

    expect(entry.version).toBe('2.0.0');

    // Registry should still have exactly 1 entry
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].version).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// uninstallPlugin
// ---------------------------------------------------------------------------
describe('uninstallPlugin', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-plugin-uninstall-'));
    pluginsDir = join(tmpDir, 'plugins');
    registryPath = join(pluginsDir, 'installed.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes from registry and deletes directory', () => {
    const sourceDir = writePluginDir(tmpDir, makePluginManifest());
    installPlugin(sourceDir, pluginsDir, registryPath);

    // Verify it was installed
    expect(existsSync(join(pluginsDir, 'test-plugin'))).toBe(true);

    uninstallPlugin('test-plugin', pluginsDir, registryPath);

    // Plugin directory deleted
    expect(existsSync(join(pluginsDir, 'test-plugin'))).toBe(false);

    // Registry empty
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.plugins).toHaveLength(0);
  });

  it('throws if plugin not found', () => {
    // Ensure an empty registry exists
    saveRegistry({ plugins: [] }, registryPath);

    expect(() => uninstallPlugin('nonexistent', pluginsDir, registryPath)).toThrow(
      'Plugin "nonexistent" is not installed',
    );
  });
});

// ---------------------------------------------------------------------------
// loadPlugins
// ---------------------------------------------------------------------------
describe('loadPlugins', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-plugin-load-'));
    pluginsDir = join(tmpDir, 'plugins');
    registryPath = join(pluginsDir, 'installed.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads installed plugins correctly', () => {
    const manifest = makePluginManifest();
    const sourceDir = writePluginDir(tmpDir, manifest);
    installPlugin(sourceDir, pluginsDir, registryPath);

    const loaded = loadPlugins(pluginsDir, registryPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('test-plugin');
    expect(loaded[0].manifest.name).toBe('test-plugin');
    expect(loaded[0].manifest.version).toBe('1.0.0');
  });

  it('handles missing plugin directory gracefully', () => {
    // Registry references a plugin whose directory was deleted
    saveRegistry(
      {
        plugins: [
          {
            name: 'ghost-plugin',
            version: '1.0.0',
            path: join(pluginsDir, 'ghost-plugin'),
            installedAt: new Date().toISOString(),
          },
        ],
      },
      registryPath,
    );

    const loaded = loadPlugins(pluginsDir, registryPath);
    expect(loaded).toHaveLength(0); // gracefully skipped
  });

  it('handles non-existent registry gracefully', () => {
    // No registry file at all
    const loaded = loadPlugins(pluginsDir, registryPath);
    expect(loaded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mergeManifests
// ---------------------------------------------------------------------------
describe('mergeManifests', () => {
  const baseUserManifest: Manifest = {
    handlers: {
      PreToolUse: [
        { id: 'user-guard', type: 'script', command: 'echo guard' },
      ],
    },
    prefetch: ['transcript'],
    settings: { port: 7890, logLevel: 'info' },
  };

  it('namespaces handler IDs as pluginName/handlerId', () => {
    const plugin: PluginManifest = makePluginManifest({
      name: 'myplugin',
      handlers: {
        PreToolUse: [
          { id: 'checker', type: 'script', command: 'echo check' },
        ],
      },
    });

    const merged = mergeManifests(baseUserManifest, [{ name: 'myplugin', manifest: plugin }]);

    const preToolHandlers = merged.handlers.PreToolUse!;
    expect(preToolHandlers).toHaveLength(2);
    expect(preToolHandlers[0].id).toBe('user-guard');          // user handler unchanged
    expect(preToolHandlers[1].id).toBe('myplugin/checker');     // plugin handler namespaced
  });

  it('unions prefetch keys', () => {
    const plugin: PluginManifest = makePluginManifest({
      prefetch: ['git_status', 'git_diff'],
    });

    const merged = mergeManifests(baseUserManifest, [{ name: 'p', manifest: plugin }]);

    expect(merged.prefetch).toContain('transcript');
    expect(merged.prefetch).toContain('git_status');
    expect(merged.prefetch).toContain('git_diff');
    // No duplicates
    expect(new Set(merged.prefetch).size).toBe(merged.prefetch!.length);
  });

  it('preserves user settings', () => {
    const plugin: PluginManifest = makePluginManifest();

    const merged = mergeManifests(baseUserManifest, [{ name: 'p', manifest: plugin }]);

    expect(merged.settings).toEqual(baseUserManifest.settings);
  });

  it('handles empty plugin list', () => {
    const merged = mergeManifests(baseUserManifest, []);

    expect(merged.handlers.PreToolUse).toHaveLength(1);
    expect(merged.handlers.PreToolUse![0].id).toBe('user-guard');
    expect(merged.prefetch).toEqual(['transcript']);
    expect(merged.settings).toEqual(baseUserManifest.settings);
  });

  it('handles empty user manifest', () => {
    const emptyUser: Manifest = { handlers: {} };
    const plugin: PluginManifest = makePluginManifest({
      name: 'solo',
      handlers: {
        Stop: [{ id: 'stopper', type: 'script', command: 'echo stop' }],
      },
      prefetch: ['git_status'],
    });

    const merged = mergeManifests(emptyUser, [{ name: 'solo', manifest: plugin }]);

    expect(merged.handlers.Stop).toHaveLength(1);
    expect(merged.handlers.Stop![0].id).toBe('solo/stopper');
    expect(merged.prefetch).toEqual(['git_status']);
    expect(merged.settings).toBeUndefined();
  });

  it('multiple plugins merge correctly', () => {
    const pluginA: PluginManifest = makePluginManifest({
      name: 'alpha',
      handlers: {
        PreToolUse: [
          { id: 'a-check', type: 'script', command: 'echo a' },
        ],
      },
      prefetch: ['git_status'],
    });

    const pluginB: PluginManifest = makePluginManifest({
      name: 'beta',
      handlers: {
        PreToolUse: [
          { id: 'b-check', type: 'script', command: 'echo b' },
        ],
        PostToolUse: [
          { id: 'b-log', type: 'script', command: 'echo log' },
        ],
      },
      prefetch: ['git_diff'],
    });

    const merged = mergeManifests(baseUserManifest, [
      { name: 'alpha', manifest: pluginA },
      { name: 'beta', manifest: pluginB },
    ]);

    const preHandlers = merged.handlers.PreToolUse!;
    expect(preHandlers).toHaveLength(3);
    expect(preHandlers.map(h => h.id)).toEqual([
      'user-guard',
      'alpha/a-check',
      'beta/b-check',
    ]);

    const postHandlers = merged.handlers.PostToolUse!;
    expect(postHandlers).toHaveLength(1);
    expect(postHandlers[0].id).toBe('beta/b-log');

    expect(merged.prefetch).toContain('transcript');
    expect(merged.prefetch).toContain('git_status');
    expect(merged.prefetch).toContain('git_diff');
  });

  it('namespaces intra-plugin depends references', () => {
    const plugin: PluginManifest = makePluginManifest({
      name: 'dep-test',
      handlers: {
        PreToolUse: [
          { id: 'first', type: 'script', command: 'echo first' },
          { id: 'second', type: 'script', command: 'echo second', depends: ['first'] },
        ],
      },
    });

    const merged = mergeManifests({ handlers: {} }, [{ name: 'dep-test', manifest: plugin }]);

    const handlers = merged.handlers.PreToolUse!;
    const second = handlers.find(h => h.id === 'dep-test/second')!;
    expect(second.depends).toEqual(['dep-test/first']);
  });

  it('cross-plugin depends (with slash) are left unchanged', () => {
    const plugin: PluginManifest = makePluginManifest({
      name: 'cross',
      handlers: {
        PreToolUse: [
          { id: 'step', type: 'script', command: 'echo step', depends: ['other-plugin/init'] },
        ],
      },
    });

    const merged = mergeManifests({ handlers: {} }, [{ name: 'cross', manifest: plugin }]);

    const handler = merged.handlers.PreToolUse![0];
    expect(handler.depends).toEqual(['other-plugin/init']);
  });
});

// ---------------------------------------------------------------------------
// listPlugins
// ---------------------------------------------------------------------------
describe('listPlugins', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-plugin-list-'));
    pluginsDir = join(tmpDir, 'plugins');
    registryPath = join(pluginsDir, 'installed.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns installed plugins', () => {
    const sourceA = writePluginDir(tmpDir, makePluginManifest({ name: 'alpha', version: '1.0.0' }));
    const sourceB = writePluginDir(tmpDir, makePluginManifest({ name: 'beta', version: '2.0.0' }));

    installPlugin(sourceA, pluginsDir, registryPath);
    installPlugin(sourceB, pluginsDir, registryPath);

    const plugins = listPlugins(registryPath);

    expect(plugins).toHaveLength(2);
    const names = plugins.map(p => p.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('returns empty list when no registry', () => {
    const plugins = listPlugins(registryPath);
    expect(plugins).toHaveLength(0);
  });
});
