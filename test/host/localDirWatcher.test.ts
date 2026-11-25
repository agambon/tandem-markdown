// Direct parent-directory watcher for open notes (used on Linux to avoid recursive inotify gaps).

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDirWatcher } from '../../src/host/localDirWatcher';

function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const end = Date.now() + timeoutMs;
    const poll = () => {
      if (check()) return resolve(true);
      if (Date.now() >= end) return resolve(false);
      setTimeout(poll, 15);
    };
    poll();
  });
}

describe('LocalDirWatcher', () => {
  const dirs: string[] = [];
  const watchers: LocalDirWatcher[] = [];

  afterEach(() => {
    for (const w of watchers.splice(0)) w.dispose();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reports in-place and atomic-rename writes in a freshly created nested folder and ignores siblings', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tm-dir-watch-'));
    dirs.push(root);
    const nested = path.join(root, 'outer', 'inner');
    mkdirSync(nested, { recursive: true });
    const target = path.join(nested, 'Field notes.md');
    const sibling = path.join(nested, 'Other.md');
    writeFileSync(target, 'one\n');
    writeFileSync(sibling, 'a\n');

    const watcher = new LocalDirWatcher();
    watchers.push(watcher);
    let hits = 0;
    const stop = watcher.watch(target, () => hits++);
    expect(watcher.watchedDirCount()).toBe(1);

    // macOS FSEvents can deliver a coalesced event for the write made right before watch() attached.
    await new Promise((r) => setTimeout(r, 150));
    hits = 0;

    writeFileSync(sibling, 'b\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(hits).toBe(0);

    writeFileSync(target, 'two\n');
    expect(await waitUntil(() => hits >= 1)).toBe(true);

    const beforeRename = hits;
    const tmp = path.join(nested, '.Field notes.md.tmp');
    writeFileSync(tmp, 'three\n');
    renameSync(tmp, target);
    expect(await waitUntil(() => hits > beforeRename)).toBe(true);

    stop();
    expect(watcher.watchedDirCount()).toBe(0);
  });

  it('shares one directory watcher across multiple files in the same folder until all dispose', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tm-dir-share-'));
    dirs.push(root);
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');

    const watcher = new LocalDirWatcher();
    watchers.push(watcher);
    const stopA = watcher.watch(a, () => undefined);
    const stopB = watcher.watch(b, () => undefined);
    expect(watcher.watchedDirCount()).toBe(1);

    stopA();
    expect(watcher.watchedDirCount()).toBe(1);
    stopB();
    expect(watcher.watchedDirCount()).toBe(0);
  });

  it('degrades silently when the parent directory does not exist', () => {
    const watcher = new LocalDirWatcher();
    watchers.push(watcher);
    const stop = watcher.watch(path.join(os.tmpdir(), 'tm-missing-dir-does-not-exist-987654', 'note.md'), () => {
      throw new Error('should not fire');
    });
    expect(watcher.watchedDirCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
