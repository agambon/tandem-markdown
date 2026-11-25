// One DocumentCoordinator per open markdown document, its three ports, and VS Code's events
// forwarded to it. The host decides nothing about text here.
//
// Which documents get a coordinator: every open markdown document with scheme 'file', from the
// moment it opens, with a reconciler; and any other document opened in our editor (`ensure`): a
// `.txt` file with a reconciler too, anything else with none, read-only unless its scheme is
// 'file' or 'untitled'. A coordinator is told the moment its document closes and goes with it:
// VS Code would apply an edit sent to a closed document's uri to a fresh copy of the file. A
// language change arrives as a close and then an open of the same document object, and is not a
// close: a note whose outside changes are merged keeps its coordinator, and one that had none
// gains one, its panels moving to it. An outside change waits while the user may be typing in
// another extension's rich editor (model/outsideHold.ts).

import * as vscode from 'vscode';
import {
  documentEditRanges,
  DocumentCoordinator,
  type DiskPort,
  type DocumentPort,
  type FaultRecord,
  type InitFields,
  type UiPort,
} from '../core/coordinator';
import { isMarkdownPath, MARKDOWN_EXTENSIONS } from '../core/fileKinds';
import { plainNotice } from '../core/noticeText';
import { systemSchedule, type HostToPanel } from '../core/protocol';
import { backupFolder, deleteBackup, writeBackup } from './backups';
import { log } from './log';
import { isConflictName } from './model/conflictName';
import { documentText } from './model/documentText';
import { onFileReadsWarning, readFileBytes, statFile, stopFileReads } from './model/fileReads';
import { extensionsGlob } from './model/glob';
import { languageReloadMessage } from './model/languageReload';
import { holdsOutsideChange } from './model/outsideHold';
import { isTextFileName } from './model/richOffered';
import { timestamp } from './model/timestamp';
import { noticesClosed, showCoreNotice } from './notices';
import { whenBothChanged } from './settings';
import { otherRichEditorActive } from './tabs';
import { encodingOf, fileNameOf, logPrefixOf, movedUri, sameFile } from './uris';

/**
 * A close event for a document that is not closed (a language change) is followed at once by
 * its open; should that open not come, the coordinator goes after this long.
 */
const DOCUMENT_LINGER_MS = 2000;

/** What the documents need from the panel registry (panels.ts implements it). */
export interface PanelHost {
  /** Posts to the panel; a post that fails is reported to the panel's coordinator. */
  post(panelId: string, message: HostToPanel): void;
  initFields(panelId: string, reason: 'open' | 'resync'): InitFields;
  /** Sets the panel's HTML again so its page starts fresh. */
  reloadPanel(panelId: string): void;
  /** The ids of the panels showing this document. */
  panelIdsFor(key: string): string[];
}

interface TrackedDocument {
  readonly document: vscode.TextDocument;
  /** `document.uri.toString()`. */
  readonly key: string;
  readonly coordinator: DocumentCoordinator;
  readonly readOnly: boolean;
  /** Outside changes to the file are checked and merged (scheme `file`: markdown, or `.txt` shown in our editor). */
  readonly reconciled: boolean;
}

interface Entry extends TrackedDocument {
  disposeTimer: NodeJS.Timeout | null;
  /** A watcher for this file alone, when the workspace watcher does not cover it. */
  watcher: vscode.Disposable | null;
  disposed: boolean;
  /** `performance.now()` at the document's last content change (or when it was first tracked). */
  lastChange: number;
}

const WORKSPACE_GLOB = extensionsGlob(MARKDOWN_EXTENSIONS);

/** The workspaceState key that holds the stamp of the base of the document at `uri`. */
function rememberedBaseKey(uri: string): string {
  return `base:${uri}`;
}

