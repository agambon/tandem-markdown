// The title bar's Show buttons (docs/ARCHITECTURE.md, "The title bar's Show buttons"): which
// title bars VS Code draws them on, and the tab a click acts on.
//
// VS Code runs a title bar button's command with the file of the tab it is drawn for, and not
// which group: the group id it passes as well cannot be matched to a tab group through the
// extension API, and clicking a title bar button does not make its group active.
//
// VS Code does judge a title bar's `when` clauses for that group's own tab, `activeCustomEditorId`
// among them. So Show Rich View and Show Rich Editor, and their Alt forms, each have two title
// bar forms, commands of their own: one drawn on rich tabs, one on every other tab (Source).
// Show Source is drawn on rich tabs only. The palette and the keys keep the plain commands.

import type { Mode } from '../../core/protocol';

/** What a tab shows its file as. Any editor that is not ours counts as Source. */
export type View = 'source' | Mode;

/** VS Code's settings that decide which title bars have the editor actions. */
export interface EditorActionSettings {
  /** `workbench.editor.editorActionsLocation`: 'default', 'titleBar' or 'hidden'. */
  location: unknown;
  /** `workbench.editor.showTabs`: 'multiple', 'single' or 'none'. */
  showTabs: unknown;
  /** `workbench.editor.alwaysShowEditorActions`. */
  alwaysShow: unknown;
}

/**
 * VS Code draws the editor actions on every group's title bar: `alwaysShowEditorActions` is on
 * with the actions on the groups' own title bars. Otherwise it draws them for the active group
 * only, on its title bar or on the window's.
 */
export function actionsOnEveryGroup(s: EditorActionSettings): boolean {
  return s.alwaysShow === true && s.location === 'default' && s.showTabs !== 'none';
}

/** The tabs a title bar form of a Show button is drawn on: rich tabs, or every other tab. */
export type DrawnOn = 'rich' | 'source';

/** What the rule reads of a group's active tab showing the button's file, with the Show buttons drawn for it. */
export interface DrawnTab {
  view: View;
  /** Its group's column. */
  column: number;
  /** A Source tab of markdown, by language or by name: its title bar has Show Rich View and Show Rich Editor. */
  markdown: boolean;
}

/**
 * The tab a Show button acts on, among `drawn`; undefined when it would change none. `current`
 * is the tab the user is in, `on` the tabs the button's form is drawn on (any, for a plain
 * command given a file).
 *
 * A Show button acts on a tab it is drawn for, of the kind its form is drawn on, and would
 * change: the one such tab, or, with several, the tab the user is in when it is one of them,
 * else the first by column. Show Source changes a rich tab; Show Rich View a Source tab or a rich
 * tab in the Rich editor; Show Rich Editor a Source tab or a rich tab in Rich view. On a Source
 * tab the rich Show buttons are drawn for markdown only (by language or by name), not for a
 * `.txt` file or untitled plain text. The Alt forms (opening to the side) choose the tab they
 * start from the same way.
 */
export function showTargetOf<T extends DrawnTab>(
  button: View,
  drawn: readonly T[],
  current: T | undefined,
  on?: DrawnOn,
): T | undefined {
  const changes = drawn.filter(
    (t) =>
      t.view !== button &&
      (t.view !== 'source' || t.markdown) &&
      (on === undefined || (on === 'source') === (t.view === 'source')),
  );
  if (current && changes.includes(current)) return current;
  return changes.reduce<T | undefined>((first, t) => (!first || t.column < first.column ? t : first), undefined);
}
