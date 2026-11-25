// The tab the user is in, which the host's commands act on (docs/ARCHITECTURE.md, "The tab the
// user is in"). It is the active group's active tab, with one exception. VS Code can mark a rich
// tab's group active again by itself while a text editor beside it keeps the keyboard; VS Code
// then names that text editor `window.activeTextEditor`, as it names whichever text editor holds
// the keyboard. When the active tab is a rich tab whose page does not have the keyboard and the
// active text editor is the active tab of its own group, the user is in that text editor's tab.
//
// The rich tab's own report decides, not `activeTextEditor` alone: VS Code works out the active
// text editor again only when a text editor gains focus or the active editor changes, so the
// keyboard moving into that already active rich tab leaves `activeTextEditor` as it was.

/** What the rule reads of one tab: its kind, its file (`uri.toString()`) and its group's column. */
export interface TabFacts {
  kind: 'text' | 'rich' | 'other';
  uri: string | undefined;
  column: number;
}

export interface WhereFacts {
  /** The active group's active tab. */
  active: TabFacts | undefined;
  /** For a rich active tab: its page, or a field in it, has the keyboard (its own focus report). */
  richHasKeyboard: boolean;
  /** VS Code's active text editor: its document and its group's column. */
  textEditor: { uri: string; column: number | undefined } | undefined;
  /** The active tab of every group. */
  groupTabs: readonly TabFacts[];
}

/** The tab the user is in, among the active tabs given; undefined when the active group has none. */
export function currentTabOf(f: WhereFacts): TabFacts | undefined {
  const active = f.active;
  if (!active || active.kind !== 'rich' || f.richHasKeyboard || !f.textEditor) return active;
  const editor = f.textEditor;
  const shown = f.groupTabs.find((t) => t.column === editor.column);
  return shown && shown.kind === 'text' && shown.uri === editor.uri ? shown : active;
}
