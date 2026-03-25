import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml } from 'yaml';
import {
  discoverCCPlugins,
  convertPluginsToHandlers,
  importPlugins,
} from '../src/import-plugins.js';
import type { CCPlugin } from '../src/import-plugins.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clooks-cc-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Helper: create a CC plugin directory structure */
function createCCPlugin(
  name: string,
  opts: {
    version?: string;
    hooks?: Record<string, unknown[]>;
    clooksYaml?: Record<string, unknown>;
    hooksInPluginJson?: boolean;
  } = {}
): string {
  const pluginDir = join(tempDir, name);
  const pluginJsonDir = join(pluginDir, '.claude-plugin');
  mkdirSync(pluginJsonDir, { recursive: true });

  const pluginJson: Record<string, unknown> = {
    name,
    version: opts.version ?? '1.0.0',
  };

  if (opts.hooksInPluginJson) {
    pluginJson.hooks = 'custom-hooks/hooks.json';
    const customDir = join(pluginDir, 'custom-hooks');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'hooks.json'), JSON.stringify(opts.hooks ?? {}), 'utf-8');
  } else if (opts.hooks) {
    const hooksDir = join(pluginDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify(opts.hooks), 'utf-8');
  }

  writeFileSync(join(pluginJsonDir, 'plugin.json'), JSON.stringify(pluginJson), 'utf-8');

  if (opts.clooksYaml) {
    writeFileSync(join(pluginDir, 'clooks.yaml'), stringifyYaml(opts.clooksYaml), 'utf-8');
  }

  return pluginDir;
}

// ---------------------------------------------------------------------------
// discoverCCPlugins
// ---------------------------------------------------------------------------
describe('discoverCCPlugins', () => {
  it('discovers CC plugins from directory', () => {
    createCCPlugin('my-plugin', {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /path/to/guard.js' }] },
        ],
      },
    });

    const plugins = discoverCCPlugins(tempDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('my-plugin');
    expect(plugins[0].version).toBe('1.0.0');
    expect(plugins[0].hooks.PreToolUse).toHaveLength(1);
    expect(plugins[0].hooks.PreToolUse![0].command).toBe('node /path/to/guard.js');
    expect(plugins[0].hooks.PreToolUse![0].matcher).toBe('Bash');
  });

  it('returns empty array when directory does not exist', () => {
    const plugins = discoverCCPlugins(join(tempDir, 'nonexistent'));
    expect(plugins).toEqual([]);
  });

  it('skips plugins without plugin.json', () => {
    const pluginDir = join(tempDir, 'bad-plugin');
    mkdirSync(pluginDir, { recursive: true });
    // No .claude-plugin/plugin.json
    const plugins = discoverCCPlugins(tempDir);
    expect(plugins).toEqual([]);
  });

  it('skips plugins without hooks', () => {
    const pluginDir = join(tempDir, 'no-hooks');
    const pluginJsonDir = join(pluginDir, '.claude-plugin');
    mkdirSync(pluginJsonDir, { recursive: true });
    writeFileSync(join(pluginJsonDir, 'plugin.json'), JSON.stringify({ name: 'no-hooks', version: '1.0.0' }), 'utf-8');

    const plugins = discoverCCPlugins(tempDir);
    expect(plugins).toEqual([]);
  });

  it('parses nested rule group format correctly', () => {
    createCCPlugin('multi-hook', {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: 'node /a/format.js' },
              { type: 'command', command: 'node /a/lint.js' },
            ],
          },
          {
            hooks: [
              { type: 'command', command: 'node /a/log.js' },
            ],
          },
        ],
      },
    });

    const plugins = discoverCCPlugins(tempDir);
    expect(plugins[0].hooks.PostToolUse).toHaveLength(3);
    expect(plugins[0].hooks.PostToolUse![0].matcher).toBe('Write');
    expect(plugins[0].hooks.PostToolUse![1].matcher).toBe('Write');
    expect(plugins[0].hooks.PostToolUse![2].matcher).toBeUndefined();
  });

  it('reads clooks.yaml enhancements when present', () => {
    createCCPlugin('enhanced', {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'node /path/to/context-monitor.js' }] },
        ],
      },
      clooksYaml: {
        handlers: {
          'context-monitor': {
            filter: 'Write|Edit|Bash',
            async: true,
            sessionIsolation: true,
          },
        },
      },
    });

    const plugins = discoverCCPlugins(tempDir);
    expect(plugins[0].clooksEnhancements).toBeDefined();
    expect(plugins[0].clooksEnhancements!['context-monitor']).toEqual({
      filter: 'Write|Edit|Bash',
      async: true,
      sessionIsolation: true,
    });
  });

  it('handles missing clooks.yaml gracefully', () => {
    createCCPlugin('basic', {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /path/to/init.js' }] },
        ],
      },
    });

    const plugins = discoverCCPlugins(tempDir);
    expect(plugins[0].clooksEnhancements).toBeUndefined();
  });

  it('handles hooks path specified in plugin.json', () => {
    createCCPlugin('custom-path', {
      hooksInPluginJson: true,
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node /path/to/cleanup.js' }] },
        ],
      },
    });

    const plugins = discoverCCPlugins(tempDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].hooks.Stop).toHaveLength(1);
  });

  it('ignores non-command hook types during discovery (they are still parsed)', () => {
    createCCPlugin('mixed-types', {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command', command: 'node /path/to/cmd.js' },
              { type: 'http', url: 'http://example.com/hook' },
            ],
          },
        ],
      },
    });

    const plugins = discoverCCPlugins(tempDir);
    // Both are parsed during discovery
    expect(plugins[0].hooks.PreToolUse).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// convertPluginsToHandlers
