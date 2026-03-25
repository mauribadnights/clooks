import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

// Mock child_process.execSync before importing the module
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock fs functions to prevent actual filesystem operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { execSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import {
  installService,
  uninstallService,
  isServiceInstalled,
  getServiceStatus,
  findClooksPath,
  getPlistPath,
  getSystemdServicePath,
  PLIST_LABEL,
  SYSTEMD_SERVICE_NAME,
  TASK_NAME,
} from '../src/service.js';

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

describe('service path helpers', () => {
  it('getPlistPath returns correct macOS plist path', () => {
    const expected = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
    expect(getPlistPath()).toBe(expected);
  });

  it('getSystemdServicePath returns correct Linux service path', () => {
    const expected = join(homedir(), '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`);
    expect(getSystemdServicePath()).toBe(expected);
  });

  it('PLIST_LABEL is com.clooks.daemon', () => {
    expect(PLIST_LABEL).toBe('com.clooks.daemon');
  });

  it('SYSTEMD_SERVICE_NAME is clooks', () => {
    expect(SYSTEMD_SERVICE_NAME).toBe('clooks');
  });

  it('TASK_NAME is clooks', () => {
    expect(TASK_NAME).toBe('clooks');
  });
});

describe('findClooksPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result from which command when available', () => {
    mockedExecSync.mockReturnValueOnce('/usr/local/bin/clooks');
    const result = findClooksPath();
    expect(result).toBe('/usr/local/bin/clooks');
  });

  it('falls back to process.argv[1] when which fails', () => {
    mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
    const result = findClooksPath();
    expect(result).toBe(process.argv[1]);
  });

  it('takes only first line if which returns multiple paths', () => {
    mockedExecSync.mockReturnValueOnce('/usr/local/bin/clooks\n/opt/bin/clooks\n');
    const result = findClooksPath();
    expect(result).toBe('/usr/local/bin/clooks');
  });
});

describe('platform detection', () => {
  // These tests verify the public API dispatches correctly based on platform.
  // We can't easily change os.platform() at runtime, so we test the current platform.

  const currentPlatform = process.platform;

  describe('isServiceInstalled', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    if (currentPlatform === 'darwin') {
      it('checks plist existence on macOS', () => {
        mockedExistsSync.mockReturnValue(false);
        const result = isServiceInstalled();
        expect(result).toBe(false);
        expect(mockedExistsSync).toHaveBeenCalledWith(getPlistPath());
      });

      it('returns true when plist exists on macOS', () => {
        mockedExistsSync.mockReturnValue(true);
        const result = isServiceInstalled();
        expect(result).toBe(true);
      });
    }

    if (currentPlatform === 'linux') {
      it('checks systemctl is-enabled on Linux', () => {
        mockedExecSync.mockReturnValue('enabled\n');
        const result = isServiceInstalled();
        expect(result).toBe(true);
      });

      it('returns false when systemctl fails on Linux', () => {
        mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
        const result = isServiceInstalled();
        expect(result).toBe(false);
      });
    }
  });

  describe('getServiceStatus', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns not-installed when service is not installed', () => {
      // Make isServiceInstalled return false
      if (currentPlatform === 'darwin') {
        mockedExistsSync.mockReturnValue(false);
      } else if (currentPlatform === 'linux') {
        mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
      } else if (currentPlatform === 'win32') {
        mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
      }

      const result = getServiceStatus();
      expect(result).toBe('not-installed');
    });

    if (currentPlatform === 'darwin') {
      it('returns running when launchctl shows PID on macOS', () => {
        // isServiceInstalled check
        mockedExistsSync.mockReturnValue(true);
        // getServiceStatus launchctl list call
        mockedExecSync.mockReturnValue('"PID" = 12345;\n"Label" = "com.clooks.daemon";\n');
        const result = getServiceStatus();
        expect(result).toBe('running');
      });

      it('returns stopped when launchctl shows no PID on macOS', () => {
        mockedExistsSync.mockReturnValue(true);
        mockedExecSync.mockReturnValue('"Label" = "com.clooks.daemon";\n');
        const result = getServiceStatus();
        expect(result).toBe('stopped');
      });
    }
  });

  describe('installService', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    if (currentPlatform === 'darwin') {
      it('writes plist and calls launchctl load on macOS', () => {
        mockedExistsSync.mockReturnValue(true); // LaunchAgents dir exists
        mockedExecSync.mockReturnValue('/usr/local/bin/clooks'); // findClooksPath
        // Second call is launchctl load
        installService();
        expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
        const writtenPath = mockedWriteFileSync.mock.calls[0][0];
        expect(writtenPath).toBe(getPlistPath());

        // Verify plist content has required keys
        const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;
        expect(plistContent).toContain('com.clooks.daemon');
        expect(plistContent).toContain('KeepAlive');
        expect(plistContent).toContain('RunAtLoad');
        expect(plistContent).toContain('--foreground');
      });
    }

    if (currentPlatform === 'linux') {
      it('writes unit file and enables via systemctl on Linux', () => {
        mockedExecSync.mockReturnValue('/usr/local/bin/clooks');
        installService();
        expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
        const writtenPath = mockedWriteFileSync.mock.calls[0][0];
        expect(writtenPath).toBe(getSystemdServicePath());

        // Verify unit content
        const unitContent = mockedWriteFileSync.mock.calls[0][1] as string;
        expect(unitContent).toContain('[Unit]');
        expect(unitContent).toContain('[Service]');
        expect(unitContent).toContain('[Install]');
        expect(unitContent).toContain('Restart=always');
        expect(unitContent).toContain('--foreground');
      });
    }
  });

  describe('uninstallService', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    if (currentPlatform === 'darwin') {
      it('calls launchctl unload and removes plist on macOS', () => {
        mockedExistsSync.mockReturnValue(true);
        uninstallService();
        expect(mockedExecSync).toHaveBeenCalled();
        expect(mockedUnlinkSync).toHaveBeenCalledWith(getPlistPath());
      });

      it('is a no-op when plist does not exist on macOS', () => {
        mockedExistsSync.mockReturnValue(false);
        uninstallService();
        expect(mockedUnlinkSync).not.toHaveBeenCalled();
      });
    }
  });
});
