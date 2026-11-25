// Bridges the core's structured CoreNotice events to VS Code: formats every message through
// model/messageForms.ts, routes user-facing messages through messages.ts (tab-top strip,
// one-at-a-time queue, diff title-bar buttons), writes `.conflict` files via conflictFiles.ts,
// and manages status-bar read/save-check warnings.

import * as vscode from 'vscode';
import type { CoreNotice, DocumentCoordinator, PutBackResult } from '../core/coordinator';
import { toLf } from '../core/eol';
import { noticeArrived, warningWritten } from './announce';
import { backupViews } from './backupViews';
import { type StoredPart, conflictFiles } from './conflictFiles';
import { log } from './log';
import { messages } from './messages';
import type { BackupKind } from './model/backupNames';
import { type VersionName, conflictVersionName } from './model/backupViews';
import { partForNotice } from './model/conflictFile';
import { documentText } from './model/documentText';
import { VIEW_TYPE } from './model/editorIds';
import {
  actionRejectedText,
  appliedText,
  closedWithPendingText,
  conflictText,
  messageForm,
  readFailedTooltip,
  saveCheckOffText,
  summarizeNotice,
  typingAtCloseText,
  typingNotBackText,
} from './model/messageForms';
import { STATUS_PRIORITY } from './statusPlaces';
import { encodingOf, fileNameOf } from './uris';

interface NoticeTarget {
  document: vscode.TextDocument;
  coordinator: () => DocumentCoordinator;
  /** Coordinator of the note reopened after `document` closed, if open again. */
  reopened?: () => DocumentCoordinator | undefined;
}

type Kept = { backupPath: string } | { text: string; kind: BackupKind } | null;

/** Test mode only: every notice raised, in order. */
const raised: { notice: CoreNotice; uri: string; at: number }[] = [];
let keeping = false;
let saveCheckItem: vscode.StatusBarItem | null = null;
const cantRead = new Map<string, vscode.StatusBarItem>();
/** Settled conflict-file part saved across a diff-choice press so Undo can restore it. */
const pressing = new Map<string, StoredPart>();

export function keepNoticesForTests(on: boolean): void {
  keeping = on;
}

export function raisedNotices(): readonly { notice: CoreNotice; uri: string; at: number }[] {
  return raised;
}

export function disposeNotices(): void {
  saveCheckItem?.dispose();
  saveCheckItem = null;
  for (const item of cantRead.values()) item.dispose();
  cantRead.clear();
  pressing.clear();
}

export function noticesClosed(uri: string): void {
  cantRead.get(uri)?.dispose();
  cantRead.delete(uri);
}

export function showCoreNotice(notice: CoreNotice, target: NoticeTarget): void {
  const seenAt = Date.now();
  const uri = target.document.uri.toString();
  const file = fileNameOf(target.document.uri);
  if (keeping) raised.push({ notice, uri, at: seenAt });
  noticeArrived(notice, target.document, target.coordinator());
  log(
    notice.kind === 'readStatus' && !notice.ok ? 'warn' : 'info',
    `Notice (${notice.kind}): ${summarizeNotice(file, notice)}`,
  );

  switch (notice.kind) {
    case 'conflict':
      showConflict(notice, target, file, seenAt);
      return;
    case 'truncatedFollow':
      void writePart(notice, target, seenAt).then(() => warningWritten(notice, target.document));
      return;
    case 'applied':
      showApplied(notice, target, file, pressing.get(uri));
      return;
    case 'actionRejected':
      messages.reply(actionRejectedText(file, notice), 'warning');
      return;
    case 'closedWithPending':
      showClosedWithPending(notice, target, file, seenAt);
      return;
    case 'readStatus':
      if (notice.ok) noticesClosed(uri);
      else showCantRead(readFailedTooltip(file, notice.error), target.document);
      return;
    case 'saveCheckOff':
      showSaveCheckOff();
      return;
    case 'typingAtClose':
      showTypingAtClose(notice, target, file);
      return;
  }
}