// ---------------------------------------------------------------------------
describe('convertPluginsToHandlers', () => {
  it('namespaces handler IDs as pluginName/derivedId', () => {
    const plugins: CCPlugin[] = [{
      name: 'my-plugin',
      version: '1.0.0',
      path: '/fake/path',
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'node /scripts/guard.js' },
        ],
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    expect(handlers.PreToolUse).toHaveLength(1);
    expect(handlers.PreToolUse![0].id).toBe('my-plugin/guard');
  });

  it('only imports command hooks (skips http/prompt/agent)', () => {
    const plugins: CCPlugin[] = [{
      name: 'test',
      version: '1.0.0',
      path: '/fake',
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'node /a.js' },
          { type: 'http', url: 'http://example.com' },
          { type: 'prompt', command: undefined },
        ],
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    expect(handlers.PreToolUse).toHaveLength(1);
    expect(handlers.PreToolUse![0].id).toBe('test/a');
  });

  it('resolves ${CLAUDE_PLUGIN_ROOT} in commands', () => {
    const plugins: CCPlugin[] = [{
      name: 'resolver',
      version: '1.0.0',
      path: '/home/user/.claude/plugins/cache/resolver',
      hooks: {
        SessionStart: [
          { type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/init.js' },
        ],
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    expect((handlers.SessionStart![0] as any).command).toBe(
      'node /home/user/.claude/plugins/cache/resolver/scripts/init.js'
    );
  });

  it('resolves $CLAUDE_PLUGIN_ROOT (without braces) in commands', () => {
    const plugins: CCPlugin[] = [{
      name: 'resolver2',
      version: '1.0.0',
      path: '/fake/path',
      hooks: {
        Stop: [
          { type: 'command', command: 'node $CLAUDE_PLUGIN_ROOT/cleanup.js' },
        ],
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    expect((handlers.Stop![0] as any).command).toBe('node /fake/path/cleanup.js');
  });

  it('applies clooks.yaml enhancements', () => {
    const plugins: CCPlugin[] = [{
      name: 'enhanced',
      version: '1.0.0',
      path: '/fake',
      hooks: {
        PreToolUse: [
          { type: 'command', command: 'node /scripts/context-monitor.js' },
        ],
      },
      clooksEnhancements: {
        'context-monitor': {
          filter: 'Write|Edit',
          async: true,
          sessionIsolation: true,
          project: '*/.planning/*',
        },
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    const h = handlers.PreToolUse![0] as any;
    expect(h.filter).toBe('Write|Edit');
    expect(h.async).toBe(true);
    expect(h.sessionIsolation).toBe(true);
    expect(h.project).toBe('*/.planning/*');
  });

  it('namespaces depends references within same plugin', () => {
    const plugins: CCPlugin[] = [{
      name: 'dep-plugin',
      version: '1.0.0',
      path: '/fake',
      hooks: {
        PostToolUse: [
          { type: 'command', command: 'node /scripts/first.js' },
          { type: 'command', command: 'node /scripts/second.js' },
        ],
      },
      clooksEnhancements: {
        'second': {
          depends: ['first', 'other-plugin/external'],
        },
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    const second = handlers.PostToolUse![1] as any;
    expect(second.depends).toEqual(['dep-plugin/first', 'other-plugin/external']);
  });

  it('converts to LLM handler when enhancement specifies type: llm', () => {
    const plugins: CCPlugin[] = [{
      name: 'llm-plugin',
      version: '1.0.0',
      path: '/fake',
      hooks: {
        UserPromptSubmit: [
          { type: 'command', command: 'node /scripts/analyze.js' },
        ],
      },
      clooksEnhancements: {
        'analyze': {
          type: 'llm',
          model: 'claude-haiku-4-5',
          prompt: 'Analyze the following: $PROMPT',
          maxTokens: 512,
          temperature: 0.5,
          batchGroup: 'analysis',
        },
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    const h = handlers.UserPromptSubmit![0] as any;
    expect(h.type).toBe('llm');
    expect(h.model).toBe('claude-haiku-4-5');
    expect(h.prompt).toBe('Analyze the following: $PROMPT');
    expect(h.command).toBeUndefined();
    expect(h.maxTokens).toBe(512);
    expect(h.temperature).toBe(0.5);
    expect(h.batchGroup).toBe('analysis');
  });

  it('derives fallback ID for non-script commands', () => {
    const plugins: CCPlugin[] = [{
      name: 'fallback',
      version: '1.0.0',
      path: '/fake',
      hooks: {
        Stop: [
          { type: 'command', command: 'echo done' },
        ],
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    expect(handlers.Stop![0].id).toBe('fallback/stop-0');
  });

  it('derives ID from python -m module pattern', () => {
    const plugins: CCPlugin[] = [{
      name: 'py-plugin',
      version: '1.0.0',
      path: '/fake',
      hooks: {
        SessionStart: [
          { type: 'command', command: 'python3 -m mypackage.hooks.session_init' },
        ],
      },
    }];

    const handlers = convertPluginsToHandlers(plugins);
    expect(handlers.SessionStart![0].id).toBe('py-plugin/hooks-session_init');
  });
});

// ---------------------------------------------------------------------------
// importPlugins (integration)
// ---------------------------------------------------------------------------
describe('importPlugins', () => {
  it('returns empty when no plugins exist', () => {
    const { plugins, handlers } = importPlugins(join(tempDir, 'nonexistent'));
    expect(plugins).toEqual([]);
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it('discovers and converts plugins end-to-end', () => {
    createCCPlugin('end-to-end', {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'node /scripts/check.js' }] },
        ],
        PostToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node /scripts/format.js' }] },
        ],
      },
      clooksYaml: {
        handlers: {
          'check': { filter: 'Bash' },
        },
      },
    });

    const { plugins, handlers } = importPlugins(tempDir);
    expect(plugins).toHaveLength(1);
    expect(handlers.PreToolUse).toHaveLength(1);
    expect(handlers.PostToolUse).toHaveLength(1);
    expect((handlers.PreToolUse![0] as any).filter).toBe('Bash');
  });
});
