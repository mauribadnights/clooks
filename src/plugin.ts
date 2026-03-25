// clooks plugin system — load, install, uninstall, merge plugin manifests

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { parse as parseYaml } from 'yaml';
import { PLUGINS_DIR, PLUGIN_REGISTRY, PLUGIN_MANIFEST_NAME, HOOK_EVENTS } from './constants.js';
import type {
  PluginManifest,
  PluginRegistry,
  InstalledPlugin,
  Manifest,
  HandlerConfig,
  HookEvent,
  PrefetchKey,
} from './types.js';

/**
 * Load the plugin registry (installed.json).
 */
export function loadRegistry(registryPath: string = PLUGIN_REGISTRY): PluginRegistry {
  if (!existsSync(registryPath)) {
    return { plugins: [] };
  }

  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.plugins)) {
      return { plugins: [] };
    }
    return parsed as PluginRegistry;
  } catch {
    return { plugins: [] };
  }
}

/**
 * Save the plugin registry.
 */
export function saveRegistry(registry: PluginRegistry, registryPath: string = PLUGIN_REGISTRY): void {
  const dir = resolvePath(registryPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

/**
 * Validate a plugin manifest.
 * Similar to validateManifest but checks plugin-specific fields (name, version required).
 */
export function validatePluginManifest(manifest: PluginManifest): void {
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error('Plugin manifest must have a "name" string field');
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('Plugin manifest must have a "version" string field');
  }

  if (!manifest.handlers || typeof manifest.handlers !== 'object') {
    throw new Error('Plugin manifest must have a "handlers" object');
  }

  const seenIds = new Set<string>();

  for (const [eventName, handlers] of Object.entries(manifest.handlers)) {
    if (!HOOK_EVENTS.includes(eventName)) {
      throw new Error(`Unknown hook event: "${eventName}". Valid events: ${HOOK_EVENTS.join(', ')}`);
    }

    if (!Array.isArray(handlers)) {
      throw new Error(`Handlers for "${eventName}" must be an array`);
    }

    for (const handler of handlers as HandlerConfig[]) {
      if (!handler.id || typeof handler.id !== 'string') {
        throw new Error(`Each handler must have a string "id" (event: ${eventName})`);
      }

      if (seenIds.has(handler.id)) {
        throw new Error(`Duplicate handler id: "${handler.id}"`);
      }
      seenIds.add(handler.id);

      if (!handler.type || !['script', 'inline', 'llm'].includes(handler.type)) {
        throw new Error(`Handler "${handler.id}" must have type "script", "inline", or "llm"`);
      }

      if (handler.type === 'script' && !('command' in handler && handler.command)) {
        throw new Error(`Script handler "${handler.id}" must have a "command" field`);
      }

      if (handler.type === 'inline' && !('module' in handler && handler.module)) {
        throw new Error(`Inline handler "${handler.id}" must have a "module" field`);
      }

      if (handler.type === 'llm') {
        const llm = handler as import('./types.js').LLMHandlerConfig;
        if (!llm.model) {
          throw new Error(`LLM handler "${handler.id}" must have a "model" field`);
        }
        if (!llm.prompt) {
          throw new Error(`LLM handler "${handler.id}" must have a "prompt" field`);
        }
        const validModels = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'];
        if (!validModels.includes(llm.model)) {
          throw new Error(`LLM handler "${handler.id}" model must be one of: ${validModels.join(', ')}`);
        }
      }
    }
  }

  // Validate prefetch if present
  if (manifest.prefetch !== undefined) {
    if (!Array.isArray(manifest.prefetch)) {
      throw new Error('prefetch must be an array');
    }
    const validKeys = ['transcript', 'git_status', 'git_diff'];
    for (const key of manifest.prefetch) {
      if (!validKeys.includes(key)) {
        throw new Error(`Invalid prefetch key: "${key}". Valid keys: ${validKeys.join(', ')}`);
      }
    }
  }
}

/**
 * Load all installed plugins and return their manifests.
 */
export function loadPlugins(pluginsDir: string = PLUGINS_DIR, registryPath: string = PLUGIN_REGISTRY): { name: string; manifest: PluginManifest }[] {
  const registry = loadRegistry(registryPath);
  const results: { name: string; manifest: PluginManifest }[] = [];

  for (const plugin of registry.plugins) {
    const manifestPath = join(plugin.path, PLUGIN_MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      // Skip plugins with missing manifests (silently — doctor will catch this)
      continue;
    }

    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const parsed = parseYaml(raw) as PluginManifest;
      validatePluginManifest(parsed);
      results.push({ name: plugin.name, manifest: parsed });
    } catch {
      // Skip plugins with invalid manifests
      continue;
    }
  }

  return results;
}

/**
 * Namespace a handler ID with a plugin name.
 */
function namespaceId(pluginName: string, handlerId: string): string {
  return `${pluginName}/${handlerId}`;
}

/**
 * Merge user manifest + plugin manifests into a composite manifest.
 * Plugin handler IDs are namespaced as "pluginName/handlerId".
 * Prefetch keys are unioned.
 * Settings come from user manifest only.
 */
