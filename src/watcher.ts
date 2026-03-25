// clooks file watcher — watch manifest.yaml for changes and hot-reload

import { watch, type FSWatcher } from 'fs';

type ReloadCallback = () => void;

const DEBOUNCE_MS = 500;

/**
 * Watch manifest.yaml for changes.
 * Calls onReload when changes detected (debounced).
 */
export function startWatcher(manifestPath: string, onReload: ReloadCallback): FSWatcher | null {
  let lastChange = 0;

  try {
    const watcher = watch(manifestPath, (eventType) => {
      if (eventType !== 'change' && eventType !== 'rename') return;

      const now = Date.now();
      if (now - lastChange < DEBOUNCE_MS) return;
      lastChange = now;

      try {
        onReload();
      } catch {
        // Reload errors are non-fatal — the old manifest stays active
      }
    });

    watcher.on('error', () => {
      // Silently ignore watch errors (e.g., file deleted)
    });

    return watcher;
  } catch {
    // ENOENT or other errors — file may not exist yet
    return null;
  }
}

/**
 * Stop watching for file changes.
 */
export function stopWatcher(watcher: FSWatcher | null): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // Ignore close errors
    }
  }
}
