// Switching views. The commands act on the tab the user is in, and a title bar button on the
// tab it is for (tabs.ts, `showTarget`), whatever editor it is: any editor that is not ours
// counts as Source. Rich view and Rich editor are one panel: switching between them
// is `setMode`. A switch never saves, never prompts and never closes a dirty tab.
//
//   Source to rich   the text editor's selection and top line are stored for the uri, then the
//                    tab is replaced in place with `reopenActiveEditorWith`. The new panel's
//                    `init` carries them. If that command is missing or does not replace the
//                    tab: `vscode.openWith`, then the old tab is closed only when it is not dirty.
//   Rich to Source   flush the panel; if it is not clean the switch is abandoned with a short
//                    message. Then, holding the document's lock, `reopenActiveEditorWith`
//                    TEXT_EDITOR; then the text editor gets the panel's selection and top line.

import * as vscode from 'vscode';
import { toLf } from '../core/eol';
import { plainNotice } from '../core/noticeText';
import { offsetOf, positionOf, textOf } from '../core/positions';
import { RICH_VIEW_NAME, type Mode, type ViewState } from '../core/protocol';
import { isReadOnly, type Documents } from './documents';
import { log } from './log';
import { documentText } from './model/documentText';
import { TEXT_EDITOR, VIEW_TYPE } from './model/editorIds';
import { richOffered } from './model/richOffered';
import type { DrawnOn } from './model/showButtons';
import { registerPanelMessageHandler } from './panelMessages';
import { panels, type HostPanel } from './panels';
import { defaultRichMode } from './settings';
import { NOT_RUN } from './strings';
import { currentTab, isOurTab, panelIn, panelOfTab, showTarget, tabIn, tabUri } from './tabs';
import { fileNameOf, movedUri, sameUri } from './uris';

/** Said when the Rich editor was asked for a note that can only be shown in Rich view. */
export function tellReadOnly(uri: vscode.Uri): void {
  void vscode.window.showInformationMessage(
    plainNotice(`${fileNameOf(uri)} is read-only, so it opened in Rich view instead of the Rich editor.`),
  );
}

const SHOW_SOURCE = 'Show Source';

/**
 * Said when a rich tab could not be opened, with Show Source, which opens the note in VS Code's
 * text editor in `column` (the active group when undefined).
 */
export function tellCouldNotOpen(uri: vscode.Uri, mode: Mode, column?: vscode.ViewColumn): void {
  const view = RICH_VIEW_NAME[mode];
  void vscode.window
    .showErrorMessage(plainNotice(`Could not open ${fileNameOf(uri)} in the ${view}.`), SHOW_SOURCE)
    .then((choice) => {
      if (choice !== SHOW_SOURCE) return;
      void Promise.resolve(
        vscode.commands.executeCommand('vscode.openWith', uri, TEXT_EDITOR, {
          ...(column !== undefined && { viewColumn: column }),
          preview: false,
        }),
      ).catch((error: unknown) => log('error', `Could not show ${uri.fsPath || uri.toString()} as Source`, error));
    });
}

/** How long a stored mode and view state wait for their panel to open. */
const PENDING_MS = 15_000;
/** How long a switch waits for the new editor to become active. */
const SWITCH_WAIT_MS = 3000;

interface PendingOpen {
  mode: Mode;
  viewState?: ViewState;
  at: number;
}

const pending = new Map<string, PendingOpen>();

/** Stores the mode and view state for the next panel that opens on this document. */
export function setPendingOpen(uri: vscode.Uri, mode: Mode, viewState?: ViewState): void {
  pending.set(uri.toString(), { mode, ...(viewState && { viewState: { ...viewState, mode } }), at: Date.now() });
}

/** Forgets what `setPendingOpen` stored, when no new panel took it. */
export function dropPendingOpen(uri: vscode.Uri): void {
  pending.delete(uri.toString());
}

/** The mode and view state stored for a panel that is opening on this document (consumed). */
export function takePendingOpen(uri: vscode.Uri): PendingOpen | undefined {
  const key = uri.toString();
  const p = pending.get(key);
  pending.delete(key);
  return p && Date.now() - p.at < PENDING_MS ? p : undefined;
}

