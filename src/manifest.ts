// clooks manifest parser (YAML hook definitions)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { MANIFEST_PATH, CONFIG_DIR, HOOK_EVENTS } from './constants.js';
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

  const example: Manifest = {
    handlers: {
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
