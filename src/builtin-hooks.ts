// clooks built-in hook scripts — written to CONFIG_DIR/hooks/ during init/migrate

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HOOKS_DIR } from './constants.js';

/**
 * Content of the check-update.js hook script.
 * Kept as a constant so it can be written to disk during init/migrate
 * without depending on the npm package install path.
 */
export const CHECK_UPDATE_SCRIPT = `#!/usr/bin/env node

// clooks built-in: check for updates on session start
// Runs in background, non-blocking. Injects a notice if update available.

const { execSync } = require('child_process');

try {
  // Get installed version
  const pkgPath = require.resolve('@mauribadnights/clooks/package.json');
  const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'));
  const current = pkg.version;

  // Check npm (with short timeout to not block session start)
  const latest = execSync('npm view @mauribadnights/clooks version 2>/dev/null', {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  if (latest && latest !== current && isNewer(latest, current)) {
    const msg = \`[clooks] Update available: \${current} \\u2192 \${latest}. Run: clooks update\`;
    process.stdout.write(JSON.stringify({ additionalContext: msg }));
  }
} catch {
  // Silently fail — update checks should never block sessions
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
`;

/**
 * Ensure the built-in hooks directory exists and write/update the check-update script.
 * Safe to call multiple times — overwrites with the latest version.
 */
export function installBuiltinHooks(): void {
  if (!existsSync(HOOKS_DIR)) {
    mkdirSync(HOOKS_DIR, { recursive: true });
  }

  const checkUpdatePath = join(HOOKS_DIR, 'check-update.js');

  // Only overwrite if content differs (avoids unnecessary writes)
  if (existsSync(checkUpdatePath)) {
    const existing = readFileSync(checkUpdatePath, 'utf-8');
    if (existing === CHECK_UPDATE_SCRIPT) return;
  }

  writeFileSync(checkUpdatePath, CHECK_UPDATE_SCRIPT, { mode: 0o755 });
}
