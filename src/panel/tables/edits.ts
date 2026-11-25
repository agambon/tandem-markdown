// Table edits as pure functions of the editor state: a cell commit, the structure edits of
// the table bar, "Align table", and a new table. Each gives the changes to dispatch (or why
// it gives none) and never touches a view, so all of it is tested headless.

import type { ChangeDesc, ChangeSpec, EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  cellFromInput,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  setAlign,
  toData,
  writeTable,
  type Align,
  type TableData,
} from '../../core/tableModel';
import { lineIsBlank, placeBlock } from '../commands/placeBlock';
import { codeAt, treeForLine } from '../markdown/tree';
import {
  cellAt,
  emptyRow,
  endsWithPipe,
  findCell,
  isAligned,
  isMissing,
  lineOfRow,
  readTableAt,
  rewriteChange,
  type CellRef,
  type TableInfo,
} from './model';

/** The user event every table change carries: not typing, so it is sent to the document at once. */
export const TABLE_EVENT = 'input.table';

/** The most characters of a row's first cell a notice quotes to name the row, the "…" included. */
const ROW_NAME_CHARS = 40;

/**
 * The first body row with more cells than the header: where its line starts, and how the row
 * starts (its first cell, or its text when that cell is empty), cut for a notice.
 */
export function overlongRow(info: TableInfo, doc: Text): { from: number; start: string } | null {
  for (let i = 2; i < info.lines.length; i++) {
    const line = info.lines[i]!;
    if (line.count <= info.width) continue;
    const first = info.table.rows[i - 2]?.[0]?.text.trim() ?? '';
    const start = first || doc.sliceString(line.from, line.to).slice(line.prefix.length).trim();
    const chars = Array.from(start);
    return {
      from: line.from,
      start: chars.length > ROW_NAME_CHARS ? `${chars.slice(0, ROW_NAME_CHARS - 1).join('')}…` : start,
    };
  }
  return null;
}

/** The cell an open field was opened on, its span mapped through every change since. */
export interface CellTarget {
  from: number;
  to: number;
  /** A change has touched the span since the field opened. */
  touched: boolean;
  /** The column the field opened in: the cells a short row does not have share one spot. */
  col?: number;
}

/**
 * Carries a target across `changes` (a change that arrived while the field was open). Text
 * put right at either edge of the span counts as inside it, and as touching it.
 */
export function mapTarget(target: CellTarget, changes: ChangeDesc): void {
  if (changes.touchesRange(target.from, target.to)) target.touched = true;
  target.from = changes.mapPos(target.from, -1);
  target.to = changes.mapPos(target.to, 1);
}

/** The cell a target still names: the table read again from the document as it is then. */
export interface CheckedCell extends CellRef {
  info: TableInfo;
}

/**
 * Finds the cell the target was opened on, reading the table again from `state`. Null when
 * that cell cannot be trusted any more: a change touched its text, or its span is not
 * exactly one cell's span in the table as it is in state.
 */
export function checkCell(state: EditorState, target: CellTarget): CheckedCell | null {
  if (target.touched) return null;
  const info = readTableAt(state, target.from);
  if (!info) return null;
  const hit = findCell(info, target.from, target.to, target.col);
  return hit ? { info, row: hit.row, col: hit.col } : null;
}

function dataWith(info: TableInfo, ref: CellRef, text: string | null): TableData {
  const data = toData(info.table);
  if (text === null) return data;
  if (ref.row === 0) data.header[ref.col] = text;
  else data.rows[ref.row - 1]![ref.col] = text;
  return data;
}

/** Adds an empty body row at the end of `data`. */
function withRow(data: TableData): TableData {
  return { ...data, rows: [...data.rows, data.header.map(() => '')] };
}

interface CommitPlan {
  changes: ChangeSpec[];
  /** The table could not be padded because a row is longer than its header; only the cell was written. */
  overlong: boolean;
}

/**
 * The changes that write `typed` into a checked cell (null: the field was not changed), and,
 * with `addRow`, add an empty row at the end of the table. With `align`
 * (settings.tableAlignOnEdit) the whole table is rewritten padded, unless a row is longer
 * than its header: then only the cell is written and `overlong` says so. Without it only the
 * cell's span changes, except for a cell the row does not have, where that one row is
 * rewritten with its missing cells added.
 */
