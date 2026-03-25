import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWatcher, stopWatcher } from '../src/watcher.js';

describe('watcher', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-watcher-'));
    expect(tmpDir).toContain(tmpdir());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls onReload when watched file changes', async () => {
    const filePath = join(tmpDir, 'manifest.yaml');
    writeFileSync(filePath, 'initial content');

    let reloadCount = 0;
    const watcher = startWatcher(filePath, () => {
      reloadCount++;
    });

    expect(watcher).not.toBeNull();

    // Modify the file
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(filePath, 'changed content');

    // Wait for the watcher to fire
    await new Promise((r) => setTimeout(r, 700));

    expect(reloadCount).toBeGreaterThanOrEqual(1);

    stopWatcher(watcher);
  });

  it('debounces rapid changes', async () => {
    const filePath = join(tmpDir, 'manifest.yaml');
    writeFileSync(filePath, 'initial');

    let reloadCount = 0;
    const watcher = startWatcher(filePath, () => {
      reloadCount++;
    });

    // Rapid writes within debounce window
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(filePath, 'change1');
    writeFileSync(filePath, 'change2');
    writeFileSync(filePath, 'change3');

    await new Promise((r) => setTimeout(r, 700));

    // Should be debounced to 1 (or at most a small number, not 3)
    expect(reloadCount).toBeLessThanOrEqual(2);
    expect(reloadCount).toBeGreaterThanOrEqual(1);

    stopWatcher(watcher);
  });

  it('returns null for non-existent file', () => {
    const watcher = startWatcher(join(tmpDir, 'nonexistent.yaml'), () => {});
    expect(watcher).toBeNull();
  });

  it('stopWatcher handles null gracefully', () => {
    expect(() => stopWatcher(null)).not.toThrow();
  });

  it('stopWatcher stops watching', async () => {
    const filePath = join(tmpDir, 'manifest.yaml');
    writeFileSync(filePath, 'initial');

    let reloadCount = 0;
    const watcher = startWatcher(filePath, () => {
      reloadCount++;
    });

    stopWatcher(watcher);

    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(filePath, 'should not trigger');
    await new Promise((r) => setTimeout(r, 700));

    expect(reloadCount).toBe(0);
  });
});