function showConflict(
  notice: Extract<CoreNotice, { kind: 'conflict' }>,
  target: NoticeTarget,
  file: string,
  seenAt: number,
): void {
  const kind: BackupKind = notice.reason === 'noBase' ? 'disk' : notice.reason === 'truncated' ? 'cut' : 'theirs';
  const versionName = conflictVersionName(kind, notice.reason, notice.savedOver);
  if (versionName !== null && notice.backupPath !== null) backupViews.nameAs(notice.backupPath, versionName);
  const kept = keptOf(notice.backupPath, notice.diskText, kind);
  showKept(kept);

  const partWritten = writePart(notice, target, seenAt);
  const text = conflictText(file, notice);

  if (notice.choice !== 'none') {
    const mode = notice.choice;
    messages.offerChoice({
      id: notice.id,
      button: mode === 'replace' ? 'replace' : 'useClash',
      note: target.document.uri,
      version: () => backupViews.versionUri(notice.backupPath, notice.diskText),
      offers: () => !target.document.isClosed && target.coordinator().offers(notice.id),
      run: async () => {
        if (target.document.isClosed) {
          messages.reply(`Nothing was changed because ${file} is closed.`, 'warning');
          return;
        }
        await partWritten;
        const key = target.document.uri.toString();
        const part = conflictFiles.partsOf(target.document.uri).find((p) => p.noticeId === notice.id);
        if (part) pressing.set(key, part);
        try {
          const c = target.coordinator();
          const changed = await (mode === 'replace' ? c.replaceNote(notice.id) : c.useFileVersion(notice.id));
          if (changed) conflictFiles.settle(notice.id);
        } finally {
          pressing.delete(key);
        }
      },
    });
  }

  messages.open({
    id: notice.id,
    note: target.document.uri,
    form: messageForm({ kind: kept ? 'withDiff' : 'told', text }),
    offers: (does) => does === 'compare' && kept !== null,
    press: async (does) => {
      if (does === 'compare') {
        await compareKept(kept, target.document, versionName);
        messages.refresh(target.document.uri);
      }
      return false;
    },
  });
}

function showApplied(
  notice: Extract<CoreNotice, { kind: 'applied' }>,
  target: NoticeTarget,
  file: string,
  restore?: StoredPart,
): void {
  const kept = keptOf(notice.backupPath, notice.previousText, 'yours');
  showKept(kept);
  const text = appliedText(file, notice);

  messages.open({
    id: notice.id,
    note: target.document.uri,
    form: messageForm({ kind: notice.how === 'reloaded' ? 'reloaded' : 'withUndo', text }),
    offers: (does) => {
      if (does === 'compare') return kept !== null;
      if (does === 'undo') return notice.canUndo && !target.document.isClosed && target.coordinator().offers(notice.id);
      return false;
    },
    press: async (does) => {
      if (does === 'compare') {
        await compareKept(kept, target.document);
        return false;
      }
      if (does !== 'undo') return false;
      if (target.document.isClosed) {
        messages.reply(`Nothing was changed because ${file} is closed.`, 'warning');
        return false;
      }
      if (await target.coordinator().undoUsed(notice.id)) {
        conflictFiles.settle(notice.id);
        if (restore) await conflictFiles.restore(target.document, restore);
        return true;
      }
      return false;
    },
    closed: () => target.coordinator().noticeClosed(notice.id),
  });
}

function showClosedWithPending(
  notice: Extract<CoreNotice, { kind: 'closedWithPending' }>,
  target: NoticeTarget,
  file: string,
  seenAt: number,
): void {
  const kept = keptOf(notice.backupPath, notice.diskText, 'theirs');
  showKept(kept);
  void writePart(notice, target, seenAt);

  messages.open({
    id: notice.id,
    note: target.document.uri,
    form: messageForm({
      kind: kept ? 'withDiff' : 'told',
      text: closedWithPendingText(file, notice.backupPath !== null),
    }),
    offers: (does) => does === 'compare' && kept !== null,
    press: async (does) => {
      if (does === 'compare') await compareKept(kept, target.document);
      return false;
    },
  });
}

