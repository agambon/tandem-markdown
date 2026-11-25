// Editing a cell (Rich editor). Clicking a cell turns it into a text field holding the cell's
// source text. Enter, Tab, Shift+Tab or leaving the field commit; Escape cancels. A commit
// is one change with the user event `input.table`.
//
// At most one field is open per view. Its cell's span is mapped through every change that
// arrives while the field is open (an update from the document, a merge). Before writing,
// the table is read again from the document as it is then, and the commit goes ahead only
// when no change has touched the cell's text and its span is still exactly one cell's span;
// otherwise the field is dropped and a notice shows what was typed. So a field never writes
// into a place that is not its cell.

import type { Transaction } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { panelContext } from '../context';
import { copyAction } from '../copyText';
import { shortLost } from '../lostText';
import { canEdit } from '../modes';
import { posOf } from '../render/framework';
import { resyncPending } from '../sync';
import { barOf, hideBar, showBar, type BarAction } from './bar';
import {
  checkCell,
  commitPlan,
  mapTarget,
  structureEdit,
  TABLE_EVENT,
  type CellTarget,
  type CheckedCell,
} from './edits';
import { cellElement, fillCell, syncGrid, type GridView } from './grid';
import { cellAt, readTableAt, type CellRef } from './model';
import { tellOverlong } from './overlong';

interface CellEdit extends CellTarget {
  readonly view: EditorView;
  readonly owner: CellEdits;
  readonly root: HTMLElement;
  readonly cell: HTMLElement;
  readonly field: HTMLTextAreaElement;
  readonly ref: CellRef;
  readonly original: string;
  closed: boolean;
}

type Move = 'none' | 'next' | 'previous' | 'down';

const editsByRoot = new WeakMap<HTMLElement, CellEdit>();

class CellEdits {
  current: CellEdit | null = null;
  private readonly onHide: () => void;
  private readonly onScroll = () => {
    if (this.current && !this.current.closed) placeBar(this.current);
  };

  constructor(readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    // A page that is hidden or closing commits its open field first.
    this.onHide = () => {
      if (doc.visibilityState === 'hidden' && this.current) finish(this.current, 'none');
    };
    doc.addEventListener('visibilitychange', this.onHide);
    doc.defaultView?.addEventListener('pagehide', this.onHide);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
  }

  update(update: ViewUpdate): void {
    const s = this.current;
    if (!s || s.closed) return;
    if (update.docChanged) mapTarget(s, update.changes);
    if (!canEdit(update.state)) queueMicrotask(() => finish(s, 'none'));
    else if (update.geometryChanged || update.heightChanged || update.viewportChanged) placeBar(s);
  }

  destroy(): void {
    const doc = this.view.dom.ownerDocument;
    doc.removeEventListener('visibilitychange', this.onHide);
    doc.defaultView?.removeEventListener('pagehide', this.onHide);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    const s = this.current;
    if (!s || s.closed) return;
    // The editor state this field belongs to is gone (a resync or a closing panel): its text
    // cannot be placed, so show it instead.
    const typed = s.field.value;
    close(s);
    if (typed !== s.original) lost(this.view, typed);
  }
}

export const cellEdits = ViewPlugin.fromClass(CellEdits);

export function currentEdit(view: EditorView): CellEdit | null {
  const s = view.plugin(cellEdits)?.current ?? null;
  return s && !s.closed ? s : null;
}

/**
 * Commits an open cell field, if any, so its text is a document change. Called before a
 * `flush` is answered (a save or a close while a cell is being edited). True when a change
 * was made.
 */
export function commitOpenField(view: EditorView): boolean {
  const s = currentEdit(view);
  return !!s && finish(s, 'none') !== null;
}

// ---------------------------------------------------------------------------
// Opening and closing

function rootAt(view: EditorView, from: number): HTMLElement | null {
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>('.tm-table-block')) {
    if (posOf(view, element) === from) return element;
  }
  return null;
}

/** Space between the bar and the table's top when the bar sits above it (the stylesheet's). */
const BAR_GAP_PX = 2;
const placeBarKey = {};

/**
 * Keeps the open field's table bar on screen while any of the table is: above the table as
 * usual, or, for a tall table scrolled past its top, at the top of what is on screen, and
 * never below the table's last row.
 */
function placeBar(s: CellEdit): void {
  s.view.requestMeasure({
    key: placeBarKey,
    read: (view) => {
      const bar = barOf(s.root);
      if (s.closed || !bar || bar.hidden || !s.root.isConnected) return null;
      const block = s.root.getBoundingClientRect();
      const visibleTop = view.scrollDOM.getBoundingClientRect().top;
      const height = bar.offsetHeight;
      const top = Math.min(Math.max(visibleTop - block.top, -(height + BAR_GAP_PX)), block.height - height);
      return { bar, top };
    },
    write: (m) => {
      if (!m) return;
      m.bar.style.bottom = 'auto';
      m.bar.style.top = `${Math.round(m.top)}px`;
    },
  });
}

