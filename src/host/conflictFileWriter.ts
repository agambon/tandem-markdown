// A note's conflict file on disk (conflictFiles.ts keeps the parts it is written from): written
// whole, through a temporary name and a rename, from the parts as they stand when the write's
// turn comes, one write at a time per note; deleted with its last part; moved with its note. A
// deletion of the writer's own is told apart from anyone else's, and a moment after each write
// the file is looked for again, since VS Code's watcher can drop a deletion that follows a
// write. A write that failed is tried again on `retry`.

import { rename, rm } from 'node:fs/promises';
import * as vscode from 'vscode';
import { exists, isMissing, writeWhole } from './localFiles';
import { log } from './log';
import { conflictFileText } from './model/conflictFile';
import { conflictNameOf } from './model/conflictName';
import type { NoteFile } from './model/conflictStore';
import { fileNameOf } from './uris';

/** How long a deletion of this extension's own is waited for from the file watcher. */
const OWN_DELETE_MS = 10_000;
/**
 * How long after a write the file is looked for again. VS Code 1.120's file watcher gathers
 * events for 75 ms into one batch and drops a creation and a deletion of the same file in one
 * batch, so a deletion made just after a write of ours brings no event.
 */
const LOOK_AGAIN_MS = 1000;

export function conflictFileOf(note: vscode.Uri): vscode.Uri {
  return note.with({ path: conflictNameOf(note.path) });
}

/** What the writer reads and reports, by the note's uri as a string. */
export interface WriterSource {
  /** The note's parts now; null when it has none, and its file is deleted. */
  fileOf(note: string): NoteFile | null;
  /** The note's conflict file is gone though its last write went through: someone deleted it. */
  vanished(note: string, conflictFile: vscode.Uri): void;
}

export class ConflictFileWriter {
  /**
   * The deletion events this writer's deletes and renames will bring, by the exact uri the event
   * names (the old name, in its own letter case, for a rename that changes only the case): not the
   * user's or an agent's deletion. Each is taken by the one event it expects, and let go after
   * OWN_DELETE_MS, in case none comes; a deletion of the file under its new name is the user's.
   */
  private readonly ownDeletes = new Set<string>();
  /** Writes of one note's file, one after another. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** By note: the look, a moment after a write, for a deletion the watcher did not report. */
  private readonly lookAgainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Notes whose file on disk is behind their parts: its last write failed, and is tried again. */
  private readonly behind = new Set<string>();

  constructor(private readonly source: WriterSource) {}

  /**
   * Writes the note's conflict file from its parts as they stand when this write's turn comes,
   * after the writes queued before it (no parts: deletes it). False when it could not be written.
   */
  write(note: vscode.Uri): Promise<boolean> {
    const key = note.toString();
    return this.queued(note, async (): Promise<boolean> => {
      const file = this.source.fileOf(key);
      const written = await this.writeNow(note, file);
      if (written) this.behind.delete(key);
      else this.behind.add(key);
      if (written && file) this.lookAgainLater(note);
      return written;
    });
  }

  /** Writes again each file whose last write failed. */
  retry(): void {
    for (const key of [...this.behind]) void this.write(vscode.Uri.parse(key));
  }

  /** The note's file is written under its new name `after`, then the one under `before` is deleted. */
  move(before: vscode.Uri, after: vscode.Uri): void {
    void this.write(after).then((written) => {
      if (written) void this.queued(before, () => this.writeNow(before, null));
    });
  }

  /**
   * Only the letter case of the note's name changed, on a disk that ignores it: the old name and
   * the new are one file, so it is renamed in place, then written under its new name.
   */
  moveCase(before: vscode.Uri, after: vscode.Uri): void {
    void this.queued(before, () => this.renameInPlace(conflictFileOf(before), conflictFileOf(after))).then(() =>
      this.write(after),
    );
  }

  /** The note is no longer written for: a failed write of its file is not tried again. */
  forget(note: string): void {
    this.behind.delete(note);
  }

  /** True, once, for the watcher's deletion of `conflictFile` that this writer made. */
  ownDeletion(conflictFile: vscode.Uri): boolean {
    return this.ownDeletes.delete(conflictFile.toString());
  }

  /** Looks for the note's conflict file again, after the writes queued before. */
  lookAgain(note: vscode.Uri): void {
    void this.queued(note, () => this.look(note));
  }

  dispose(): void {
    for (const timer of this.lookAgainTimers.values()) clearTimeout(timer);
    this.lookAgainTimers.clear();
  }

  /** Looks for the note's conflict file again once a deletion just after this write would have been reported. */
  private lookAgainLater(note: vscode.Uri): void {
    const key = note.toString();
    clearTimeout(this.lookAgainTimers.get(key));
    this.lookAgainTimers.set(
      key,
      setTimeout(() => {
        this.lookAgainTimers.delete(key);
        this.lookAgain(note);
      }, LOOK_AGAIN_MS),
    );
  }

  /**
   * Run in the note's queue, after its writes: where the note has parts, its last write went
   * through and its conflict file is not on disk, someone deleted the file.
   */
  private async look(note: vscode.Uri): Promise<void> {
    const key = note.toString();
    if (this.source.fileOf(key) === null || this.behind.has(key)) return;
    const target = conflictFileOf(note);
    const there = await exists(target.fsPath);
    if (!there && this.source.fileOf(key) !== null && !this.behind.has(key)) this.source.vanished(key, target);
  }

  /**
   * Writes the note's conflict file whole (null: deletes it), through a temporary name and a
   * rename. False when it could not be written.
   */
  private async writeNow(note: vscode.Uri, file: NoteFile | null): Promise<boolean> {
    const target = conflictFileOf(note);
    try {
      if (file === null) {
        // Deleted only if still there (someone may have deleted it first), and known as our own.
        if (await exists(target.fsPath)) {
          this.markOwnDelete(target);
          await rm(target.fsPath, { force: true });
        }
        return true;
      }
      const text = conflictFileText({
        note: fileNameOf(note),
        closedAt: file.closedAt,
        parts: file.parts.map((p) => p.part),
      });
      await writeWhole(target.fsPath, text);
      return true;
    } catch (error) {
      log('warn', `Could not write ${target.fsPath}`, error);
      return false;
    }
  }

  /** Renames a conflict file to another letter case of its name, where it is there. */
  private async renameInPlace(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    if (from.fsPath === to.fsPath) return;
    this.markOwnDelete(from);
    await rename(from.fsPath, to.fsPath).catch((error: unknown) => {
      if (!isMissing(error)) log('warn', `Could not rename ${from.fsPath}`, error);
    });
  }

  /** A deletion (or a rename away) of this extension's own, which the watcher's event must not take for the user's. */
  private markOwnDelete(uri: vscode.Uri): void {
    const key = uri.toString();
    this.ownDeletes.add(key);
    setTimeout(() => this.ownDeletes.delete(key), OWN_DELETE_MS);
  }

  /** Runs `work` in the note's queue of writes. */
  private queued<T>(note: vscode.Uri, work: () => Promise<T>): Promise<T> {
    const key = note.toString();
    const done = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    this.queues.set(key, done);
    return done;
  }
}
