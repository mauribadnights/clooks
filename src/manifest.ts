// clooks manifest parser (YAML hook definitions)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { MANIFEST_PATH, CONFIG_DIR, HOOKS_DIR, HOOK_EVENTS } from './constants.js';
import { loadPlugins, mergeManifests } from './plugin.js';
import { installBuiltinHooks } from './builtin-hooks.js';
import type { Manifest, HandlerConfig, HookEvent } from './types.js';

/**
 * Load and validate the manifest from disk.
 * Returns a Manifest with empty handlers if the file doesn't exist.
 */
export function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    return { handlers: {} };
  }

  const raw = readFileSync(MANIFEST_PATH, 'utf-8');
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== 'object') {
    return { handlers: {} };
  }

  const manifest = parsed as Manifest;
  validateManifest(manifest);
  return manifest;
}

/**
 * Validate a parsed manifest object.
 * Throws on invalid structure.
 */
export function validateManifest(manifest: Manifest): void {
  if (!manifest.handlers || typeof manifest.handlers !== 'object') {
    throw new Error('Manifest must have a "handlers" object');
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
        if (!llm.prompt) {
          throw new Error(`LLM handler "${handler.id}" must have a "prompt" field`);
        }

        // Validate backend
        const validBackends = ['api', 'claude-code'];
        if (llm.backend && !validBackends.includes(llm.backend)) {
          throw new Error(`LLM handler "${handler.id}" backend must be one of: ${validBackends.join(', ')}`);
        }

        // llmAgent is only valid with claude-code backend
        if (llm.llmAgent && llm.backend !== 'claude-code') {
          throw new Error(`LLM handler "${handler.id}" llmAgent requires backend: claude-code`);
        }

        // model is required for api backend, optional for claude-code
        if (llm.backend !== 'claude-code') {
          if (!llm.model) {
            throw new Error(`LLM handler "${handler.id}" must have a "model" field`);
          }
          const validModels = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'];
          if (!validModels.includes(llm.model)) {
            throw new Error(`LLM handler "${handler.id}" model must be one of: ${validModels.join(', ')}`);
          }
        } else if (llm.model) {
          // claude-code backend with explicit model — still validate it
          const validModels = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'];
          if (!validModels.includes(llm.model)) {
            throw new Error(`LLM handler "${handler.id}" model must be one of: ${validModels.join(', ')}`);
          }
        }

        // batchGroup is incompatible with claude-code backend
        if (llm.batchGroup && llm.backend === 'claude-code') {
          console.warn(`[clooks] Warning: LLM handler "${handler.id}" has batchGroup but uses claude-code backend — batching will be ignored`);
        }
      }

      // Validate async field type
      if ('async' in handler && typeof handler.async !== 'boolean') {
        throw new Error(`Handler "${handler.id}" async field must be a boolean`);
      }

      // Validate agent field type
      if ('agent' in handler && typeof (handler as unknown as { agent: unknown }).agent !== 'string') {
        throw new Error(`Handler "${handler.id}" agent field must be a string`);
      }

      // Validate project field type
      if ('project' in handler && typeof (handler as unknown as { project: unknown }).project !== 'string') {
        throw new Error(`Handler "${handler.id}" project field must be a string`);
      }
    }

    // Warn about async handlers with dependency relationships
    const eventHandlerIds = new Set((handlers as HandlerConfig[]).map(h => h.id));
    const dependedUponIds = new Set<string>();
    for (const h of handlers as HandlerConfig[]) {
      if (h.depends) {
        for (const dep of h.depends) {
          if (eventHandlerIds.has(dep)) dependedUponIds.add(dep);
        }
      }
    }
    for (const h of handlers as HandlerConfig[]) {
      if (h.async) {
        if (dependedUponIds.has(h.id)) {
          console.warn(`[clooks] Warning: async handler "${h.id}" has dependents — will run synchronously at runtime`);
        }
        if (h.depends?.some(d => eventHandlerIds.has(d))) {
          console.warn(`[clooks] Warning: async handler "${h.id}" has dependencies — will run synchronously at runtime`);
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

  // Validate settings if present
  if (manifest.settings) {
    if (manifest.settings.port !== undefined) {
      if (typeof manifest.settings.port !== 'number' || manifest.settings.port < 1 || manifest.settings.port > 65535) {
        throw new Error('settings.port must be a number between 1 and 65535');
      }
    }
    if (manifest.settings.logLevel !== undefined) {
      const validLevels = ['debug', 'info', 'warn', 'error'];
      if (!validLevels.includes(manifest.settings.logLevel)) {
        throw new Error(`settings.logLevel must be one of: ${validLevels.join(', ')}`);
      }
    }
  }
}

/**
 * Load the composite manifest: user manifest + all installed plugins.
 */
export function loadCompositeManifest(): Manifest {
  const userManifest = loadManifest();
  const plugins = loadPlugins();
  return mergeManifests(userManifest, plugins);
}

/**
 * Create a default commented example manifest.yaml in CONFIG_DIR.
 */
export function createDefaultManifest(authToken?: string): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const settings: Manifest['settings'] = {
    port: 7890,
    logLevel: 'info',
  };
  if (authToken) {
    settings.authToken = authToken;
  }

  // Install built-in hook scripts to CONFIG_DIR/hooks/
  installBuiltinHooks();

  const checkUpdatePath = join(HOOKS_DIR, 'check-update.js');

  const example: Manifest = {
    handlers: {
      SessionStart: [
        {
          id: 'clooks-check-update',
          type: 'script',
          command: `node ${checkUpdatePath}`,
          timeout: 6000,
          enabled: true,
        },
      ],
      PreToolUse: [
        {
          id: 'example-guard',
          type: 'script',
          command: 'echo \'{"additionalContext":"checked by clooks"}\'',
          timeout: 3000,
          enabled: true,
        },
      ],
    },
    settings,
  };

  const yamlStr =
    '# clooks manifest — define your hook handlers here\n' +
    '# Docs: https://github.com/mauribadnights/clooks\n' +
    '#\n' +
    '# Handler types:\n' +
    '#   script  — runs a shell command, pipes hook JSON to stdin, reads stdout\n' +
    '#   inline  — imports a JS/TS module and calls its default export\n' +
    '#\n' +
    '# Available events:\n' +
    '#   SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,\n' +
    '#   Stop, SubagentStart, SubagentStop, Notification, ConfigChange\n' +
    '#\n\n' +
    stringifyYaml(example);

  writeFileSync(MANIFEST_PATH, yamlStr, 'utf-8');
  return MANIFEST_PATH;
}
