// The panel commands for tables:
//   insertTable  a 3 by 3 table at the cursor's line, its first header cell open for editing
//   alignTable   pads the table the open cell or the selection is in

import type { EditorView } from '@codemirror/view';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { canEdit } from '../modes';
import { currentEdit, finish, openCell, runAction } from './cellEdit';
import { newTable, structureEdit, TABLE_EVENT } from './edits';
import { readTableAt } from './model';
import { tellOverlong } from './overlong';

/** How many frames to wait for a new table to be parsed and drawn before opening its first cell. */
const OPEN_TRIES = 10;

/** Opens the first header cell of the table that starts at `pos`, once the table is drawn. */
export function openWhenDrawn(view: EditorView, pos: number, tries = OPEN_TRIES): void {
  if (openCell(view, pos, { row: 0, col: 0 }) || tries <= 0) return;
  const win = view.dom.ownerDocument.defaultView;
  if (!win) return;
  win.requestAnimationFrame(() => {
    if (!currentEdit(view)) openWhenDrawn(view, pos, tries - 1);
  });
}

function insertTable(view: EditorView): boolean {
  if (!canEdit(view.state)) return false;
  const open = currentEdit(view);
  if (open) finish(open, 'none');
  const plan = newTable(view.state);
  const tr = view.state.update({
    changes: plan.changes,
    selection: { anchor: plan.cursor },
    scrollIntoView: true,
    userEvent: TABLE_EVENT,
  });
  view.dispatch(tr);
  openWhenDrawn(view, plan.tableFrom);
  return true;
}

function alignTable(view: EditorView): boolean {
  const open = currentEdit(view);
  if (open) {
    runAction(view, open.root, 'alignTable');
    return true;
  }
  if (!canEdit(view.state)) return false;
  const head = view.state.selection.main.head;
  const info = readTableAt(view.state, head);
  if (!info) return false;
  const ctx = view.state.facet(panelContext);
  const result = structureEdit(
    view.state,
    'alignTable',
    { pos: head, ref: { row: 0, col: 0 } },
    { alignOnEdit: !!ctx?.settings.tableAlignOnEdit },
  );
  if (!result.ok) {
    if (result.reason === 'overlong') tellOverlong(view, result.info, 'refused');
    return false;
  }
  if (result.changes.length) view.dispatch({ changes: result.changes, userEvent: TABLE_EVENT });
  return true;
}

export const tableCommands: Feature = {
  id: 'tableCommands',
  commands: { insertTable, alignTable },
};
