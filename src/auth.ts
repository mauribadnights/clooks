// clooks auth — token-based request authentication

import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { join } from 'path';
import { homedir } from 'os';
import { MANIFEST_PATH, DEFAULT_PORT } from './constants.js';
import type { Manifest } from './types.js';

/** Generate a random auth token (32 hex chars). */
export function generateAuthToken(): string {
  return randomBytes(16).toString('hex');
}

/** Validate an auth token from request headers. */
export function validateAuth(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return true; // No token configured = no auth required
  if (!authHeader) return false;

  // Support "Bearer <token>" format
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  // Constant-time comparison to prevent timing attacks
  if (token.length !== expectedToken.length) return false;
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(expectedToken);
  return timingSafeEqual(bufA, bufB);
}

/** Options for overriding default paths (used by tests). */
export interface RotateTokenOptions {
  manifestPath?: string;
  settingsDir?: string;
}

/**
 * Rotate the auth token:
 * 1. Generate new token
 * 2. Update manifest.yaml settings.authToken
 * 3. Update settings.json Authorization headers in HTTP hooks
 * Returns the new token.
 */
export function rotateToken(options?: RotateTokenOptions): string {
  const manifestPath = options?.manifestPath ?? MANIFEST_PATH;
  const home = options?.settingsDir ?? join(homedir(), '.claude');

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }

  const newToken = generateAuthToken();

  // Update manifest
  const manifestRaw = readFileSync(manifestPath, 'utf-8');
  const manifest = parseYaml(manifestRaw) as Manifest;
  if (!manifest.settings) {
    manifest.settings = {};
  }
  manifest.settings.authToken = newToken;

  // Preserve comments at the top by only replacing the YAML body portion
  const yamlBody = stringifyYaml(manifest);
  // Check if there's a comment header to preserve
  const lines = manifestRaw.split('\n');
  const commentLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') {
      commentLines.push(line);
    } else {
      break;
    }
  }
  const header = commentLines.length > 0 ? commentLines.join('\n') + '\n' : '';
  writeFileSync(manifestPath, header + yamlBody, 'utf-8');

  // Update settings.json Authorization headers
  const settingsCandidates = [
    join(home, 'settings.local.json'),
    join(home, 'settings.json'),
  ];

  for (const settingsPath of settingsCandidates) {
    if (!existsSync(settingsPath)) continue;

    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      if (!settings.hooks || typeof settings.hooks !== 'object') continue;

      let updated = false;
      for (const ruleGroups of Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ type: string; url?: string; headers?: Record<string, string> }> }>>)) {
        if (!Array.isArray(ruleGroups)) continue;
        for (const rule of ruleGroups) {
          if (!Array.isArray(rule.hooks)) continue;
          for (const hook of rule.hooks) {
            if (hook.type === 'http' && hook.url?.includes(`localhost:`)) {
              if (!hook.headers) hook.headers = {};
              hook.headers['Authorization'] = `Bearer ${newToken}`;
              updated = true;
            }
          }
        }
      }

      if (updated) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return newToken;
}