export function commitPlan(
  state: EditorState,
  checked: CheckedCell,
  typed: string | null,
  options: { align: boolean; addRow?: boolean | undefined },
): CommitPlan {
  const { info } = checked;
  const doc = state.doc;
  const cell = cellAt(info, checked)!;
  const text = typed === null ? cell.text : cellFromInput(typed);
  const changed = text !== cell.text;
  if (!changed && !options.addRow) return { changes: [], overlong: false };

  if (options.align && !info.overlong) {
    let data = dataWith(info, checked, changed ? text : null);
    if (options.addRow) data = withRow(data);
    const change = rewriteChange(doc, info, writeTable(data, { align: true }));
    return { changes: change ? [change] : [], overlong: false };
  }

  const changes: ChangeSpec[] = [];
  if (changed && isMissing(info, checked)) {
    const line = lineOfRow(info, checked.row);
    const start = line.from + line.prefix.length;
    let row = doc.sliceString(start, line.to).replace(/[ \t]+$/, '');
    if (!endsWithPipe(row)) row += ' |';
    for (let col = line.count; col < info.width; col++) row += ` ${col === checked.col ? text : ''} |`;
    changes.push({ from: start, to: line.to, insert: row });
  } else if (changed) {
    changes.push({ from: cell.from, to: cell.to, insert: text });
  }
  if (options.addRow) {
    const last = info.lines[info.lines.length - 1]!;
    changes.push({ from: info.to, insert: '\n' + last.prefix + emptyRow(info.width) });
  }
  return { changes, overlong: options.align && info.overlong };
}

// ---------------------------------------------------------------------------
// Structure edits (the table bar)

export type TableAction =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteRow'
  | 'deleteColumn'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'moveRowUp'
  | 'moveRowDown'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'alignTable';

const ALIGN_OF: Partial<Record<TableAction, Align>> = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right' };

/** The table after `action` at `ref`, and the cell to be active afterward. Null when the action does not apply there. */
export function applyAction(
  data: TableData,
  action: TableAction,
  ref: CellRef,
): { data: TableData; active: CellRef } | null {
  const { row, col } = ref;
  const body = row - 1;
  const width = data.header.length;
  const rows = data.rows.length;
  const done = (next: TableData, active: CellRef) => (next === data ? null : { data: next, active });
  switch (action) {
    case 'insertRowAbove':
      return row >= 1 ? done(insertRow(data, body), { row, col }) : null;
    case 'insertRowBelow':
      return done(insertRow(data, row), { row: row + 1, col });
    case 'insertColumnLeft':
      return done(insertColumn(data, col), { row, col });
    case 'insertColumnRight':
      return done(insertColumn(data, col + 1), { row, col: col + 1 });
    case 'deleteRow':
      return row >= 1 ? done(deleteRow(data, body), { row: Math.min(row, rows - 1), col }) : null;
    case 'deleteColumn':
      return width > 1 ? done(deleteColumn(data, col), { row, col: Math.min(col, width - 2) }) : null;
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight': {
      const align = ALIGN_OF[action]!;
      // Pressing the column's own alignment again takes it off.
      const next = (data.align[col] ?? 'none') === align ? 'none' : align;
      return done(setAlign(data, col, next), { row, col });
    }
    case 'moveRowUp':
      return row >= 2 ? done(moveRow(data, body, body - 1), { row: row - 1, col }) : null;
    case 'moveRowDown':
      return row >= 1 && body < rows - 1 ? done(moveRow(data, body, body + 1), { row: row + 1, col }) : null;
    case 'moveColumnLeft':
      return col >= 1 ? done(moveColumn(data, col, col - 1), { row, col: col - 1 }) : null;
    case 'moveColumnRight':
      return col < width - 1 ? done(moveColumn(data, col, col + 1), { row, col: col + 1 }) : null;
    case 'alignTable':
      return { data, active: ref };
  }
}

/** Whether `action` can apply at `ref` in a table of this size (for the bar's buttons). */
export function canApply(action: TableAction, width: number, rows: number, ref: CellRef): boolean {
  const { row, col } = ref;
  switch (action) {
    case 'insertRowAbove':
    case 'deleteRow':
      return row >= 1;
    case 'moveRowUp':
      return row >= 2;
    case 'moveRowDown':
      return row >= 1 && row < rows;
    case 'deleteColumn':
      return width > 1;
    case 'moveColumnLeft':
      return col >= 1;
    case 'moveColumnRight':
      return col < width - 1;
    default:
      return true;
  }
}

type StructureResult =
  | { ok: true; changes: ChangeSpec[]; info: TableInfo; active: CellRef }
  | { ok: false; reason: 'changed' | 'none' }
  /** `info`: the table read, so the row can be named. */
  | { ok: false; reason: 'overlong'; info: TableInfo };

