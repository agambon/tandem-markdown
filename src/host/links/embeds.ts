// Embedded notes on the host side: answers a panel's `embedNotes` (src/host/links/notePreview.ts
// reads each note), and tells a panel `embedsChanged` when a note it embeds changes, on disk or
// in an editor, so the panel reads its embeds again. A note is watched for the panels that
// asked for it until they close.

import * as vscode from 'vscode';
import type { EmbedNotesResult } from '../../core/featureProtocol';
import { MARKDOWN_EXTENSIONS } from '../../core/fileKinds';
import { extensionsGlob } from '../model/glob';
import { panels, type HostPanel } from '../panels';
import { fileKey } from '../uris';
import { embedNote } from './notePreview';

/** How long after the last change to an embedded note the panels showing it are told. */
const CHANGE_DEBOUNCE_MS = 300;

export class EmbedWatch implements vscode.Disposable {
  /** The ids of the panels that embed each note, by the note's `fileKey`. */
  private readonly shownIn = new Map<string, Set<string>>();
  /** The panels to tell once the changes stop. */
  private readonly due = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(extensionsGlob(MARKDOWN_EXTENSIONS));
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => this.changed(uri)),
      watcher.onDidCreate((uri) => this.changed(uri)),
      watcher.onDidDelete((uri) => this.changed(uri)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.changed(e.document.uri);
      }),
    );
  }

  /**
   * What each of `targets` embedded in the note `from` shows, for `panel` (`from` is its note or
   * a note embedded in it; undefined when the request named none it may read). The notes found
   * are watched for the panel.
   */
  async answer(panel: HostPanel, from: vscode.Uri | undefined, targets: readonly string[]): Promise<EmbedNotesResult> {
    const out: EmbedNotesResult = Object.create(null);
    for (const target of targets) {
      if (!from) {
        out[target] = { reason: 'Not shown: the note it is in is outside the workspace folder.' };
        continue;
      }
      const { answer, uri } = await embedNote(from, target);
      out[target] = answer;
      if (!uri) continue;
      const key = fileKey(uri);
      const ids = this.shownIn.get(key) ?? new Set<string>();
      ids.add(panel.id);
      this.shownIn.set(key, ids);
    }
    return out;
  }

  private changed(uri: vscode.Uri): void {
    const ids = this.shownIn.get(fileKey(uri));
    if (!ids) return;
    for (const id of ids) this.due.add(id);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tell(), CHANGE_DEBOUNCE_MS);
  }

  private tell(): void {
    this.timer = null;
    const open = new Map(panels.all().map((p) => [p.id, p]));
    for (const id of this.due) {
      const panel = open.get(id);
      if (panel?.live) void panel.post({ type: 'embedsChanged' });
    }
    this.due.clear();
    // Panels that have closed watch nothing.
    for (const [key, ids] of this.shownIn) {
      for (const id of ids) if (!open.has(id)) ids.delete(id);
      if (ids.size === 0) this.shownIn.delete(key);
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
