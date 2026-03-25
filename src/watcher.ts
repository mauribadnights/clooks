// clooks file watcher — watch manifest.yaml for changes and hot-reload

import { watch, existsSync, mkdirSync, type FSWatcher } from 'fs';
import { dirname } from 'path';

type ReloadCallback = () => void;
type ErrorCallback = (err: Error) => void;

const DEBOUNCE_MS = 500;

export interface WatcherOptions {
  onReload: ReloadCallback;
  onError?: ErrorCallback;
}

/**
 * Watch manifest.yaml for changes.
 * Calls onReload when changes detected (debounced).
 * If the manifest file doesn't exist, watches the config directory for its creation.
 */
export function startWatcher(manifestPath: string, onReload: ReloadCallback, onError?: ErrorCallback): FSWatcher | null {
  let lastChange = 0;

  // If manifest exists, watch it directly
  if (existsSync(manifestPath)) {
    return watchFile(manifestPath, onReload, onError);
  }

  // Manifest doesn't exist — watch the config directory for its creation
  const configDir = dirname(manifestPath);
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      // Can't create config dir — give up
      if (onError) onError(new Error(`Cannot create config directory: ${configDir}`));
      return null;
    }
  }

  const baseName = manifestPath.split('/').pop() ?? manifestPath.split('\\').pop() ?? '';
  let dirWatcher: FSWatcher | null = null;

  try {
    dirWatcher = watch(configDir, (eventType, filename) => {
      if (filename !== baseName) return;
      if (!existsSync(manifestPath)) return;

      const now = Date.now();
      if (now - lastChange < DEBOUNCE_MS) return;
      lastChange = now;

      // Manifest appeared — close directory watcher, start file watcher
      try {
        dirWatcher?.close();
      } catch {
        // ignore
      }

      // Switch to watching the file directly
      const fileWatcher = watchFile(manifestPath, onReload, onError);
      if (fileWatcher) {
        // Copy the ref so stopWatcher can close it (caller still holds the dir watcher ref)
        // We can't replace the caller's reference, but the dir watcher is closed.
        // The onReload fires so the caller picks up the new manifest.
      }

      try {
        onReload();
      } catch (err) {
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    dirWatcher.on('error', (err) => {
      if (onError) onError(err);
    });

    return dirWatcher;
  } catch {
    if (onError) onError(new Error(`Failed to watch config directory: ${configDir}`));
    return null;
  }
}

/** Watch an existing file directly. */
function watchFile(filePath: string, onReload: ReloadCallback, onError?: ErrorCallback): FSWatcher | null {
  let lastChange = 0;

  try {
    const watcher = watch(filePath, (eventType) => {
      if (eventType !== 'change' && eventType !== 'rename') return;

      const now = Date.now();
      if (now - lastChange < DEBOUNCE_MS) return;
      lastChange = now;

      try {
        onReload();
      } catch (err) {
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    watcher.on('error', (err) => {
      if (onError) onError(err);
    });

    return watcher;
  } catch {
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