export class Documents implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Documents whose remembered base was copied to a new path, by key, with the path being renamed. */
  private readonly movedBases = new Map<string, vscode.Uri>();
  /** For the in-VS-Code tests: the window's focus as the outside-change hold sees it; undefined reads VS Code's. */
  windowFocusForTests: boolean | undefined = undefined;
  /** How many edits the user asked for from a panel are being applied, by document key. */
  private readonly userEdits = new Map<string, number>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panels: PanelHost,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(WORKSPACE_GLOB);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.diskEvent(uri)),
      watcher.onDidChange((uri) => this.diskEvent(uri)),
      watcher.onDidDelete((uri) => this.diskEvent(uri)),
      vscode.workspace.onDidOpenTextDocument((d) => this.opened(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.closed(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.contentChanged(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.willSave(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.entryOf(d)?.coordinator.didSave()),
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused) return;
        for (const e of this.entries.values()) if (!e.disposed && !e.document.isClosed) e.coordinator.windowFocused();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        for (const e of this.entries.values()) this.updateWatcher(e);
      }),
      vscode.workspace.onWillRenameFiles((e) => this.willRename(e.files)),
      vscode.workspace.onDidRenameFiles((e) => this.didRename(e.files)),
    );
    onFileReadsWarning((message, detail) => log('warn', message, detail));
    for (const d of vscode.workspace.textDocuments) this.opened(d);
  }

  /** The coordinator's record for a document, if it has one. */
  get(uri: vscode.Uri | string): TrackedDocument | undefined {
    const e = this.entries.get(typeof uri === 'string' ? uri : uri.toString());
    return e && !e.disposed ? e : undefined;
  }

  all(): TrackedDocument[] {
    return [...this.entries.values()].filter((e) => !e.disposed);
  }

  /** For our editor: the document's coordinator, created now if it has none (any language or scheme). */
  ensure(document: vscode.TextDocument): TrackedDocument {
    const existing = this.entries.get(document.uri.toString());
    if (existing && existing.document === document && !existing.disposed) {
      if (existing.disposeTimer && !document.isClosed) this.cancelDispose(existing);
      return existing;
    }
    if (existing) this.disposeEntry(existing);
    return this.track(document, isReconciled(document, true));
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) this.disposeEntry(e);
    for (const d of this.disposables) d.dispose();
    stopFileReads();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  private opened(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.entries.get(key);
    if (existing && existing.document === document && !document.isClosed) {
      // A language change: VS Code reports it as a close followed by an open of the same object.
      this.languageChanged(existing);
      return;
    }
    if (!isReconciled(document)) return;
    if (existing) this.disposeEntry(existing);
    this.track(document, true);
  }

  private closed(document: vscode.TextDocument): void {
    const e = this.entryOf(document);
    if (!e) return;
    if (document.isClosed) {
      // A real close. VS Code applies an edit sent to a closed document's uri to a fresh copy
      // of the file, with no version check, so the coordinator is told at once and goes: it
      // reads, merges, retries and applies nothing more, and accepts no push.
      e.coordinator.documentClosed();
      this.disposeEntry(e);
      return;
    }
    // A language change: VS Code reports it as a close and then an open of the same document
    // object, which is not closed. The open (languageChanged) cancels this.
    if (e.disposeTimer) return;
    e.disposeTimer = setTimeout(() => {
      e.disposeTimer = null;
      if (this.entries.get(e.key) === e) this.disposeEntry(e);
    }, DOCUMENT_LINGER_MS);
  }

  private languageChanged(e: Entry): void {
    this.cancelDispose(e);
    // A change of language mode is not a close: a note whose outside changes are merged
    // keeps its coordinator, and with it what it holds of the file (versions waiting, backups a
    // message names), until the note itself closes. Only a note that had none gains one.
    if (e.reconciled) return;
    const panelIds = this.panels.panelIdsFor(e.key);
    if (!isReconciled(e.document, panelIds.length > 0)) return;
    void this.replace(e, panelIds);
  }

  /**
   * The document became one whose outside changes are merged: a new coordinator, and the panels
   * start again on it. Their unsent typing is sent first; a flush that does not come back clean is
   * tried once more after the gate is free. If it is still not clean the panels are reloaded
   * anyway, and the user is told what they had just typed was lost.
   */
  private async replace(old: Entry, panelIds: string[]): Promise<void> {
    log('info', `${old.document.uri.fsPath || old.key} changed language; its panels are reloaded`);
    let clean = await old.coordinator.flushPanels();
    if (!clean && this.entries.get(old.key) === old && !old.disposed) {
      await old.coordinator.runExclusive(() => Promise.resolve());
      clean = await old.coordinator.flushPanels();
    }
    if (this.entries.get(old.key) !== old || old.disposed) return;
    this.disposeEntry(old);
    const next = this.track(old.document, true);
    for (const id of panelIds) {
      next.coordinator.panelAttached(id);
      this.panels.reloadPanel(id);
    }
    if (!clean) {
      const name = fileNameOf(old.document.uri);
      log('warn', `${name}: a panel's last edit had not been sent when the language changed`);
      // The message that a language change lost typing: the tab's page starts again, and nothing
      // hands its unsent typing to the host first, so the typing is not shown, and the message says
      // it may have been lost.
      void vscode.window.showWarningMessage(plainNotice(languageReloadMessage(name, panelIds.length)));
    }
  }

  private track(document: vscode.TextDocument, reconciled: boolean): Entry {
    const key = document.uri.toString();
    const readOnly = isReadOnly(document);
    // The UI port needs the coordinator, which is created with the UI port: the port reads it
    // through `holder` once both exist.
    const holder: { entry: Entry | null } = { entry: null };
    const coordinator = new DocumentCoordinator({
      document: documentPort(document),
      disk: reconciled ? diskPort(document, this.context) : null,
      ui: this.uiPort(document, () => holder.entry!.coordinator),
      schedule: systemSchedule,
      key,
      fileName: fileNameOf(document.uri) || key,
      readOnly,
      whenBothChanged: () => whenBothChanged(document.uri),
      debug: (message) => log('trace', `${logPrefixOf(document.uri)}${message}`),
      holdOutside: () => this.holdsOutside(holder.entry!),
    });
    const entry: Entry = {
      document,
      key,
      coordinator,
      readOnly,
      reconciled,
      disposeTimer: null,
      watcher: null,
      disposed: false,
      lastChange: performance.now(),
    };
    holder.entry = entry;
    this.entries.set(key, entry);
    this.updateWatcher(entry);
    return entry;
  }

  private cancelDispose(e: Entry): void {
    if (e.disposeTimer) clearTimeout(e.disposeTimer);
    e.disposeTimer = null;
  }

  private disposeEntry(e: Entry): void {
    if (e.disposed) return;
    e.disposed = true;
    this.cancelDispose(e);
    e.watcher?.dispose();
    e.watcher = null;
    e.coordinator.dispose();
    noticesClosed(e.key);
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
  }

  private entryOf(document: vscode.TextDocument): Entry | undefined {
    const e = this.entries.get(document.uri.toString());
    return e && e.document === document && !e.disposed ? e : undefined;
  }

  /** Whether an outside change to the document must wait (src/host/model/outsideHold.ts). */
  private holdsOutside(e: Entry): boolean {
    return holdsOutsideChange({
      otherRichEditorActive: otherRichEditorActive(e.document.uri),
      windowFocused: this.windowFocusForTests ?? vscode.window.state.focused,
      sinceChangeMs: performance.now() - e.lastChange,
    });
  }

  // ---------------------------------------------------------------------------
  // Events

  /**
   * Runs `apply`, which has VS Code apply an edit the user asked for from a panel (a rename, a
   * quick fix), so that its changes to the document at `uri` are not taken for another
   * program's. Their change events arrive before `apply` resolves (see "What VS Code is
   * assumed to do", 2).
   */
  async applyUserEdit<T>(uri: vscode.Uri, apply: () => Thenable<T>): Promise<T> {
    const key = uri.toString();
    this.userEdits.set(key, (this.userEdits.get(key) ?? 0) + 1);
    try {
      return await apply();
    } finally {
      const left = (this.userEdits.get(key) ?? 1) - 1;
      if (left > 0) this.userEdits.set(key, left);
      else this.userEdits.delete(key);
    }
  }

  private contentChanged(event: vscode.TextDocumentChangeEvent): void {
    const e = this.entryOf(event.document);
    if (!e) return;
    if (event.contentChanges.length > 0) e.lastChange = performance.now();
    // 'outside' is a hint for the panels (they mark what changed): the change is not an undo
    // or redo, nobody is typing in a text editor of this document, and it is not an edit the
    // user asked for from a panel. The core recognizes its own edits (a panel's typing, a
    // merge) before it looks at the reason, so those never carry it.
    const reason =
      event.reason === vscode.TextDocumentChangeReason.Undo
        ? ('undo' as const)
        : event.reason === vscode.TextDocumentChangeReason.Redo
          ? ('redo' as const)
          : vscode.window.activeTextEditor?.document !== event.document && !this.userEdits.has(e.key)
            ? ('outside' as const)
            : undefined;
    // Read inside the handler, synchronously: the document may change again before anything later runs.
    const change = {
      text: documentText(event.document),
      changes: event.contentChanges,
      dirty: event.document.isDirty,
      ...(reason ? { reason } : {}),
    };
    e.coordinator.documentChanged(change);
  }

  private willSave(event: vscode.TextDocumentWillSaveEvent): void {
    const e = this.entryOf(event.document);
    if (!e || !e.reconciled) return;
    // It never rejects, resolves within the reconciler's limit (WILL_SAVE_LIMIT_MS) and returns no edits.
    event.waitUntil(e.coordinator.willSave());
  }

  private diskEvent(uri: vscode.Uri): void {
    const key = uri.toString();
    // The watcher and the document may spell the path differently (drive letter, case on Windows).
    const e = this.entries.get(key) ?? [...this.entries.values()].find((x) => sameFile(x.document.uri, uri));
    if (e && !e.disposed && e.reconciled && !e.document.isClosed) e.coordinator.diskChanged();
  }

  /**
   * A rename from inside VS Code closes each document under the renamed path and opens one at
   * the new path holding the same text. Its remembered base goes with it, so the new
   * document's first read finds the file its text was based on, not an outside version.
   */
  private willRename(files: vscode.FileWillRenameEvent['files']): void {
    const state = this.context.workspaceState;
    for (const { oldUri, newUri } of files) {
      for (const e of this.entries.values()) {
        const to = movedUri(e.document.uri, oldUri, newUri);
        const base: unknown = state.get(rememberedBaseKey(e.key));
        if (!to || base === undefined) continue;
        void state.update(rememberedBaseKey(to.toString()), base);
        this.movedBases.set(e.key, oldUri);
      }
    }
  }

  /** The renames that happened: the remembered bases left at the old paths go. */
  private didRename(files: vscode.FileRenameEvent['files']): void {
    const done = new Set(files.map((f) => f.oldUri.toString()));
    for (const [key, from] of this.movedBases) {
      if (!done.has(from.toString())) continue;
      void this.context.workspaceState.update(rememberedBaseKey(key), undefined);
      this.movedBases.delete(key);
    }
  }

  /** A file the workspace watcher does not see gets a watcher of its own. */
  private updateWatcher(e: Entry): void {
    const needs = e.reconciled && !e.disposed && !coveredByWorkspaceWatcher(e.document.uri);
    if (needs && !e.watcher) {
      const uri = e.document.uri;
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), fileNameOf(uri)),
      );
      const on = () => this.diskEvent(uri);
      const subs = [w.onDidCreate(on), w.onDidChange(on), w.onDidDelete(on)];
      e.watcher = { dispose: () => [...subs, w].forEach((d) => d.dispose()) };
    } else if (!needs && e.watcher) {
      e.watcher.dispose();
      e.watcher = null;
    }
  }

  // ---------------------------------------------------------------------------
  // The UI port

  private uiPort(document: vscode.TextDocument, coordinator: () => DocumentCoordinator): UiPort {
    const state = this.context.workspaceState;
    return {
      postToPanel: (panelId, message) => this.panels.post(panelId, message),
      initFields: (panelId, reason) => this.panels.initFields(panelId, reason),
      notify: (notice) =>
        showCoreNotice(notice, { document, coordinator, reopened: () => this.get(document.uri)?.coordinator }),
      log: (level, message, detail) => log(level, `${logPrefixOf(document.uri)}${message}`, detail),
      dumpFault: (record) => void this.dumpFault(document, record),
      reloadPanel: (panelId) => this.panels.reloadPanel(panelId),
      remember: (key, value) => void state.update(rememberedBaseKey(key), value),
      recall: (key) => state.get(rememberedBaseKey(key)),
    };
  }

  private async dumpFault(document: vscode.TextDocument, record: FaultRecord): Promise<void> {
    try {
      const folder = vscode.Uri.joinPath(this.context.logUri, 'faults');
      await vscode.workspace.fs.createDirectory(folder);
      const stem = `${timestamp(new Date())}-${record.panelId.replace(/[^\w.-]/g, '_')}`;
      const encoder = new TextEncoder();
      const host = vscode.Uri.joinPath(folder, `${stem}-document.md`);
      await vscode.workspace.fs.writeFile(host, encoder.encode(record.hostText));
      let panel: vscode.Uri | null = null;
      if (record.panelText !== undefined) {
        panel = vscode.Uri.joinPath(folder, `${stem}-panel.md`);
        await vscode.workspace.fs.writeFile(panel, encoder.encode(record.panelText));
      }
      log(
        'error',
        `${logPrefixOf(document.uri)}panel fault (${record.kind}) written to ${host.fsPath}${panel ? ` and ${panel.fsPath}` : ''}`,
        record.detail,
      );
    } catch (error) {
      log('error', 'Could not write the fault record', error);
    }
  }
}

