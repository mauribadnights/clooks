#!/usr/bin/env node

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
    // Output as additionalContext so it's injected into Claude's context
    const msg = `[clooks] Update available: ${current} \u2192 ${latest}. Run: clooks update`;
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