export function mergeManifests(userManifest: Manifest, plugins: { name: string; manifest: PluginManifest }[]): Manifest {
  // Deep clone user manifest handlers
  const merged: Manifest = {
    handlers: {},
    prefetch: userManifest.prefetch ? [...userManifest.prefetch] : undefined,
    settings: userManifest.settings,
  };

  // Copy user handlers
  for (const [event, handlers] of Object.entries(userManifest.handlers)) {
    if (handlers) {
      merged.handlers[event as HookEvent] = [...handlers];
    }
  }

  // Merge plugin handlers
  for (const { name: pluginName, manifest: pluginManifest } of plugins) {
    // Union prefetch keys
    if (pluginManifest.prefetch && pluginManifest.prefetch.length > 0) {
      if (!merged.prefetch) {
        merged.prefetch = [];
      }
      for (const key of pluginManifest.prefetch) {
        if (!merged.prefetch.includes(key)) {
          merged.prefetch.push(key);
        }
      }
    }

    // Namespace and add handlers
    for (const [event, handlers] of Object.entries(pluginManifest.handlers)) {
      if (!handlers) continue;
      const hookEvent = event as HookEvent;

      if (!merged.handlers[hookEvent]) {
        merged.handlers[hookEvent] = [];
      }

      for (const handler of handlers) {
        const namespacedHandler: HandlerConfig = {
          ...handler,
          id: namespaceId(pluginName, handler.id),
        };

        // Namespace depends references too
        if (namespacedHandler.depends) {
          namespacedHandler.depends = namespacedHandler.depends.map(dep =>
            // If the dep already contains a slash, it references another plugin — leave it
            dep.includes('/') ? dep : namespaceId(pluginName, dep)
          );
        }

        merged.handlers[hookEvent]!.push(namespacedHandler);
      }
    }
  }

  return merged;
}

/**
 * Install a plugin from a local directory path.
 * 1. Read clooks-plugin.yaml from the path
 * 2. Validate it
 * 3. Copy the directory to plugins dir under {name}/
 * 4. Register in installed.json
 * 5. Resolve $PLUGIN_DIR in handler commands to the installed path
 */
export function installPlugin(
  sourcePath: string,
  pluginsDir: string = PLUGINS_DIR,
  registryPath: string = PLUGIN_REGISTRY
): InstalledPlugin {
  const resolvedSource = resolvePath(sourcePath);
  const manifestPath = join(resolvedSource, PLUGIN_MANIFEST_NAME);

  if (!existsSync(manifestPath)) {
    throw new Error(`No ${PLUGIN_MANIFEST_NAME} found at ${resolvedSource}`);
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  const pluginManifest = parseYaml(raw) as PluginManifest;
  validatePluginManifest(pluginManifest);

  const destPath = join(pluginsDir, pluginManifest.name);

  // Ensure plugins dir exists
  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  // Remove existing installation if present
  if (existsSync(destPath)) {
    rmSync(destPath, { recursive: true, force: true });
  }

  // Copy plugin directory to plugins dir
  cpSync(resolvedSource, destPath, { recursive: true });

  // Resolve $PLUGIN_DIR in handler commands within the installed copy
  const installedManifestPath = join(destPath, PLUGIN_MANIFEST_NAME);
  const installedRaw = readFileSync(installedManifestPath, 'utf-8');
  const resolved = installedRaw.replace(/\$PLUGIN_DIR/g, destPath);
  writeFileSync(installedManifestPath, resolved, 'utf-8');

  // Update registry
  const registry = loadRegistry(registryPath);
  // Remove any existing entry for this plugin
  registry.plugins = registry.plugins.filter(p => p.name !== pluginManifest.name);

  const entry: InstalledPlugin = {
    name: pluginManifest.name,
    version: pluginManifest.version,
    path: destPath,
    installedAt: new Date().toISOString(),
  };
  registry.plugins.push(entry);
  saveRegistry(registry, registryPath);

  return entry;
}

/**
 * Uninstall a plugin by name.
 * 1. Remove from installed.json
 * 2. Delete the plugin directory
 */
export function uninstallPlugin(
  name: string,
  pluginsDir: string = PLUGINS_DIR,
  registryPath: string = PLUGIN_REGISTRY
): void {
  const registry = loadRegistry(registryPath);
  const plugin = registry.plugins.find(p => p.name === name);

  if (!plugin) {
    throw new Error(`Plugin "${name}" is not installed`);
  }

  // Remove from registry
  registry.plugins = registry.plugins.filter(p => p.name !== name);
  saveRegistry(registry, registryPath);

  // Delete plugin directory
  const pluginPath = join(pluginsDir, name);
  if (existsSync(pluginPath)) {
    rmSync(pluginPath, { recursive: true, force: true });
  }
}

/**
 * List installed plugins.
 */
export function listPlugins(registryPath: string = PLUGIN_REGISTRY): InstalledPlugin[] {
  const registry = loadRegistry(registryPath);
  return registry.plugins;
}