export function registerModeSwitch(documents: Documents): vscode.Disposable {
  return vscode.Disposable.from(
    registerPanelMessageHandler('showSource', (_m, panel) => toSource(documents, panel)),
    registerPanelMessageHandler('switchView', (m, panel) => {
      const to = m.to;
      if (to !== 'source' && to !== 'view' && to !== 'edit') throw new Error(`switchView to "${String(to)}"`);
      return to === 'source' ? toSource(documents, panel) : setRichMode(panel, to);
    }),
    vscode.workspace.onWillRenameFiles((e) => willRename(e.files)),
    vscode.workspace.onDidRenameFiles((e) => void didRename(documents, e.files)),
  );
}

// ---------------------------------------------------------------------------
// The commands

/**
 * Show Source, Show Rich View, Show Rich Editor. `arg` is the uri VS Code passes from the title
 * bar, and `on` the tabs the title bar form clicked is drawn on (model/showButtons.ts); from the
 * palette or a key there is no uri, and the command acts on the tab the user is in.
 */
export async function showView(
  documents: Documents,
  target: 'source' | Mode,
  arg?: unknown,
  on?: DrawnOn,
): Promise<void> {
  const tab = arg instanceof vscode.Uri ? showTarget(target, arg, on) : currentTab();
  if (!tab) return;
  const uri = tabUri(tab);
  if (!uri || !offersRich(tab, uri)) return;
  const panel = panelOfTab(tab);
  if (panel) {
    if (target === 'source') return toSource(documents, panel);
    return setRichMode(panel, target);
  }
  if (target === 'source') {
    // Another extension's editor: Show Source opens VS Code's text editor in its place.
    if (tab.input instanceof vscode.TabInputCustom) await reopenAsText(tab, uri);
    return;
  }
  return toRich(documents, tab, uri, target);
}

/** Switch View: Source, then the first rich view (the setting), then the other, then Source. */
export async function switchView(documents: Documents, arg?: unknown): Promise<void> {
  const tab = targetTab(arg);
  if (!tab) return;
  const uri = tabUri(tab);
  if (!uri || !offersRich(tab, uri)) return;
  const panel = panelOfTab(tab);
  const readOnly = panel ? panel.readOnly : documentReadOnly(documents, uri);
  const first: Mode = readOnly ? 'view' : defaultRichMode(uri);
  const second: Mode = first === 'edit' ? 'view' : 'edit';
  if (!panel) return toRich(documents, tab, uri, first);
  if (panel.mode === first && !readOnly) return setRichMode(panel, second);
  return toSource(documents, panel);
}

/** Open in Rich Editor / Open in Rich View, from the Explorer. */
export async function openInRich(documents: Documents, arg: unknown, mode: Mode): Promise<void> {
  const uri = arg instanceof vscode.Uri ? arg : tabUri(currentTab());
  if (!uri) return;
  // VS Code opens the file in its active group.
  const group = vscode.window.tabGroups.activeTabGroup;
  const existing = panels.panelsFor(uri).find((p) => p.webviewPanel.viewColumn === group.viewColumn);
  if (existing) {
    existing.webviewPanel.reveal(existing.webviewPanel.viewColumn, false);
    await setRichMode(existing, mode);
    return;
  }
  if (mode === 'edit' && documentReadOnly(documents, uri)) {
    mode = 'view';
    tellReadOnly(uri);
  }
  setPendingOpen(uri, mode);
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
  } catch (error) {
    pending.delete(uri.toString());
    log('error', `Could not open ${uri.fsPath} in the rich editor`, error);
    tellCouldNotOpen(uri, mode);
  }
}

// ---------------------------------------------------------------------------
// The three moves

export async function setRichMode(panel: HostPanel, mode: Mode): Promise<void> {
  if (mode === 'edit' && panel.readOnly) {
    tellReadOnly(panel.uri);
    return;
  }
  if (panel.mode !== mode) panels.setMode(panel.id, mode);
}

/**
 * Source to rich, in place. The panel opens at `viewState` when given, else at the text
 * editor's selection and top line.
 */
