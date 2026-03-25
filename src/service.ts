// clooks service management — cross-platform OS service installer/uninstaller

import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { CONFIG_DIR } from './constants.js';

/**
 * Find the clooks binary path by checking PATH or falling back to process.argv[1].
 */
function findClooksPath(): string {
  try {
    const cmd = platform() === 'win32' ? 'where clooks' : 'which clooks';
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
  } catch {
    // Fallback: resolve from current process
    return process.argv[1];
  }
}

// --- macOS (launchd) ---

const PLIST_LABEL = 'com.clooks.daemon';

function getPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function installMacOS(): void {
  const plistPath = getPlistPath();
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

  if (!existsSync(launchAgentsDir)) {
    mkdirSync(launchAgentsDir, { recursive: true });
  }

  const nodePath = process.execPath;
  const clooksPath = findClooksPath();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${clooksPath}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(CONFIG_DIR, 'daemon-stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(CONFIG_DIR, 'daemon-stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}</string>
  </dict>
</dict>
</plist>`;

  writeFileSync(plistPath, plist, 'utf-8');
  execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' });
}

function uninstallMacOS(): void {
  const plistPath = getPlistPath();
  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl unload ${plistPath}`, { stdio: 'pipe' });
    } catch {
      // May fail if not loaded — that's fine
    }
    unlinkSync(plistPath);
  }
}

function isInstalledMacOS(): boolean {
  return existsSync(getPlistPath());
}

// --- Linux (systemd user service) ---

const SYSTEMD_SERVICE_NAME = 'clooks';

function getSystemdServicePath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`);
}

function installLinux(): void {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(serviceDir, { recursive: true });
  const servicePath = getSystemdServicePath();

  const nodePath = process.execPath;
  const clooksPath = findClooksPath();

  const unit = `[Unit]
Description=clooks - Persistent hook runtime for Claude Code
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${clooksPath} start --foreground
Restart=always
RestartSec=3
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}

[Install]
WantedBy=default.target`;

  writeFileSync(servicePath, unit, 'utf-8');
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  execSync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  execSync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
}

function uninstallLinux(): void {
  try { execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' }); } catch { /* ignore */ }
  try { execSync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' }); } catch { /* ignore */ }
  const servicePath = getSystemdServicePath();
  if (existsSync(servicePath)) unlinkSync(servicePath);
  try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch { /* ignore */ }
}

function isInstalledLinux(): boolean {
  try {
    const result = execSync(`systemctl --user is-enabled ${SYSTEMD_SERVICE_NAME} 2>/dev/null`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim() === 'enabled';
  } catch {
    return false;
  }
}

// --- Windows (Task Scheduler) ---

const TASK_NAME = 'clooks';

function installWindows(): void {
  const nodePath = process.execPath;
  const clooksPath = findClooksPath();

  execSync(
    `schtasks /create /tn "${TASK_NAME}" /tr "\\"${nodePath}\\" \\"${clooksPath}\\" start --foreground" ` +
    `/sc onlogon /rl limited /f`,
    { stdio: 'pipe' },
  );
  // Start it now
  execSync(`schtasks /run /tn "${TASK_NAME}"`, { stdio: 'pipe' });
}

function uninstallWindows(): void {
  try { execSync(`schtasks /end /tn "${TASK_NAME}"`, { stdio: 'pipe' }); } catch { /* ignore */ }
  try { execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'pipe' }); } catch { /* ignore */ }
}

function isInstalledWindows(): boolean {
  try {
    execSync(`schtasks /query /tn "${TASK_NAME}" 2>nul`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// --- Public API ---

export type ServiceStatus = 'running' | 'stopped' | 'not-installed';

/**
 * Install clooks as an OS service (launchd on macOS, systemd on Linux, schtasks on Windows).
 */
export function installService(): void {
  const os = platform();
  if (os === 'darwin') installMacOS();
  else if (os === 'linux') installLinux();
  else if (os === 'win32') installWindows();
  else throw new Error(`Unsupported platform: ${os}`);
}

/**
 * Uninstall the clooks OS service.
 */
export function uninstallService(): void {
  const os = platform();
  if (os === 'darwin') uninstallMacOS();
  else if (os === 'linux') uninstallLinux();
  else if (os === 'win32') uninstallWindows();
  else throw new Error(`Unsupported platform: ${os}`);
}

/**
 * Check if the clooks OS service is installed.
 */
export function isServiceInstalled(): boolean {
  const os = platform();
  if (os === 'darwin') return isInstalledMacOS();
  else if (os === 'linux') return isInstalledLinux();
  else if (os === 'win32') return isInstalledWindows();
  return false;
}

/**
 * Get the current service status.
 */
export function getServiceStatus(): ServiceStatus {
  if (!isServiceInstalled()) return 'not-installed';

  const os = platform();
  try {
    if (os === 'darwin') {
      const result = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.includes('PID') ? 'running' : 'stopped';
    } else if (os === 'linux') {
      const result = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE_NAME} 2>/dev/null`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.trim() === 'active' ? 'running' : 'stopped';
    } else if (os === 'win32') {
      const result = execSync(`schtasks /query /tn "${TASK_NAME}" /fo csv 2>nul`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.includes('Running') ? 'running' : 'stopped';
    }
  } catch {
    // Fall through
  }
  return 'stopped';
}

// --- Exported helpers for testing ---

export { findClooksPath, getPlistPath, getSystemdServicePath, PLIST_LABEL, SYSTEMD_SERVICE_NAME, TASK_NAME };