function fit(field: HTMLTextAreaElement): void {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

/**
 * Opens a field on cell `ref` of the table with a line holding `pos`, its cursor at offset
 * `caret` of the cell's source (at the end when not given). False when there is no such cell
 * drawn as a grid, or a field is already open.
 */
export function openCell(view: EditorView, pos: number, ref: CellRef, caret?: number): boolean {
  const owner = view.plugin(cellEdits);
  if (!owner || owner.current || !canEdit(view.state)) return false;
  const info = readTableAt(view.state, pos);
  if (!info || !info.drawable) return false;
  const cell = cellAt(info, ref);
  const root = cell ? rootAt(view, info.from) : null;
  const element = root ? cellElement(root, ref) : null;
  if (!cell || !root || !element) return false;

  const doc = view.dom.ownerDocument;
  const field = doc.createElement('textarea');
  field.className = 'tm-table-field';
  field.rows = 1;
  field.cols = 1;
  field.value = cell.text;
  field.setAttribute(
    'aria-label',
    ref.row === 0 ? `Header, column ${ref.col + 1}` : `Row ${ref.row}, column ${ref.col + 1}`,
  );

  // Keep the column as wide as it was drawn, so opening a cell does not move the grid. The
  // computed width is the content width unrounded: a field even a fraction of a pixel narrower
  // than its text wraps the text.
  const width = parseFloat(doc.defaultView?.getComputedStyle(element).width ?? '');
  if (width > 0) field.style.minWidth = `${width}px`;

  const edit: CellEdit = {
    view,
    owner,
    root,
    cell: element,
    field,
    ref,
    original: cell.text,
    from: cell.from,
    to: cell.to,
    touched: false,
    col: ref.col,
    closed: false,
  };
  owner.current = edit;
  editsByRoot.set(root, edit);

  element.replaceChildren(field);
  element.classList.add('tm-table-active');
  root.classList.add('tm-table-editing');
  showBar(root, info.width, info.table.rows.length, ref, info.table.align[ref.col]);
  placeBar(edit);

  field.addEventListener('keydown', (event) => onKey(edit, event));
  field.addEventListener('input', () => fit(field));
  // Leaving the field commits it. Deferred: a blur can come from inside an editor update.
  field.addEventListener('blur', () => queueMicrotask(() => finish(edit, 'none')));

  field.focus({ preventScroll: true });
  const cursor = Math.min(caret ?? field.value.length, field.value.length);
  field.setSelectionRange(cursor, cursor);
  fit(field);
  return true;
}

function close(s: CellEdit): void {
  s.closed = true;
  if (s.owner.current === s) s.owner.current = null;
  if (editsByRoot.get(s.root) === s) editsByRoot.delete(s.root);
  s.cell.classList.remove('tm-table-active');
  s.root.classList.remove('tm-table-editing');
  hideBar(s.root);
  s.field.remove();
  if (s.root.contains(s.cell)) fillCell(s.view, s.root, s.cell, s.ref);
}

function lostNotice(typed: string) {
  return `The table changed while you were editing a cell, so what you typed there was not kept: ${shortLost(typed)}`;
}

function reloadingNotice(typed: string) {
  return `This tab is reloading, so what you typed in the cell was not kept: ${shortLost(typed)}`;
}

/** Shows what a field held that was not written, with Copy text, which copies all of it. */
function lost(view: EditorView, typed: string, text = lostNotice(typed)): void {
  const ctx = view.state.facet(panelContext);
  ctx?.notify({ kind: 'warning', sticky: true, text, actions: [copyAction(ctx, 'Copy text', typed)] });
}

function alignOnEdit(view: EditorView): boolean {
  return !!view.state.facet(panelContext)?.settings.tableAlignOnEdit;
}

/** Where a move from a checked cell lands, and whether a row has to be added for it. */
function moveTarget(checked: CheckedCell, move: Move): { ref: CellRef; addRow: boolean } | null {
  const { info, row, col } = checked;
  const last = info.table.rows.length;
  switch (move) {
    case 'next':
      if (col + 1 < info.width) return { ref: { row, col: col + 1 }, addRow: false };
      return { ref: { row: row + 1, col: 0 }, addRow: row >= last };
    case 'previous':
      if (col > 0) return { ref: { row, col: col - 1 }, addRow: false };
      return { ref: row > 0 ? { row: row - 1, col: info.width - 1 } : { row, col }, addRow: false };
    case 'down':
      return { ref: { row: row + 1, col }, addRow: row >= last };
    default:
      return null;
  }
}

/**
 * Commits the field and, for a move, opens the next field. Returns the transaction that wrote
 * the cell, or null when nothing was written.
 */
export function finish(s: CellEdit, move: Move): Transaction | null {
  if (s.closed) return null;
  const { view } = s;
  const typed = s.field.value;
  const changed = typed !== s.original;
  close(s);
  if (s.owner !== view.plugin(cellEdits)) {
    if (changed) lost(view, typed);
    return null;
  }
  if (!changed && move === 'none') return null;
  // The view is waiting to be reloaded from the document: a commit now would be thrown away with it.
  if (resyncPending(view.state)) {
    if (changed) lost(view, typed, reloadingNotice(typed));
    return null;
  }
  const checked = checkCell(view.state, s);
  if (!checked) {
    if (changed) lost(view, typed);
    if (move !== 'none') view.focus();
    return null;
  }
  const target = moveTarget(checked, move);
  const plan = commitPlan(view.state, checked, changed ? typed : null, {
    align: alignOnEdit(view),
    addRow: target?.addRow,
  });
  if (plan.overlong) tellOverlong(view, checked.info, 'cell');
  let tr: Transaction | null = null;
  if (plan.changes.length) {
    tr = view.state.update({ changes: plan.changes, userEvent: TABLE_EVENT });
    view.dispatch(tr);
  }
  if (target) {
    const pos = tr ? tr.changes.mapPos(checked.info.from, -1) : checked.info.from;
    if (!openCell(view, pos, target.ref)) view.focus();
  }
  return tr;
}

/**
 * The key code browsers give a key that an input method takes. The key that starts a composition
 * comes before `compositionstart`, so its `isComposing` is still false: only this code marks it.
 */
const IME_KEY_CODE = 229;

function onKey(s: CellEdit, event: KeyboardEvent): void {
  if (s.closed || event.isComposing || event.keyCode === IME_KEY_CODE) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  let move: Move | 'cancel' | null = null;
  if (event.key === 'Enter' && !event.shiftKey) move = 'down';
  else if (event.key === 'Tab') move = event.shiftKey ? 'previous' : 'next';
  else if (event.key === 'Escape' && !event.shiftKey) move = 'cancel';
  if (!move) return;
  event.preventDefault();
  event.stopPropagation();
  if (move === 'cancel') {
    close(s);
    s.view.focus();
  } else {
    finish(s, move);
  }
}

// ---------------------------------------------------------------------------
// From the widget

/**
 * A click on cell `ref` of the table drawn in `root`, at offset `caret` of the cell's source:
 * commit any open field, then open this one with its cursor there.
 */
export function clickCell(view: EditorView, root: HTMLElement, ref: CellRef, caret: number): void {
  if (!canEdit(view.state)) return;
  const s = currentEdit(view);
  if (s && s.root === root && s.ref.row === ref.row && s.ref.col === ref.col) {
    s.field.focus({ preventScroll: true });
    return;
  }
  const at = posOf(view, root);
  if (at === null) return;
  let pos = at;
  if (s) {
    const tr = finish(s, 'none');
    if (tr) pos = tr.changes.mapPos(pos, -1);
  }
  openCell(view, pos, ref, caret);
}

/** Puts the cursor in the cell's source text, so the table shows as its source lines. */
function editAsText(s: CellEdit): void {
  const { view } = s;
  const at = s.from;
  const tr = finish(s, 'none');
  const pos = Math.min(tr ? tr.changes.mapPos(at, -1) : at, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select' });
  view.focus();
}

export function runAction(view: EditorView, root: HTMLElement, action: BarAction): void {
  const s = currentEdit(view);
  if (!s || s.root !== root) return;
  if (action === 'editAsText') {
    editAsText(s);
    return;
  }
  const typed = s.field.value;
  const changed = typed !== s.original;
  const result = structureEdit(
    view.state,
    action,
    { pending: s, typed: changed ? typed : null },
    { alignOnEdit: alignOnEdit(view) },
  );
  if (!result.ok) {
    if (result.reason === 'changed') {
      close(s);
      if (changed) lost(view, typed);
      view.focus();
      return;
    }
    // The field stays open with its text: a cell commit is still allowed.
    if (result.reason === 'overlong') tellOverlong(view, result.info, 'refused');
    s.field.focus({ preventScroll: true });
    return;
  }
  close(s);
  let pos = result.info.from;
  if (result.changes.length) {
    const tr = view.state.update({ changes: result.changes, userEvent: TABLE_EVENT });
    view.dispatch(tr);
    pos = tr.changes.mapPos(pos, -1);
  }
  if (!openCell(view, pos, result.active)) view.focus();
}

/**
 * A table widget drawing `grid` into an element it drew before. An open field in it stays
 * open (its cell keeps its children) as long as its place is still in the grid.
 */
export function redrawGrid(view: EditorView, root: HTMLElement, grid: GridView): void {
  const s = editsByRoot.get(root);
  const open = s && !s.closed && s.root === root ? s : null;
  const inGrid = !!open && open.ref.row < grid.rows.length && open.ref.col < grid.width;
  syncGrid(view, root, grid, inGrid ? open!.ref : null);
  if (open && inGrid) {
    root.classList.add('tm-table-editing');
    showBar(root, grid.width, grid.rows.length - 1, open.ref, grid.align[open.ref.col]);
  } else if (open) {
    // Its place is gone: commit what can be committed (the check refuses a stale place).
    queueMicrotask(() => finish(open, 'none'));
  }
}

/** A table widget element left the editor. An open field in it is committed. */
export function rootDropped(root: HTMLElement): void {
  const s = editsByRoot.get(root);
  if (s && !s.closed) queueMicrotask(() => finish(s, 'none'));
}
