// The commands that act on the tab the user is in (the view commands, undo and redo, save,
// close), the log, the backup folder and Show Keyboard Shortcuts. The formatting, find, Open
// Link, Rename and Quick Fix commands are forwarded to the active panel as `{ type: 'command',
// id }`, where the panel's code runs them; Paste as Plain Text goes with the clipboard's text,
// read through VS Code, which a webview's page may not read itself. A feature registers its own
// commands with `registerCommand` (commandRegistration.ts).

import * as vscode from 'vscode';
import { backupFiles, backupFolder } from './backups';
import { backupViews } from './backupViews';
import { readCommandTitles, registerCommand } from './commandRegistration';
import { copyDiagnostics } from './diagnosticsReport';
import type { Documents } from './documents';
import { showLog } from './log';
import { openInRich, showView, switchView } from './modeSwitch';
import { registerPanelMessageHandler } from './panelMessages';
import { panels, type HostPanel } from './panels';
import { NOT_RUN } from './strings';
import { currentTab, isOurTab, panelOfTab, tabIn } from './tabs';

/** One of this extension's setting ids, as a panel may name it to `openSetting`. */
const OWN_SETTING = /^tandemMarkdown\.[A-Za-z0-9.]{1,100}$/;

/** Commands (after `tandemMarkdown.`) the panel runs: the host posts each to the active panel under the same id. */
const FORWARDED = [
  'toggleBold',
  'toggleItalic',
  'toggleStrikethrough',
  'toggleCode',
  'toggleHighlight',
  'insertLink',
  'headingUp',
  'headingDown',
  'toggleBulletList',
  'toggleNumberedList',
  'toggleTaskList',
  'toggleTask',
  'toggleQuote',
  'insertCodeBlock',
  'insertTable',
  'insertImage',
  'insertRule',
  'find',
  'replace',
  'openLink',
  'rename',
  'quickFix',
  'toggleFold',
  'foldAll',
  'unfoldAll',
] as const;

/** Registers the commands of this file, and reads every command's title for the failure messages. */
export function registerCommands(context: vscode.ExtensionContext, documents: Documents): vscode.Disposable {
  readCommandTitles(context.extension.packageJSON);
  const list: vscode.Disposable[] = [
    registerCommand('showSource', (uri) => showView(documents, 'source', uri)),
    // Show Source under the name of its button on a rich tab while chat has changes waiting in
    // the note: VS Code shows chat's keep-or-undo bar only in its text editor.
    registerCommand('reviewInSource', (uri) => showView(documents, 'source', uri)),
    registerCommand('showRichView', (uri) => showView(documents, 'view', uri)),
    registerCommand('showRichEditor', (uri) => showView(documents, 'edit', uri)),
    // The title bar's forms of the two, one drawn on rich tabs and one on every other tab (model/showButtons.ts).
    registerCommand('showRichViewOnRichTab', (uri) => showView(documents, 'view', uri, 'rich')),
    registerCommand('showRichViewOnSourceTab', (uri) => showView(documents, 'view', uri, 'source')),
    registerCommand('showRichEditorOnRichTab', (uri) => showView(documents, 'edit', uri, 'rich')),
    registerCommand('showRichEditorOnSourceTab', (uri) => showView(documents, 'edit', uri, 'source')),
    registerCommand('switchView', (uri) => switchView(documents, uri)),
    registerCommand('openInRichEditor', (uri) => openInRich(documents, uri, 'edit')),
    registerCommand('openInRichView', (uri) => openInRich(documents, uri, 'view')),
    registerCommand('undo', () => history(documents, 'undo')),
    registerCommand('redo', () => history(documents, 'redo')),
    registerCommand('save', () => save(documents)),
    registerCommand('close', () => close(documents)),
    registerCommand('showLog', () => showLog()),
    registerCommand('copyDiagnostics', () => copyDiagnostics(context)),
    // VS Code's Keyboard Shortcuts editor, searched for the extension's name.
    registerCommand('showKeys', () =>
      vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'Tandem Markdown'),
    ),
    registerCommand('openBackupFolder', () => openBackupFolder(context)),
    // Compare with Backup, the backups button, and every comparison of a backup (backupViews.ts).
    backupViews.start(context),
    registerCommand('revealHeading', (args) => {
      const p = panels.activePanel();
      if (p) void p.post({ type: 'command', id: 'revealHeading', args });
    }),
    registerCommand('pastePlain', async () => {
      const p = panels.activePanel();
      if (!p) return;
      const text = await vscode.env.clipboard.readText();
      if (!p.disposed) void p.post({ type: 'command', id: 'pastePlain', args: { text } });
    }),
    // A notice's button that opens one of this extension's settings (the size limit's "Change limit").
    registerPanelMessageHandler('openSetting', async (m) => {
      if (typeof m.id !== 'string' || !OWN_SETTING.test(m.id))
        throw new Error('openSetting needs one of our setting ids');
      await vscode.commands.executeCommand('workbench.action.openSettings', m.id);
    }),
    ...FORWARDED.map((id) =>
      registerCommand(id, (args) => {
        const p = panels.activePanel();
        if (p) void p.post(args === undefined ? { type: 'command', id } : { type: 'command', id, args });
      }),
    ),
  ];
  return vscode.Disposable.from(...list);
}