async function toRich(
  documents: Documents,
  tab: vscode.Tab,
  uri: vscode.Uri,
  mode: Mode,
  viewState?: ViewState,
): Promise<void> {
  if (mode === 'edit' && documentReadOnly(documents, uri)) {
    mode = 'view';
    tellReadOnly(uri);
  }
  const key = uri.toString();
  const editor = textEditorForTab(tab, uri);
  setPendingOpen(uri, mode, viewState ?? (editor ? viewStateOf(editor, mode) : undefined));

  await activateTab(tab, uri);
  // The wait may have let the user move to another tab: `reopenActiveEditorWith` acts on
  // whatever is active, so it runs only while this file's tab still is.
  if (!activeTabShows(uri)) {
    pending.delete(key);
    return;
  }
  const before = new Set(panels.panelsFor(uri).map((p) => p.id));
  const column = tab.group.viewColumn;
  let replaced = false;
  try {
    await vscode.commands.executeCommand('reopenActiveEditorWith', VIEW_TYPE);
    replaced = await waitFor(() => !!panelIn(uri, column));
  } catch (error) {
    log('warn', 'reopenActiveEditorWith failed; opening with vscode.openWith instead', error);
  }
  if (!replaced) {
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: column, preview: false });
      if (await waitFor(() => !!panelIn(uri, column))) await closeIfClean(column, uri, (t) => !isOurTab(t));
    } catch (error) {
      pending.delete(key);
      log('error', `Could not open ${uri.fsPath} in the rich editor`, error);
      tellCouldNotOpen(uri, mode, column);
      return;
    }
  }
  // When the group already had our editor for this file, VS Code shows that one: set its mode.
  const p = panelIn(uri, column);
  if (p && before.has(p.id)) {
    pending.delete(key);
    await setRichMode(p, mode);
  }
}

/**
 * Rich to Source. Every wait (the flush, the reveal, the lock) can let the user move to
 * another tab or close this one, and `reopenActiveEditorWith` acts on whatever editor is active
 * when it runs: after each wait the panel must still exist and still be the active editor, or
 * the switch does nothing. (A panel that was not active when asked, such as from the title bar
 * of another group, is first made active.)
 */
async function toSource(documents: Documents, panel: HostPanel): Promise<void> {
  if (panel.disposed) return;
  const tracked = documents.get(panel.uri);
  if (!tracked) return;
  const wasActive = panel.webviewPanel.active;
  if (!(await tracked.coordinator.flushPanels([panel.id]))) {
    if (!panel.disposed) void vscode.window.showInformationMessage(NOT_RUN.source);
    return;
  }
  if (panel.disposed || (wasActive && !panel.webviewPanel.active)) return;
  const viewState = panel.viewState;
  const uri = panel.uri;
  const column = panel.webviewPanel.viewColumn;
  if (!panel.webviewPanel.active) {
    panel.webviewPanel.reveal(column, false);
    await waitFor(() => panel.disposed || panel.webviewPanel.active);
    if (panel.disposed || !panel.webviewPanel.active) return;
  }
  let ran = false;
  let replaced = false;
  try {
    await tracked.coordinator.runExclusive(async () => {
      // The lock may have been held by a save: check again before acting on the active editor.
      if (panel.disposed || !panel.webviewPanel.active) return;
      ran = true;
      await vscode.commands.executeCommand('reopenActiveEditorWith', TEXT_EDITOR);
    });
    if (!ran) return;
    replaced = await waitFor(() => !!activeTextEditorFor(uri, column));
  } catch (error) {
    log('warn', 'reopenActiveEditorWith failed; opening the text editor with vscode.openWith instead', error);
  }
  if (!ran) return;
  if (!replaced) {
    try {
      await vscode.window.showTextDocument(panel.document, {
        ...(column !== undefined && { viewColumn: column }),
        preview: false,
      });
      if (await waitFor(() => !!activeTextEditorFor(uri, column))) await closeIfClean(column, uri, isOurTab);
    } catch (error) {
      log('error', `Could not show ${uri.fsPath} as Source`, error);
      return;
    }
  }
  const editor = activeTextEditorFor(uri, column);
  if (editor && viewState) applyViewState(editor, viewState);
}

