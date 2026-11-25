// The notices for a table with a body row longer than its header, which the table code will
// not rewrite (the rewrite would delete the extra cells). Each names the row and offers "Show
// the row", which opens Source at it.

import type { EditorView } from '@codemirror/view';
import type { ViewState } from '../../core/protocol';
import { panelContext } from '../context';
import { getMode } from '../modes';
import { reportPlace } from '../reports';
import { overlongRow } from './edits';
import { readTableAt, type TableInfo } from './model';

/** How many lines Source shows above the row. */
const LINES_ABOVE = 3;

/**
 * Tells of the over-long row of `info`: after a cell was written without lining the columns up
 * (`cell`), or when a change to the table was refused (`refused`).
 */
export function tellOverlong(view: EditorView, info: TableInfo, after: 'cell' | 'refused'): void {
  const ctx = view.state.facet(panelContext);
  const row = overlongRow(info, view.state.doc);
  if (!ctx || !row) return;
  const named = `the row starting "${row.start}"`;
  ctx.notify({
    kind: 'warning',
    text:
      after === 'cell'
        ? `Your cell was changed, but the columns weren't lined up: ${named} has more cells than the header.`
        : `That change was not made, because ${named} has more cells than the table's header.`,
    actions: [{ label: 'Show the row', run: () => showRow(view, info.from) }],
  });
}

/**
 * Opens Source at the over-long row of the table that starts at `tableFrom`, read again now,
 * since the note may have changed since the notice. The cursor goes to the row's start and the
 * host is told the place before it is asked for Source, which opens where the tab says it is;
 * the place goes through the reports (`reportPlace`), so no report of the editor's own comes after.
 */
function showRow(view: EditorView, tableFrom: number): void {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return;
  const state = view.state;
  const at = Math.min(tableFrom, state.doc.length);
  const info = readTableAt(state, at);
  const pos = (info && overlongRow(info, state.doc)?.from) ?? state.doc.lineAt(at).from;
  const line = state.doc.lineAt(pos).number - 1;
  const place: ViewState = {
    selection: { anchor: pos, head: pos },
    topLine: Math.max(0, line - LINES_ABOVE),
    topOffsetPx: 0,
    mode: getMode(state),
  };
  view.dispatch({ selection: { anchor: pos }, effects: reportPlace.of(place) });
  ctx.bridge.post({ type: 'showSource' });
}
