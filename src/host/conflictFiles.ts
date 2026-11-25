// Conflict files: beside a note, `<name>.conflict`, written for the user or their agent whenever
// an outside change could not be settled automatically. Tracks open parts across edits, closes,
// renames, deletions, and restarts; settles parts when resolved; offers agent instructions once.

import * as vscode from 'vscode';
import { offerInstructions } from './agentInstructions';
import { type MovedBackup, NAMED_KEY, onDidChangeBackups } from './backups';
import { ConflictFileWriter, conflictFileOf } from './conflictFileWriter';
import { type WriteSeen, gitExplains, startGitExplains } from './gitExplains';
import { exists } from './localFiles';
import { log } from './log';
import { type PartFacts, type ProblemSpot, partTime } from './model/conflictFile';
import { CONFLICT_ENDING, isConflictName } from './model/conflictName';
import {
  type NoteFile,
  type StoredPart,
  closed,
  notWritten,
  reopened,
  samePart,
  settled,
  withPart,
  withPartAgain,
} from './model/conflictStore';
import { lineAfter, lineEditOf } from './model/lineEdits';
import { markdownScope } from './settings';
import { fileNameOf, sameFile } from './uris';

export type { StoredPart } from './model/conflictStore';

const CONFLICT_FILES_SETTING = 'conflictFiles';
const STATE_KEY = 'tandemMarkdown.conflictParts';
const OFFER_AFTER_MS = 2000;

export type Added = 'written' | 'none';

export interface NoteWarnings {
  noticeId: string | null;
  problems: readonly ProblemSpot[];
}

class ConflictFiles {
  private context: vscode.ExtensionContext | null = null;
  private readonly files = new Map<string, NoteFile>();
  private readonly writer = new ConflictFileWriter({
    fileOf: (note) => this.files.get(note) ?? null,
    vanished: (note, conflictFile) => this.cleared(note, conflictFile),
  });
  private readonly offerTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changes.event;

