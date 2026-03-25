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

  it('watches directory when manifest file does not exist', () => {
    // When the manifest file doesn't exist, startWatcher now watches the parent dir
    // and returns a watcher (not null)
    const watcher = startWatcher(join(tmpDir, 'nonexistent.yaml'), () => {});
    expect(watcher).not.toBeNull();
    stopWatcher(watcher);
  });

  it('calls onReload when manifest is created in watched directory', async () => {
    const filePath = join(tmpDir, 'manifest.yaml');

    let reloadCount = 0;
    const watcher = startWatcher(filePath, () => {
      reloadCount++;
    });

    expect(watcher).not.toBeNull();

    // Create the manifest file after the watcher started
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(filePath, 'handlers: {}');

    // Wait for the directory watcher to detect creation
    await new Promise((r) => setTimeout(r, 700));

    expect(reloadCount).toBeGreaterThanOrEqual(1);

    stopWatcher(watcher);
  });

  it('calls onError callback on watcher errors', () => {
    const filePath = join(tmpDir, 'manifest.yaml');
    writeFileSync(filePath, 'initial');

    const errors: Error[] = [];
    const watcher = startWatcher(
      filePath,
      () => {},
      (err) => { errors.push(err); },
    );

    expect(watcher).not.toBeNull();

    // Emit an error on the watcher
    watcher!.emit('error', new Error('test error'));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('test error');

    stopWatcher(watcher);
  });

  it('calls onError when reload callback throws', async () => {
    const filePath = join(tmpDir, 'manifest.yaml');
    writeFileSync(filePath, 'initial');

    const errors: Error[] = [];
    const watcher = startWatcher(
      filePath,
      () => { throw new Error('reload boom'); },
      (err) => { errors.push(err); },
    );

    // Trigger a file change
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(filePath, 'changed');
    await new Promise((r) => setTimeout(r, 700));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('reload boom');

    stopWatcher(watcher);
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