function showTypingAtClose(
  notice: Extract<CoreNotice, { kind: 'typingAtClose' }>,
  target: NoticeTarget,
  file: string,
): void {
  const kept = keptOf(notice.backupPath, notice.copy, 'yours');
  if (notice.backupPath !== null) backupViews.told(notice.backupPath);
  showKept(kept);
  let canPutBack = true;

  messages.open({
    id: notice.id,
    note: target.document.uri,
    form: messageForm({
      kind: 'typingAtClose',
      text: typingAtCloseText(file, notice.linesChanged, notice.backupPath !== null),
    }),
    offers: (does) => (does === 'putTypingBack' ? canPutBack : does === 'compare' && kept !== null),
    press: async (does) => {
      if (does === 'compare') {
        await compareKept(kept, target.document);
        return false;
      }
      if (does !== 'putTypingBack') return false;
      const result = await putTypingBack(notice, target);
      if (result === 'done') return true;
      if (result === 'changed') canPutBack = false;
      messages.reply(typingNotBackText(file, result), 'warning');
      return false;
    },
  });
}

async function putTypingBack(
  notice: Extract<CoreNotice, { kind: 'typingAtClose' }>,
  target: NoticeTarget,
): Promise<PutBackResult> {
  const uri = target.document.uri;
  let note: vscode.TextDocument;
  try {
    note = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    log('warn', `Could not open ${fileNameOf(uri)} again to put typing back`, error);
    return 'refused';
  }
  const now = toLf(documentText(note));
  if (now !== notice.copy && (note.isDirty || now !== notice.closedText)) return 'changed';
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
  } catch (error) {
    log('error', `Could not open ${fileNameOf(uri)} in the rich editor to put typing back`, error);
    return 'refused';
  }
  const coordinator = target.reopened?.();
  return coordinator ? coordinator.putBack(notice.closedText, notice.copy) : 'refused';
}

async function writePart(notice: CoreNotice, target: NoticeTarget, seenAt: number): Promise<void> {
  const part = partForNotice(notice);
  if (!part) return;
  const encoding = encodingOf(target.document);
  const diskText =
    notice.kind === 'conflict' || notice.kind === 'truncatedFollow' || notice.kind === 'closedWithPending'
      ? notice.diskText
      : null;
  try {
    await conflictFiles.add(
      target.document,
      notice.id,
      part.facts,
      part.problems,
      diskText === null ? null : { text: toLf(diskText), seenAt, encoding },
      part.backup,
    );
  } catch (error) {
    log('error', 'Could not write the part of a conflict file', error);
  }
}

function keptOf(backupPath: string | null, text: string | null, kind: BackupKind): Kept {
  if (backupPath !== null) return { backupPath };
  return text !== null ? { text, kind } : null;
}

function showKept(kept: Kept): void {
  if (kept && 'text' in kept) void backupViews.showVersion(kept.text);
}

async function compareKept(
  kept: Kept,
  document: vscode.TextDocument,
  versionName: VersionName | null = null,
): Promise<void> {
  if (!kept) return;
  if ('backupPath' in kept) await backupViews.compareBackup(kept.backupPath, document);
  else await backupViews.compareVersion(kept.text, kept.kind, document, versionName);
}

function showCantRead(tooltip: string, document: vscode.TextDocument): void {
  const uri = document.uri.toString();
  let item = cantRead.get(uri);
  if (!item) {
    item = vscode.window.createStatusBarItem(
      `tandemMarkdown.cantRead.${uri}`,
      vscode.StatusBarAlignment.Right,
      STATUS_PRIORITY.warning,
    );
    item.name = 'Tandem Markdown file read';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    cantRead.set(uri, item);
  }
  item.text = `$(warning) Can't read ${fileNameOf(document.uri).replace(/\$\(/g, '$\u200b(')}`;
  item.tooltip = tooltip;
  item.show();
}

function showSaveCheckOff(): void {
  if (!saveCheckItem) {
    saveCheckItem = vscode.window.createStatusBarItem(
      'tandemMarkdown.saveCheckOff',
      vscode.StatusBarAlignment.Right,
      STATUS_PRIORITY.warning,
    );
    saveCheckItem.name = 'Tandem Markdown merge on save';
    saveCheckItem.text = '$(warning) No merge on save';
    saveCheckItem.tooltip =
      'Saving can now lose a change another program makes at the same moment. Click to reload the window and fix this.';
    saveCheckItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    saveCheckItem.command = 'workbench.action.reloadWindow';
  }
  saveCheckItem.show();
  messages.open({
    id: 'tandemMarkdown.saveCheckOff',
    note: null,
    form: messageForm({ kind: 'saveCheckOff', text: saveCheckOffText() }),
    offers: () => true,
    press: async (does) => {
      if (does === 'reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return true;
    },
  });
}