/** The panel of the tab the user is in; none when that is VS Code's text editor or another editor. */
function currentPanel(): HostPanel | undefined {
  const tab = currentTab();
  return tab ? panelOfTab(tab) : panels.activePanel();
}

/** The panel still exists and is still the active editor (VS Code's undo, save and close act on that). */
function stillActive(p: HostPanel): boolean {
  return !p.disposed && p.webviewPanel.active;
}

/**
 * Undo and redo from a panel. In a text field inside the panel they are the field's own (the
 * panel runs the browser's undo there); otherwise the coordinator flushes every panel and
 * runs VS Code's own undo or redo on the document, one at a time. VS Code's undo acts on
 * whatever has focus when it runs, after the flush and the wait for the lock: it runs only if
 * this panel is still the active editor then.
 */
async function history(documents: Documents, kind: 'undo' | 'redo'): Promise<void> {
  const p = currentPanel();
  if (!p) {
    await vscode.commands.executeCommand(kind);
    return;
  }
  if (p.focus.field) {
    void p.post({ type: 'command', id: kind === 'undo' ? 'fieldUndo' : 'fieldRedo' });
    return;
  }
  const tracked = documents.get(p.uri);
  if (!tracked) return;
  const result = await tracked.coordinator.undoRedo(kind, async () => {
    if (stillActive(p)) await vscode.commands.executeCommand(kind);
  });
  if (result === 'notClean') void vscode.window.showInformationMessage(NOT_RUN[kind]);
}

/**
 * Ctrl+S in a panel: send unsent typing, then save the document of the panel that took the
 * key. VS Code's own save (which acts on the active editor) while that panel is still active;
 * otherwise, after the wait, `document.save()` of its document.
 */
async function save(documents: Documents): Promise<void> {
  const p = currentPanel();
  if (!p) {
    await vscode.commands.executeCommand('workbench.action.files.save');
    return;
  }
  await documents.get(p.uri)?.coordinator.flushPanels([p.id]);
  if (stillActive(p)) await vscode.commands.executeCommand('workbench.action.files.save');
  else if (!p.document.isClosed) await p.document.save();
}

/** Ctrl+W and Ctrl+F4 in a panel: send unsent typing, then close the tab. */
async function close(documents: Documents): Promise<void> {
  const p = currentPanel();
  if (!p) {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    return;
  }
  const tracked = documents.get(p.uri);
  if (tracked && !(await tracked.coordinator.flushPanels([p.id]))) {
    void vscode.window.showInformationMessage(NOT_RUN.close);
    return;
  }
  // Closed with the mouse meanwhile: nothing left to close (and the webview can no longer be read).
  if (p.disposed) return;
  const column = p.webviewPanel.viewColumn;
  const tab = tabIn(column, p.uri, isOurTab);
  if (tab) await vscode.window.tabGroups.close(tab);
  else if (stillActive(p)) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

/** Open Backup Folder: the folder in the system's file manager, or a word that it holds no backups. */
async function openBackupFolder(context: vscode.ExtensionContext): Promise<void> {
  const folder = backupFolder(context.globalStorageUri);
  if ((await backupFiles(folder)).length === 0) {
    void vscode.window.showInformationMessage('The backup folder is empty.');
    return;
  }
  await vscode.env.openExternal(folder);
}