/**
 * A structure edit (or "Align table") on the table holding `at`, as one rewrite of the whole
 * table through the model. With `pending`, an open field's text goes into its cell in the
 * same change; the field's cell is checked first, as a commit checks it.
 *
 * The table is written padded for "Align table", when settings.tableAlignOnEdit is on, or
 * when it is padded already (so an aligned table stays aligned); otherwise compact.
 * Refused when a row is longer than the header (the rewrite would delete its extra cells).
 */
export function structureEdit(
  state: EditorState,
  action: TableAction,
  at: { pos: number; ref: CellRef } | { pending: CellTarget; typed: string | null },
  options: { alignOnEdit: boolean },
): StructureResult {
  let info: TableInfo | null;
  let ref: CellRef;
  let typed: string | null = null;
  if ('pending' in at) {
    const checked = checkCell(state, at.pending);
    if (!checked) return { ok: false, reason: 'changed' };
    info = checked.info;
    ref = { row: checked.row, col: checked.col };
    typed = at.typed;
  } else {
    info = readTableAt(state, at.pos);
    if (!info) return { ok: false, reason: 'none' };
    ref = at.ref;
  }
  if (info.overlong) return { ok: false, reason: 'overlong', info };
  const data = dataWith(info, ref, typed === null ? null : cellFromInput(typed));
  const result = applyAction(data, action, ref);
  if (!result) return { ok: false, reason: 'none' };
  const align = action === 'alignTable' || options.alignOnEdit || isAligned(info, state.doc);
  const change = rewriteChange(state.doc, info, writeTable(result.data, { align }));
  return { ok: true, changes: change ? [change] : [], info, active: result.active };
}

// ---------------------------------------------------------------------------
// A new table

/** Block nodes that are containers: a new table goes after the leaf block, not after these. */
const CONTAINERS = new Set(['Document', 'BulletList', 'OrderedList', 'ListItem', 'Blockquote', 'FootnoteDef']);

/** The end of the last line of the leaf block (paragraph, table, code...) holding `pos`, or of `pos`'s own line. */
function leafBlockEnd(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  const tree = treeForLine(state, pos);
  for (let node: SyntaxNode | null = tree.resolveInner(line.to, -1); node; node = node.parent) {
    if (node.type.is('Block') && !CONTAINERS.has(node.name)) return Math.max(line.to, state.doc.lineAt(node.to).to);
  }
  return line.to;
}

interface NewTable {
  changes: ChangeSpec;
  /** Where the table's first line starts once inserted. */
  tableFrom: number;
  /** A cursor on the line after the table, so the table draws as a grid. */
  cursor: number;
}

/**
 * True when `pos` is inside a block whose lines are its text (code, front matter, HTML): a
 * table on one of its blank lines would become part of it.
 */
function inRawBlock(state: EditorState, pos: number): boolean {
  return codeAt(treeForLine(state, pos), pos)?.kind === 'block';
}

/**
 * A 3 by 3 table (a header row and two body rows, every cell empty) at the cursor's line:
 * on that line when it has no text, otherwise after the block that holds it (always after a
 * code block). It goes in as a paste of a block does (`placeBlock`): blank lines before and
 * after as markdown needs, and inside a list item or a quote, that item's indent or the
 * quote's marks on every line. There is always a line after the table for the cursor.
 */
export function newTable(state: EditorState): NewTable {
  const doc = state.doc;
  const head = state.selection.main.head;
  const line = doc.lineAt(head);
  const table = writeTable(
    {
      header: ['', '', ''],
      align: ['none', 'none', 'none'],
      rows: [
        ['', '', ''],
        ['', '', ''],
      ],
    },
    { align: true },
  );
  const onLine = lineIsBlank(state, line.number) && !inRawBlock(state, head);
  const at = onLine ? line.from : leafBlockEnd(state, head);
  const placed = placeBlock(state, table, { from: at, to: onLine ? line.to : at });
  const insert = placed.lineAfter ? placed.insert : `${placed.insert}\n`;
  // The table's first line starts after the last line break inserted before it, or where the line
  // it goes into starts.
  const lead = insert.slice(0, placed.start - placed.from);
  const tableFrom = lead.includes('\n') ? placed.from + lead.lastIndexOf('\n') + 1 : doc.lineAt(placed.from).from;
  return { changes: { from: placed.from, to: placed.to, insert }, tableFrom, cursor: placed.end + 1 };
}
