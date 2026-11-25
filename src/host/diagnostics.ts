// Problems and their fixes in the rich views. Every diagnostic VS Code holds for a panel's
// document (a spell checker's, a linter's, the markdown link check's) goes to the document's
// panels as offsets in the host's text (panelText.ts), again whenever they change, and to each
// panel that starts. A panel asks for the quick fixes of a range and has one applied: VS Code
// applies the fix's edit and runs its command, and the panel sees an ordinary change.
// docs/ARCHITECTURE.md, "VS Code's features in the rich views".

import * as vscode from 'vscode';
import type { ApplyCodeActionResult, CodeActionsResult, DiagnosticsMessage } from '../core/featureProtocol';
import type { Documents } from './documents';
import type { HostFeature } from './features';
import { diagnosticItems, type RawDiagnostic } from './model/diagnosticItems';
import { registerPanelMessageHandler } from './panelMessages';
import { panels, type HostPanel } from './panels';
import { offsetIn, syncedText, textForRequest, toPosition } from './panelText';

/** Changes to a document's problems within this long go to its panels as one message. */
const DIAGNOSTICS_PAUSE_MS = 100;
/** The most fixes offered for one range. */
const MAX_FIXES = 20;

/** The fix is not in the latest list, or the note changed since that list was made: the tab offers the list again. */
const OUT_OF_DATE = 'That quick fix is out of date, so it was not applied.';
const NOT_APPLIED = 'VS Code did not apply that quick fix, so nothing changed.';

type Fix = vscode.CodeAction | vscode.Command;

function isCommand(fix: Fix): fix is vscode.Command {
  return typeof (fix as vscode.Command).command === 'string';
}

/** A fix that can be applied: a command, or a code action that is not disabled and has an edit or a command. */
function usable(fix: Fix | null | undefined): fix is Fix {
  if (!fix || typeof fix.title !== 'string') return false;
  if (isCommand(fix)) return true;
  return !fix.disabled && (fix.edit !== undefined || fix.command !== undefined);
}

function rawOf(d: vscode.Diagnostic): RawDiagnostic {
  return {
    range: d.range,
    severity: d.severity,
    message: d.message,
    source: d.source,
    code: d.code,
    tags: d.tags,
  };
}

function message(documents: Documents, uri: vscode.Uri): DiagnosticsMessage | undefined {
  const synced = syncedText(documents, uri);
  if (!synced) return undefined;
  const items = diagnosticItems(synced.doc, vscode.languages.getDiagnostics(uri).map(rawOf));
  return { type: 'diagnostics', version: synced.version, items };
}

/** The fixes a panel was last offered, and the document version they were listed at. */
interface Offered {
  document: vscode.TextDocument;
  version: number;
  byId: Map<string, Fix>;
}

export const diagnostics: HostFeature = (_context, documents) => {
  const due = new Map<string, NodeJS.Timeout>();
  const offered = new Map<string, Offered>();
  let fixCount = 0;

  const send = (uri: vscode.Uri, to: readonly HostPanel[], onlyIfAny: boolean) => {
    const live = to.filter((p) => p.live);
    if (live.length === 0) return;
    const m = message(documents, uri);
    if (!m || (onlyIfAny && m.items.length === 0)) return;
    for (const p of live) void p.post(m);
  };

  const schedule = (uri: vscode.Uri) => {
    const key = uri.toString();
    if (due.has(key) || panels.panelsFor(key).length === 0) return;
    due.set(
      key,
      setTimeout(() => {
        due.delete(key);
        send(uri, panels.panelsFor(key), false);
      }, DIAGNOSTICS_PAUSE_MS),
    );
  };

  return vscode.Disposable.from(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) schedule(uri);
    }),
    // Each init (an open, a reload, a resync) starts the panel's state afresh.
    panels.onDidBecomeLive((p) => send(p.uri, [p], true)),
    panels.onDidChangePanels(() => {
      const open = new Set(panels.all().map((p) => p.id));
      for (const id of offered.keys()) if (!open.has(id)) offered.delete(id);
    }),
    registerPanelMessageHandler('codeActions', async (m, panel): Promise<CodeActionsResult> => {
      const at = await textForRequest(documents, panel, m.expect);
      if (!at) return { stale: true };
      const from = offsetIn(at.doc, m.from);
      const to = offsetIn(at.doc, m.to);
      if (to < from) throw new Error('codeActions needs a range');
      const range = new vscode.Range(toPosition(at.doc, from), toPosition(at.doc, to));
      const found = await vscode.commands.executeCommand<(Fix | null)[] | undefined>(
        'vscode.executeCodeActionProvider',
        at.document.uri,
        range,
        vscode.CodeActionKind.QuickFix.value,
        MAX_FIXES,
      );
      const byId = new Map<string, Fix>();
      const fixes = (found ?? [])
        .filter(usable)
        .slice(0, MAX_FIXES)
        .map((fix) => {
          const id = String(++fixCount);
          byId.set(id, fix);
          return { id, title: fix.title, preferred: !isCommand(fix) && fix.isPreferred === true };
        });
      offered.set(panel.id, { document: at.document, version: at.version, byId });
      return { fixes };
    }),
    registerPanelMessageHandler('applyCodeAction', async (m, panel): Promise<ApplyCodeActionResult> => {
      const list = offered.get(panel.id);
      const fix = typeof m.id === 'string' ? list?.byId.get(m.id) : undefined;
      if (!list || !fix) return { refused: OUT_OF_DATE };
      offered.delete(panel.id);
      if (list.document.isClosed || list.document.version !== list.version) return { refused: OUT_OF_DATE };
      const run = (command: vscode.Command) =>
        vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      return documents.applyUserEdit(list.document.uri, async (): Promise<ApplyCodeActionResult> => {
        if (isCommand(fix)) {
          await run(fix);
          return { done: true };
        }
        if (fix.edit && !(await vscode.workspace.applyEdit(fix.edit))) return { refused: NOT_APPLIED };
        if (fix.command) await run(fix.command);
        return { done: true };
      });
    }),
    {
      dispose: () => {
        for (const timer of due.values()) clearTimeout(timer);
        due.clear();
        offered.clear();
      },
    },
  );
};
