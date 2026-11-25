// Refcounted non-recursive directory watcher backed by Node's `fs.watch` (inotify on Linux).
// Used on Linux alongside VS Code's workspace watcher so newly created nested folders and
// watcher-excluded directories still report edits to open notes immediately.

import { type FSWatcher, watch as fsWatch } from 'node:fs';
import * as path from 'node:path';

interface Listener {
  readonly name: string;
  readonly onChange: () => void;
}

interface DirWatch {
  readonly watcher: FSWatcher;
  readonly listeners: Set<Listener>;
}

export class LocalDirWatcher {
  private readonly dirs = new Map<string, DirWatch>();

  /** Watches `filePath` via its parent directory and returns a disposer. Degrades silently if watching fails. */
  watch(filePath: string, onChange: () => void): () => void {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    if (!dir || !name) return () => undefined;

    let entry = this.dirs.get(dir);
    if (!entry) {
      let watcher: FSWatcher;
      try {
        watcher = fsWatch(dir, { persistent: false }, (_event, changed) => {
          const current = this.dirs.get(dir);
          if (!current) return;
          const changedName = changed === null || changed === undefined ? null : String(changed);
          for (const listener of [...current.listeners]) {
            if (changedName === null || changedName === listener.name) listener.onChange();
          }
        });
      } catch {
        return () => undefined;
      }
      entry = { watcher, listeners: new Set() };
      const owned = entry;
      watcher.on('error', () => {
        if (this.dirs.get(dir) === owned) this.dirs.delete(dir);
        try {
          watcher.close();
        } catch {
          // already closed
        }
      });
      this.dirs.set(dir, entry);
    }

    const listener: Listener = { name, onChange };
    entry.listeners.add(listener);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.dirs.get(dir);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        this.dirs.delete(dir);
        try {
          current.watcher.close();
        } catch {
          // already closed
        }
      }
    };
  }

  /** Number of parent directories currently watched (for tests). */
  watchedDirCount(): number {
    return this.dirs.size;
  }

  dispose(): void {
    for (const { watcher } of this.dirs.values()) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.dirs.clear();
  }
}
