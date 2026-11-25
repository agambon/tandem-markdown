// Before the first test: VS Code's file watcher reports changes in the workspace. VS Code starts
// watching the workspace some seconds after its window opens (in 1.146 later than the first
// tests run), and a file written before then is never reported, so a test that writes a note as
// another program does would wait for a change the extension is never told of.

import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { holdsWithin, note, workspaceDir } from './helpers';

/** A file only this check writes, in no form the extension opens. */
const PROBE = '.watcher-probe';
/** How many times the probe is written before the run gives up on VS Code's watcher. */
const PROBE_TRIES = 60;
/** How long each write of the probe is given to be reported. */
const PROBE_WAIT_MS = 1000;

/** Resolves once VS Code reports a write of the probe file; rejects after PROBE_TRIES writes. */
export async function watcherReady(): Promise<void> {
  const file = path.join(workspaceDir(), PROBE);
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${PROBE}`);
  let reported = false;
  const subscriptions = [watcher.onDidCreate(() => (reported = true)), watcher.onDidChange(() => (reported = true))];
  const started = Date.now();
  try {
    for (let tried = 1; !reported; tried++) {
      if (tried > PROBE_TRIES) throw new Error(`VS Code reported none of ${PROBE_TRIES} writes in the workspace`);
      writeFileSync(file, `write ${tried}\n`);
      await holdsWithin(PROBE_WAIT_MS, () => reported);
    }
    note(`VS Code reported a change in the workspace ${Date.now() - started} ms after the first write`);
  } finally {
    for (const s of subscriptions) s.dispose();
    watcher.dispose();
    rmSync(file, { force: true });
  }
}

/** The time the check may take: every write given its full wait. */
export const WATCHER_READY_MS = PROBE_TRIES * PROBE_WAIT_MS;
