// Opening to the side (docs/ARCHITECTURE.md, "Opening to the side"): Open Rich View to the
// Side, Open Rich Editor to the Side and, from a rich tab, Open Source to the Side. Each opens
// the tab's document in the group beside it, keeps focus where it is, and starts the new tab at
// the place the tab shows. The title bar's Show buttons run them with Alt held (their title bar
// forms, one drawn on rich tabs and one on every other tab), and then they start from the tab
// the button would act on (tabs.ts, `showTarget`); from the palette or a key, from the tab the
// user is in.
//
// A tab already showing the document in that view in the group beside is gone to, not opened
// twice: VS Code shows an editor its group already has. That tab keeps its own place; a rich
// tab there is switched to the view asked for, as one panel holds both rich views.

import * as vscode from 'vscode';
import type { Mode, ViewState } from '../core/protocol';
import { registerCommand } from './commandRegistration';
import type { Documents } from './documents';
import type { HostFeature } from './features';
import { log } from './log';
import { VIEW_TYPE } from './model/editorIds';
import type { DrawnOn } from './model/showButtons';
import {
  documentReadOnly,
  dropPendingOpen,
  offersRich,
  selectAsIn,
  setPendingOpen,
  setRichMode,
  tellCouldNotOpen,
  tellReadOnly,
  textEditorForTab,
  viewStateOf,
} from './modeSwitch';
import { panels, type HostPanel } from './panels';
import { scrollSync } from './scrollSync';
import { currentTab, isOurTab, panelOfTab, showTarget, tabUri } from './tabs';
import { sameUri } from './uris';

/** How long a new rich tab may take to start before the share of its top line is let go (its init's top line still holds). */
const LIVE_WAIT_MS = 10_000;

export const openToSide: HostFeature = (_context, documents) =>
  vscode.Disposable.from(
    registerCommand('openRichViewToSide', (uri) => richToSide(documents, uri, 'view')),
    registerCommand('openRichEditorToSide', (uri) => richToSide(documents, uri, 'edit')),
    // The title bar's forms of the two, one drawn on rich tabs and one on every other tab (model/showButtons.ts).
    registerCommand('openRichViewToSideOnRichTab', (uri) => richToSide(documents, uri, 'view', 'rich')),
    registerCommand('openRichViewToSideOnSourceTab', (uri) => richToSide(documents, uri, 'view', 'source')),
    registerCommand('openRichEditorToSideOnRichTab', (uri) => richToSide(documents, uri, 'edit', 'rich')),
    registerCommand('openRichEditorToSideOnSourceTab', (uri) => richToSide(documents, uri, 'edit', 'source')),
    registerCommand('openSourceToSide', (uri) => sourceToSide(uri)),
  );

/**
 * The column beside a tab's group. For the active group, VS Code's own "beside" (the next group
 * in the direction `workbench.editor.openSideBySideDirection` names, made when there is none);
 * VS Code reckons that from the active group, so for another group (a title bar button of a
 * group that is not active) the group after it in VS Code's order of columns, made when there
 * is none.
 */
function besideOf(group: vscode.TabGroup): vscode.ViewColumn {
  return group.isActive ? vscode.ViewColumn.Beside : group.viewColumn + 1;
}

/** Columns in which a tab of the document passes `which`. */
function columnsWith(uri: vscode.Uri, which: (tab: vscode.Tab) => boolean): Set<vscode.ViewColumn> {
  const out = new Set<vscode.ViewColumn>();
  for (const g of vscode.window.tabGroups.all)
    if (
      g.tabs.some((t) => {
        const shown = tabUri(t);
        return !!shown && sameUri(shown, uri) && which(t);
      })
    )
      out.add(g.viewColumn);
  return out;
}

async function richToSide(documents: Documents, arg: unknown, asked: Mode, on?: DrawnOn): Promise<void> {
  const tab = arg instanceof vscode.Uri ? showTarget(asked, arg, on) : currentTab();
  const uri = tabUri(tab);
  if (!tab || !uri || !offersRich(tab, uri)) return;
  let mode = asked;
  if (mode === 'edit' && documentReadOnly(documents, uri)) {
    mode = 'view';
    tellReadOnly(uri);
  }
  const from = tab.group.viewColumn;
  // Where the tab is: a text editor's selection, top line and place; a rich tab's last view state.
  const editor = textEditorForTab(tab, uri);
  let viewState: ViewState | undefined;
  let place: number | undefined;
  if (editor) {
    viewState = viewStateOf(editor, mode);
    place = scrollSync.placeOf(editor);
  } else {
    viewState = panelOfTab(tab)?.viewState;
  }
  const before = new Set(panels.panelsFor(uri).map((p) => p.id));
  const richElsewhere = [...columnsWith(uri, isOurTab)].some((c) => c !== from);
  setPendingOpen(uri, mode, viewState);
  const beside = besideOf(tab.group);
  try {
    // VS Code resolves this once the editor is open, our panel's record made.
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: beside,
      preserveFocus: true,
      preview: false,
    });
  } catch (error) {
    dropPendingOpen(uri);
    log('error', `Could not open ${uri.fsPath} in the rich editor to the side`, error);
    tellCouldNotOpen(uri, mode, beside);
    return;
  }
  const isNew = (p: HostPanel) => sameUri(p.uri, uri) && !before.has(p.id);
  let opened: HostPanel | undefined = panels.panelsFor(uri).find(isNew);
  // With no rich tab of the document in another group, nothing could be reused: a new one comes.
  if (!opened && !richElsewhere) opened = await panels.whenLive(isNew, LIVE_WAIT_MS);
  if (opened) {
    // The init carries the top line; a wrapped line's share of it comes after.
    if (place !== undefined && place !== Math.floor(place)) {
      const live = await panels.whenLive((p) => p.id === opened.id, LIVE_WAIT_MS);
      if (live && !live.disposed) void live.post({ type: 'scrollTo', line: place });
    }
    return;
  }
  // The group beside already had a rich tab of the document, now shown: it takes the view asked for.
  dropPendingOpen(uri);
  const shown = shownRichTabOutside(uri, from);
  if (shown) await setRichMode(shown, mode);
}

/** The one rich tab of the document shown in a group other than `column`, if there is exactly one. */
function shownRichTabOutside(uri: vscode.Uri, column: vscode.ViewColumn): HostPanel | undefined {
  const shown = vscode.window.tabGroups.all
    .filter((g) => g.viewColumn !== column && g.activeTab && isOurTab(g.activeTab))
    .map((g) => panelOfTab(g.activeTab!))
    .filter((p): p is HostPanel => !!p && sameUri(p.uri, uri));
  return shown.length === 1 ? shown[0] : undefined;
}

async function sourceToSide(arg: unknown): Promise<void> {
  const tab = arg instanceof vscode.Uri ? showTarget('source', arg) : currentTab();
  const panel = tab ? panelOfTab(tab) : undefined;
  if (!tab || !panel || panel.disposed) return;
  const viewState = panel.viewState;
  const hadSource = columnsWith(panel.uri, (t) => t.input instanceof vscode.TabInputText);
  const editor = await vscode.window.showTextDocument(panel.document, {
    viewColumn: besideOf(tab.group),
    preserveFocus: true,
    preview: false,
  });
  // A Source tab that was there already keeps its own place.
  if (!viewState || (editor.viewColumn !== undefined && hadSource.has(editor.viewColumn))) return;
  selectAsIn(editor, viewState);
  scrollSync.revealPlace(editor, Math.max(0, Math.floor(viewState.topLine)));
}