// ---------------------------------------------------------------------------
// The two other ports

function documentPort(document: vscode.TextDocument): DocumentPort {
  return {
    getText: () => documentText(document),
    isDirty: () => document.isDirty,
    encoding: () => encodingOf(document),
    applyEdit: (edit) => {
      // Never to a closed document: VS Code would load the file afresh and apply these ranges
      // to it with no version check (the coordinator stops at the close; this is the backstop).
      if (document.isClosed) {
        log('warn', 'An edit for a closed document was refused');
        return Promise.resolve(false);
      }
      // Built and sent synchronously: the ranges are positions in the document as it is now,
      // and VS Code refuses the edit if the document moves before it arrives.
      try {
        const we = new vscode.WorkspaceEdit();
        for (const r of documentEditRanges(edit)) {
          we.replace(
            document.uri,
            new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character),
            r.text,
          );
        }
        return Promise.resolve(vscode.workspace.applyEdit(we)).then(
          (ok) => ok === true,
          (error: unknown) => {
            log('warn', 'workspace.applyEdit threw; treated as refused', error);
            return false;
          },
        );
      } catch (error) {
        log('warn', 'Could not build the edit; treated as refused', error);
        return Promise.resolve(false);
      }
    },
  };
}

/** The file of a document whose scheme is `file` (only those are reconciled). */
function diskPort(document: vscode.TextDocument, context: vscode.ExtensionContext): DiskPort {
  const uri = document.uri;
  const fileName = fileNameOf(uri);
  return {
    stat: () => statFile(uri.fsPath),
    read: () => readFileBytes(uri.fsPath),
    backup: (bytes, label) =>
      writeBackup(backupFolder(context.globalStorageUri), fileName, uri.toString(), bytes, label),
    deleteBackup: (p) => deleteBackup(p),
    readBackup: async (p) => {
      try {
        return await vscode.workspace.fs.readFile(vscode.Uri.file(p));
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Kinds of document

/**
 * Outside changes are merged into a markdown file, and into a `.txt` file shown in our editor;
 * never into a conflict file, which is not a note even where VS Code reads it as markdown.
 */
function isReconciled(document: vscode.TextDocument, shownInOurEditor = false): boolean {
  if (document.uri.scheme !== 'file' || isConflictName(document.uri.path)) return false;
  return document.languageId === 'markdown' || (shownInOurEditor && isTextFileName(document.uri.path));
}

/**
 * Read-only: a scheme other than `file` and `untitled` (a git revision, a virtual document),
 * or a file system VS Code says is not writable. `workspace.fs.stat` reports
 * `FilePermission.Readonly` only for such file systems (in VS Code 1.146 a local file with the
 * read-only attribute reports no permissions); VS Code's own editor leaves that file editable
 * and handles its save, and so do we.
 */
export function isReadOnly(document: vscode.TextDocument): boolean {
  const scheme = document.uri.scheme;
  if (scheme === 'untitled') return false;
  if (scheme !== 'file') return true;
  return vscode.workspace.fs.isWritableFileSystem(scheme) === false;
}

function coveredByWorkspaceWatcher(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && isMarkdownPath(uri.path) && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}
