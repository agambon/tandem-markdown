// The host's half of what a screen reader is told when another program's change lands in a note
// (src/panel/announce/). A note's rich tabs are told whether the note holds unsaved changes, and
// which of the core's notices speak for a change with a message, and which gave it a warning in
// the Problems list with none (notices.ts calls these as it shows each notice). What the user's
// press of a message's button or a warning's quick fix changed, the core logs as a press. A note
// open in two rich tabs is told once: a tab asks before it tells (`tellOutside`), and the tab the
// user is in tells, where it is shown, else the first to ask. Versions are the coordinator's log's.

import * as vscode from 'vscode';
import type { CoreNotice, DocumentCoordinator } from '../core/coordinator';
import type { TellOutsideResult } from '../core/featureProtocol';
import type { HostToPanel } from '../core/protocol';
import { conflictFiles } from './conflictFiles';
import type { HostFeature } from './features';
import { registerPanelMessageHandler } from './panelMessages';
import { panels } from './panels';
import { PanelValue } from './panelValue';

/** By coordinator, the log version up to which a tab has told its note's outside changes. */
const told = new WeakMap<DocumentCoordinator, number>();

function postToNote(uri: vscode.Uri, message: HostToPanel, except: string | null = null): void {
  for (const p of panels.livePanelsFor(uri)) if (p.id !== except) void p.post(message);
}

/** The notices whose message speaks for a change that went into the note. */
function speaksForChange(notice: CoreNotice): boolean {
  return (notice.kind === 'conflict' && notice.restMerged) || notice.kind === 'applied';
}

/** The notices with no message whose part may give a warning in the Problems list (warningWritten says). */
function warnsQuietly(notice: CoreNotice): boolean {
  return notice.kind === 'truncatedFollow';
}

/** A core notice arrived for `document`, before anything is shown for it. */
export function noticeArrived(
  notice: CoreNotice,
  document: vscode.TextDocument,
  coordinator: DocumentCoordinator,
): void {
  const tells = speaksForChange(notice) ? 'message' : warnsQuietly(notice) ? 'coming' : null;
  if (tells === null || panels.livePanelsFor(document.uri).length === 0) return;
  postToNote(document.uri, { type: 'outsideNotice', notice: notice.id, tells, version: coordinator.synced().version });
}

/** The part of a notice with no message has been written or refused: whether its warning is in the Problems list. */
export function warningWritten(notice: CoreNotice, document: vscode.TextDocument): void {
  if (!warnsQuietly(notice) || panels.livePanelsFor(document.uri).length === 0) return;
  const shown = conflictFiles.warningsOf(document.uri).some((w) => w.noticeId === notice.id && w.problems.length > 0);
  postToNote(document.uri, { type: 'outsideNotice', notice: notice.id, tells: shown ? 'warning' : 'none' });
}

export const announce: HostFeature = (_context, documents) => {
  /** Whether each live panel's note holds unsaved changes, as that panel was last told. */
  const unsaved = new PanelValue(
    (p) => p.document.isDirty,
    (held): HostToPanel => ({ type: 'unsavedChanges', held }),
  );

  const tell = (document: vscode.TextDocument): void => {
    for (const p of panels.panelsFor(document.uri)) unsaved.tell(p);
  };

  return vscode.Disposable.from(
    unsaved,
    // VS Code flips the flag in a change event of its own, after the first edit's (docs/ARCHITECTURE.md, "What VS Code is assumed to do").
    vscode.workspace.onDidChangeTextDocument((e) => tell(e.document)),
    vscode.workspace.onDidSaveTextDocument(tell),
    registerPanelMessageHandler('tellOutside', (m, panel): TellOutsideResult => {
      const upTo = typeof m.upTo === 'number' && Number.isFinite(m.upTo) ? m.upTo : -1;
      const coordinator = documents.get(panel.uri)?.coordinator;
      if (!coordinator) return { after: -1 };
      const yours = panels
        .panelsFor(panel.uri)
        .find((p) => p.id !== panel.id && p.live && p.webviewPanel.active && p.webviewPanel.visible);
      if (yours) return null;
      const after = told.get(coordinator) ?? -1;
      told.set(coordinator, Math.max(after, upTo));
      postToNote(panel.uri, { type: 'outsideTold', upTo }, panel.id);
      return { after };
    }),
  );
};