  start(context: vscode.ExtensionContext): vscode.Disposable {
    this.context = context;
    const watcher = vscode.workspace.createFileSystemWatcher(`**/*${CONFLICT_ENDING}`, true, true, false);
    const disposables = vscode.Disposable.from(
      watcher,
      watcher.onDidDelete((uri) => this.deleted(uri)),
      vscode.workspace.onDidOpenTextDocument((d) => this.opened(d.uri)),
      vscode.workspace.onDidCloseTextDocument((d) => this.closed(d.uri)),
      vscode.workspace.onDidChangeTextDocument((e) => this.edited(e)),
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) return;
        this.writer.retry();
        void this.dropDeletedNotes();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) this.renamed(f.oldUri, f.newUri);
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) this.notesDeleted(uri);
      }),
      onDidChangeBackups((change) => {
        if (change.moved) this.backupsMoved(change.moved);
      }),
      startGitExplains(),
      this.writer,
      this.changes,
      {
        dispose: () => {
          for (const timer of this.offerTimers) clearTimeout(timer);
          this.offerTimers.clear();
        },
      },
    );
    void this.load();
    return disposables;
  }

  async add(
    note: vscode.TextDocument,
    noticeId: string | null,
    facts: PartFacts,
    problems: ProblemSpot[],
    written: WriteSeen | null,
    backup: string | null = null,
  ): Promise<Added> {
    const uri = note.uri;
    if (!this.context) return 'none';
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const why = notWritten({
      scheme: uri.scheme,
      isConflictFile: isConflictName(uri.path),
      enabled: writesConflictFiles(uri),
      inFolder: folder !== undefined,
    });
    if (why !== null || !folder) return 'none';
    if (written !== null && (await gitExplains(uri, written))) {
      log('info', `${fileNameOf(uri)}: git has the file's new text, so no conflict file is written`);
      return 'none';
    }
    const key = uri.toString();
    const next = withPart(
      this.files.get(key),
      key,
      { noticeId, facts, problems, backup },
      partTime(new Date()),
      note.isClosed,
    );
    const stored = next.parts[next.parts.length - 1]!;
    this.files.set(key, next);
    if (!(await this.writer.write(uri))) {
      this.takeOut(key, stored);
      return 'none';
    }
    this.changed(uri);
    const timer = setTimeout(() => {
      this.offerTimers.delete(timer);
      if ([...this.files.values()].some((f) => f.parts.some((p) => samePart(p, stored)))) {
        void offerInstructions(folder);
      }
    }, OFFER_AFTER_MS);
    this.offerTimers.add(timer);
    return 'written';
  }

  async restore(note: vscode.TextDocument, stored: StoredPart): Promise<void> {
    const key = note.uri.toString();
    const next = withPartAgain(this.files.get(key), key, stored);
    const again = next.parts[next.parts.length - 1]!;
    this.files.set(key, next);
    if (await this.writer.write(note.uri)) this.changed(note.uri);
    else this.takeOut(key, again);
  }

  settle(noticeId: string): { note: vscode.Uri; stored: StoredPart } | null {
    for (const [key, file] of this.files) {
      const done = settled(file, noticeId);
      if (!done) continue;
      const note = vscode.Uri.parse(key);
      if (done.next === null) this.files.delete(key);
      else this.files.set(key, done.next);
      void this.writer.write(note);
      this.changed(note);
      return { note, stored: done.stored };
    }
    return null;
  }

  partsOf(note: vscode.Uri): readonly StoredPart[] {
    return this.files.get(note.toString())?.parts ?? [];
  }

  warningsOf(note: vscode.Uri): NoteWarnings[] {
    return (this.files.get(note.toString())?.parts ?? []).map((p) => ({
      noticeId: p.noticeId,
      problems: p.problems,
    }));
  }

  openFiles(): NoteFile[] {
    return [...this.files.values()].filter((f) => f.parts.length > 0);
  }

  async dropDeletedNotes(): Promise<void> {
    for (const key of [...this.files.keys()]) {
      const note = vscode.Uri.parse(key);
      if (note.scheme !== 'file') continue;
      if (!(await exists(note.fsPath)) && this.files.has(key)) this.notesDeleted(note);
    }
  }

  private takeOut(key: string, stored: StoredPart): void {
    const file = this.files.get(key);
    if (!file) return;
    const parts = file.parts.filter((p) => !samePart(p, stored));
    if (parts.length === 0) this.files.delete(key);
    else this.files.set(key, { ...file, parts });
    this.changed(vscode.Uri.parse(key));
  }

  private deleted(uri: vscode.Uri): void {
    const key = [...this.files.keys()].find((k) => sameFile(conflictFileOf(vscode.Uri.parse(k)), uri));
    if (this.writer.ownDeletion(uri)) {
      if (key !== undefined) this.writer.lookAgain(vscode.Uri.parse(key));
      return;
    }
    if (key !== undefined) this.cleared(key, uri);
  }

  private cleared(key: string, uri: vscode.Uri): void {
    this.files.delete(key);
    this.writer.forget(key);
    log('info', `${fileNameOf(uri)} was deleted: its parts are not written again`);
    this.changed(vscode.Uri.parse(key));
  }

  private keysUnder(uri: vscode.Uri): string[] {
    const at = uri.toString();
    return [...this.files.keys()].filter((k) => k === at || k.startsWith(`${at}/`));
  }

  private renamed(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const from = oldUri.toString();
    for (const key of this.keysUnder(oldUri)) {
      const before = vscode.Uri.parse(key);
      const moved = `${newUri.toString()}${key.slice(from.length)}`;
      const after = vscode.Uri.parse(moved);
      const file = this.files.get(key);
      this.files.delete(key);
      this.writer.forget(key);
      this.changes.fire(before);
      if (!file) continue;
      const open = vscode.workspace.textDocuments.some((d) => d.uri.toString() === moved && !d.isClosed);
      this.files.set(moved, { ...file, note: moved, closedAt: open ? null : file.closedAt });
      if (sameFile(before, after)) this.writer.moveCase(before, after);
      else this.writer.move(before, after);
      this.changed(after);
    }
  }

  private backupsMoved(moves: ReadonlyMap<string, MovedBackup>): void {
    let any = false;
    for (const [key, file] of this.files) {
      if (!file.parts.some((p) => p.backup && moves.has(p.backup))) continue;
      const parts = file.parts.map((p) => {
        const to = p.backup && moves.get(p.backup);
        return to ? { ...p, backup: to.path } : p;
      });
      this.files.set(key, { ...file, parts });
      any = true;
    }
    if (any) this.keep();
  }

  private notesDeleted(uri: vscode.Uri): void {
    for (const key of this.keysUnder(uri)) {
      this.files.delete(key);
      this.writer.forget(key);
      log(
        'info',
        `${fileNameOf(vscode.Uri.parse(key))} was deleted: its conflict file stays, and its parts are no longer counted`,
      );
      this.changed(vscode.Uri.parse(key));
    }
  }

  private closed(uri: vscode.Uri): void {
    const key = uri.toString();
    const file = this.files.get(key);
    if (!file) return;
    this.files.set(key, closed(file, partTime(new Date())));
    void this.writer.write(uri);
    this.changed(uri);
  }

  private opened(uri: vscode.Uri): void {
    const file = this.files.get(uri.toString());
    if (!file || file.closedAt === null) return;
    this.files.set(uri.toString(), reopened(file));
    void this.writer.write(uri);
    this.changed(uri);
  }

  private edited(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const file = this.files.get(key);
    if (!file || e.contentChanges.length === 0) return;
    const move = (spots: ProblemSpot[]) =>
      spots.map((s) => ({ ...s, line: lineAfter(s.line, e.contentChanges.map(lineEditOf), 'start') }));
    this.files.set(key, { ...file, parts: file.parts.map((p) => ({ ...p, problems: move(p.problems) })) });
    this.changes.fire(e.document.uri);
    this.keep();
  }

  private changed(note: vscode.Uri): void {
    this.keep();
    this.changes.fire(note);
  }

  private keep(): void {
    void Promise.resolve(this.context?.workspaceState.update(STATE_KEY, [...this.files.values()])).catch(
      (error: unknown) => log('warn', 'Could not keep the conflict files for the next session', error),
    );
    this.keepNamed();
  }

  private keepNamed(): void {
    const context = this.context;
    if (!context) return;
    const workspace = context.storageUri?.toString() ?? 'no workspace';
    const named = [
      ...new Set(
        [...this.files.values()].flatMap((f) =>
          f.parts.flatMap((p) => (p.backup ? [vscode.Uri.file(p.backup).toString()] : [])),
        ),
      ),
    ];
    const all = { ...(context.globalState.get<Record<string, string[]>>(NAMED_KEY) ?? {}) };
    if ((all[workspace] ?? []).join('\u0000') === named.join('\u0000')) return;
    if (named.length === 0) delete all[workspace];
    else all[workspace] = named;
    void Promise.resolve(context.globalState.update(NAMED_KEY, all)).catch((error: unknown) =>
      log('warn', 'Could not remember which backups conflict files name', error),
    );
  }

  private async load(): Promise<void> {
    const kept = this.context?.workspaceState.get<NoteFile[]>(STATE_KEY) ?? [];
    for (const stored of kept) {
      const note = vscode.Uri.parse(stored.note);
      if (!(await exists(conflictFileOf(note).fsPath))) continue;
      this.files.set(stored.note, stored);
      this.changes.fire(note);
    }
  }
}

function writesConflictFiles(note: vscode.Uri): boolean {
  return vscode.workspace
    .getConfiguration('tandemMarkdown', markdownScope(note))
    .get<boolean>(CONFLICT_FILES_SETTING, true);
}

export const conflictFiles = new ConflictFiles();
