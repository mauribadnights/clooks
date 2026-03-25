// clooks agent — auto-install the clooks expert agent to ~/.claude/agents/

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const AGENT_SOURCE = join(__dirname, '..', 'agents', 'clooks.md');
const AGENT_DEST_DIR = join(homedir(), '.claude', 'agents');
const AGENT_DEST = join(AGENT_DEST_DIR, 'clooks.md');

/**
 * Install/update the clooks agent to ~/.claude/agents/clooks.md.
 * Returns true if installed/updated, false if already up to date.
 */
export function installAgent(): boolean {
  // Read source agent from package
  let source: string;
  try {
    source = readFileSync(AGENT_SOURCE, 'utf-8');
  } catch {
    return false; // Agent file not found in package
  }

  // Check if already installed and identical
  if (existsSync(AGENT_DEST)) {
    const existing = readFileSync(AGENT_DEST, 'utf-8');
    if (existing === source) return false; // Already up to date
  }

  // Install/update
  if (!existsSync(AGENT_DEST_DIR)) {
    mkdirSync(AGENT_DEST_DIR, { recursive: true });
  }
  writeFileSync(AGENT_DEST, source, 'utf-8');
  return true;
}

/**
 * Check if the clooks agent is installed.
 */
export function isAgentInstalled(): boolean {
  return existsSync(AGENT_DEST);
}