async function reopenAsText(tab: vscode.Tab, uri: vscode.Uri): Promise<void> {
  await activateTab(tab, uri);
  if (!activeTabShows(uri)) return;
  try {
    await vscode.commands.executeCommand('reopenActiveEditorWith', TEXT_EDITOR);
  } catch (error) {
    log('warn', 'reopenActiveEditorWith failed', error);
  }
}

// ---------------------------------------------------------------------------
// Renames
//
// A rename from inside VS Code (the Explorer, a workspace edit) closes the rich tab of each
// file under the renamed path, and VS Code 1.146 opens the file at its new path in its text
// editor in that tab's place. Each such tab is put back as a rich tab, in the view it was in.

interface MovingTab {
  /** The renamed path, as the rename event gives it. */
  from: string;
  /** The tab's file after the rename. */
  to: vscode.Uri;
  column: vscode.ViewColumn | undefined;
  mode: Mode;
  viewState: ViewState | undefined;
  at: number;
}

let moving: MovingTab[] = [];

function willRename(files: vscode.FileWillRenameEvent['files']): void {
  const now = Date.now();
  // A rename that fails is never reported again: its tabs are forgotten.
  moving = moving.filter((m) => now - m.at < PENDING_MS);
  for (const { oldUri, newUri } of files) {
    for (const p of panels.all()) {
      const to = movedUri(p.uri, oldUri, newUri);
      if (!to || !richOffered({ scheme: to.scheme, path: to.path })) continue;
      const tab: MovingTab = {
        from: oldUri.toString(),
        to,
        column: p.webviewPanel.viewColumn,
        mode: p.mode,
        viewState: p.viewState,
        at: now,
      };
      moving.push(tab);
      // Taken by the new panel when an editor association makes VS Code reopen the file in ours.
      setPendingOpen(to, tab.mode, tab.viewState);
    }
  }
}

async function didRename(documents: Documents, files: vscode.FileRenameEvent['files']): Promise<void> {
  const done = new Set(files.map((f) => f.oldUri.toString()));
  const back = moving.filter((m) => done.has(m.from));
  moving = moving.filter((m) => !done.has(m.from));
  for (const m of back) {
    // VS Code reopens the file after this event, in its text editor or (by an association) in ours.
    const textTab = () => tabIn(m.column, m.to, (t) => t.input instanceof vscode.TabInputText);
    if (!(await waitFor(() => !!textTab() || !!panelIn(m.to, m.column)))) continue;
    const tab = textTab();
    if (tab) await toRich(documents, tab, m.to, m.mode, m.viewState);
  }
}

// ---------------------------------------------------------------------------
// Tabs

/** The tab Switch View acts on: the tab the user is in, or for a uri given, a group's active tab showing it, the user's first. */
function targetTab(arg?: unknown): vscode.Tab | undefined {
  const active = currentTab();
  if (!(arg instanceof vscode.Uri)) return active;
  if (active && isTabOf(active, arg)) return active;
  return vscode.window.tabGroups.all.find((g) => g.activeTab && isTabOf(g.activeTab, arg))?.activeTab;
}

function isTabOf(tab: vscode.Tab, uri: vscode.Uri): boolean {
  const shown = tabUri(tab);
  return !!shown && sameUri(shown, uri);
}

/** Our tab, or a tab of a document the rich views are offered for (model/richOffered.ts). */
export function offersRich(tab: vscode.Tab, uri: vscode.Uri): boolean {
  if (isOurTab(tab)) return true;
  return richOffered({ scheme: uri.scheme, path: uri.path, languageId: openDocument(uri)?.languageId });
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => sameUri(d.uri, uri));
}

export function textEditorForTab(tab: vscode.Tab, uri: vscode.Uri): vscode.TextEditor | undefined {
  if (!(tab.input instanceof vscode.TabInputText)) return undefined;
  return vscode.window.visibleTextEditors.find(
    (e) => sameUri(e.document.uri, uri) && e.viewColumn === tab.group.viewColumn,
  );
}

