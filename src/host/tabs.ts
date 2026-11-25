// Tabs: the file a tab shows, the panel behind one of Tandem Markdown's own tabs, the tab the user
// is in (model/currentTab.ts) and the tab a title bar Show button acts on (model/showButtons.ts).

import * as vscode from 'vscode';
import { isMarkdownPath } from '../core/fileKinds';
import { currentTabOf, type TabFacts } from './model/currentTab';
import { VIEW_TYPE } from './model/editorIds';
import { showTargetOf, type DrawnOn, type DrawnTab, type View } from './model/showButtons';
import { actionsOnEveryGroupNow, panels, type HostPanel } from './panels';
import { sameUri } from './uris';

/** The file a tab shows. Diffs, notebooks, terminals and the like are left alone. */
export function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

export function isOurTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE;
}

/** True when the active tab of the active group is another extension's custom editor showing `uri`. */
export function otherRichEditorActive(uri: vscode.Uri): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType !== VIEW_TYPE && sameUri(input.uri, uri);
}

/**
 * The tab the user is in, which a command acts on: the active group's active tab, or the text
 * editor that kept the keyboard when VS Code marked a rich tab's group active (model/currentTab.ts).
 */
export function currentTab(): vscode.Tab | undefined {
  const groups = vscode.window.tabGroups;
  const known = new Map<TabFacts, vscode.Tab>();
  const factsOf = (tab: vscode.Tab): TabFacts => {
    const kind = tab.input instanceof vscode.TabInputText ? 'text' : isOurTab(tab) ? 'rich' : 'other';
    const facts: TabFacts = { kind, uri: tabUri(tab)?.toString(), column: tab.group.viewColumn };
    known.set(facts, tab);
    return facts;
  };
  const active = groups.activeTabGroup.activeTab;
  const panel = active ? panelOfTab(active) : undefined;
  const editor = vscode.window.activeTextEditor;
  const chosen = currentTabOf({
    active: active && factsOf(active),
    richHasKeyboard: !!panel && (panel.focus.editor || panel.focus.field),
    textEditor: editor && { uri: editor.document.uri.toString(), column: editor.viewColumn },
    groupTabs: groups.all.flatMap((g) => (g.activeTab ? [factsOf(g.activeTab)] : [])),
  });
  return chosen && known.get(chosen);
}

/**
 * The tab a title bar Show button (or its Alt form) for `uri` acts on: of the groups' active tabs
 * showing the file that VS Code draws the buttons for, one of the kind `on` names (any kind when
 * it is undefined) that the button would change (model/showButtons.ts). Undefined when it would
 * change none.
 */
export function showTarget(button: View, uri: vscode.Uri, on?: DrawnOn): vscode.Tab | undefined {
  const groups = vscode.window.tabGroups;
  const drawnFor = actionsOnEveryGroupNow() ? groups.all : [groups.activeTabGroup];
  const known = new Map<DrawnTab, vscode.Tab>();
  for (const g of drawnFor) {
    const tab = g.activeTab;
    const shown = tabUri(tab);
    if (!tab || !shown || !sameUri(shown, uri)) continue;
    const view = viewOf(tab);
    if (!view) continue;
    const languageId = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, shown))?.languageId;
    known.set({ view, column: g.viewColumn, markdown: languageId === 'markdown' || isMarkdownPath(shown.path) }, tab);
  }
  const current = currentTab();
  const currentFacts = [...known].find(([, tab]) => tab === current)?.[0];
  const chosen = showTargetOf(button, [...known.keys()], currentFacts, on);
  return chosen && known.get(chosen);
}

/** What a tab shows its file as: Source for any editor not ours, else its panel's view (a read-only document is in Rich view). */
function viewOf(tab: vscode.Tab): View | undefined {
  if (!isOurTab(tab)) return 'source';
  const panel = panelOfTab(tab);
  return panel && (panel.readOnly ? 'view' : panel.mode);
}

export function panelOfTab(tab: vscode.Tab): HostPanel | undefined {
  if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== VIEW_TYPE) return undefined;
  return panelIn(tab.input.uri, tab.group.viewColumn);
}

/** The panel showing the file in the group in `column`: the active one there, else the first. */
export function panelIn(uri: vscode.Uri, column: vscode.ViewColumn | undefined): HostPanel | undefined {
  const all = panels.panelsFor(uri);
  return (
    all.find((p) => p.webviewPanel.viewColumn === column && p.webviewPanel.active) ??
    all.find((p) => p.webviewPanel.viewColumn === column)
  );
}

/** The tab of the group in `column` that shows the file and passes `which`. */
export function tabIn(
  column: vscode.ViewColumn | undefined,
  uri: vscode.Uri,
  which: (tab: vscode.Tab) => boolean,
): vscode.Tab | undefined {
  const key = uri.toString();
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === column);
  return group?.tabs.find((t) => tabUri(t)?.toString() === key && which(t));
}