/** The active tab of the active group, which `reopenActiveEditorWith` acts on, shows this file (in any editor). */
function activeTabShows(uri: vscode.Uri): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return !!tab && isTabOf(tab, uri);
}

function activeTextEditorFor(uri: vscode.Uri, column: vscode.ViewColumn | undefined): vscode.TextEditor | undefined {
  const e = vscode.window.activeTextEditor;
  return e && sameUri(e.document.uri, uri) && (column === undefined || e.viewColumn === column) ? e : undefined;
}

/** Makes the tab the active editor of the active group, so `reopenActiveEditorWith` acts on it. */
async function activateTab(tab: vscode.Tab, uri: vscode.Uri): Promise<void> {
  if (tab.group.isActive && tab.isActive) return;
  const column = tab.group.viewColumn;
  if (tab.input instanceof vscode.TabInputText) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false, preview: tab.isPreview });
  } else if (tab.input instanceof vscode.TabInputCustom) {
    await vscode.commands.executeCommand('vscode.openWith', uri, tab.input.viewType, {
      viewColumn: column,
      preserveFocus: false,
    });
  }
}

/** Closes the group's other tab for this file (the one being replaced) unless it is dirty. */
async function closeIfClean(
  column: vscode.ViewColumn | undefined,
  uri: vscode.Uri,
  which: (t: vscode.Tab) => boolean,
): Promise<void> {
  const old = tabIn(column, uri, which);
  if (!old) return;
  if (old.isDirty) {
    log('info', 'The old tab was left open because closing a dirty tab would ask to save');
    return;
  }
  await vscode.window.tabGroups.close(old, true);
}

export function documentReadOnly(documents: Documents, uri: vscode.Uri): boolean {
  const doc = openDocument(uri);
  if (doc) return documents.get(uri)?.readOnly ?? isReadOnly(doc);
  return uri.scheme !== 'file' && uri.scheme !== 'untitled';
}

// ---------------------------------------------------------------------------
// Cursor and scroll, carried both ways. Offsets are LF offsets; lines are zero-based.

export function viewStateOf(editor: vscode.TextEditor, mode: Mode): ViewState {
  const text = textOf(toLf(documentText(editor.document)));
  const sel = editor.selection;
  const anchor = offsetOf(text, sel.anchor.line, sel.anchor.character) ?? 0;
  const head = offsetOf(text, sel.active.line, sel.active.character) ?? anchor;
  const topLine = editor.visibleRanges[0]?.start.line ?? sel.active.line;
  return { selection: { anchor, head }, topLine, topOffsetPx: 0, mode };
}

/** Selects in the text editor what the view state selects, each offset kept inside the text. */
export function selectAsIn(editor: vscode.TextEditor, vs: ViewState): void {
  const text = textOf(toLf(documentText(editor.document)));
  const clamp = (n: number) => Math.max(0, Math.min(text.length, Math.floor(n)));
  const a = positionOf(text, clamp(vs.selection.anchor));
  const h = positionOf(text, clamp(vs.selection.head));
  editor.selection = new vscode.Selection(a.line, a.character, h.line, h.character);
}

function applyViewState(editor: vscode.TextEditor, vs: ViewState): void {
  selectAsIn(editor, vs);
  const top = Math.max(0, Math.min(editor.document.lineCount - 1, Math.floor(vs.topLine)));
  editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
}

// ---------------------------------------------------------------------------
// Waiting

/** Resolves true once `condition` holds, checked whenever an editor, tab or panel changes; false after SWITCH_WAIT_MS. */
function waitFor(condition: () => boolean): Promise<boolean> {
  if (condition()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const subs: vscode.Disposable[] = [];
    let finished = false;
    const done = (value: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const s of subs) s.dispose();
      resolve(value);
    };
    const check = () => {
      if (condition()) done(true);
    };
    subs.push(
      vscode.window.onDidChangeActiveTextEditor(check),
      vscode.window.tabGroups.onDidChangeTabs(check),
      panels.onDidChangePanels(check),
      panels.onDidChangeActivePanel(check),
    );
    const timer = setTimeout(() => done(condition()), SWITCH_WAIT_MS);
  });
}
