// The grid a table widget draws: its cells' places and drawing, built when the table is drawn,
// and the DOM for it, updated in place so an open cell field survives a redraw of its table.
//
//   div.tm-table-block            the widget (layout classes for lists and quotes)
//     div.tm-table-bar            the structure bar, shown while a cell is being edited
//     div.tm-table-scroll         scrolls sideways when the table is wider than the column
//       table.tm-table            row 0 in thead > tr > th, rows 1 and on in tbody > tr > td
//
// Every cell carries `data-row` and `data-col`. Cells a short row lacks are drawn empty; cells
// past the header's width are not drawn (as GFM shows them). A cell's content is the inline
// features' drawing of its `TableCell` node (render/inlineDom.ts), as a line draws it.

import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { Align } from '../../core/tableModel';
import {
  inlineDrawing,
  originsOf,
  placeKey,
  posOf,
  sameDrawing,
  setDrawingStart,
  sourceMarks,
  type BlockDraw,
  type InlineDrawing,
  type RichWidget,
} from '../render/framework';
import { inlineDom } from '../render/inlineDom';
import type { CellRef, TableInfo } from './model';

/** The feature whose grids hold the cells' drawing: drawn again when a module the cells need loads. */
const OWNER = 'tables';

/** One row of a grid, which depends on its line's text and nothing else of the table. */
export interface RowView {
  source: string;
  /** Each cell's start and end in `source`. */
  cells: (readonly [number, number])[];
  /** The inline features' drawing of the cells, positions in `source`. */
  drawing: InlineDrawing;
}

/** What other features mark on a row's line (`markSources`): over its text, positions in the row's source, and on the line. */
interface RowMarks {
  sets: InlineDrawing;
  /** The classes of the line's own decorations, given to each of the row's cells. */
  line: string;
}

const NO_MARKS: RowMarks = { sets: [], line: '' };

export interface GridView {
  width: number;
  align: Align[];
  /** Row 0 is the header. */
  rows: readonly RowView[];
  /** Where each row's line starts, from the start of the table's first line. */
  starts: readonly number[];
  marks: readonly RowMarks[];
}

function rowMarks(reads: GridReads, info: TableInfo, lines: readonly { from: number; to: number }[]): RowMarks[] {
  const sources = reads.marks(info.from, info.to);
  const found = lines.map(() => ({ ranges: sources.map(() => [] as Range<Decoration>[]), line: [] as string[] }));
  sources.forEach((set, k) => {
    let at = 0;
    set.between(info.from, info.to, (from, to, deco) => {
      while (at + 1 < lines.length && lines[at + 1]!.from <= from) at++;
      const line = lines[at]!;
      if (from < line.from || from > line.to) return;
      if ((deco as Decoration & { point: boolean }).point) {
        if (from === line.from && deco.spec.class) found[at]!.line.push(String(deco.spec.class));
      } else if (to > from) {
        found[at]!.ranges[k]!.push(deco.range(from - line.from, Math.min(to, line.to) - line.from));
      }
    });
  });
  return found.map(({ ranges, line }) =>
    line.length || ranges.some((r) => r.length)
      ? { sets: ranges.map((r) => (r.length ? Decoration.set(r, true) : Decoration.none)), line: line.join(' ') }
      : NO_MARKS,
  );
}

function sameMarks(a: RowMarks, b: RowMarks): boolean {
  return a === b || (a.line === b.line && sameDrawing(a.sets, b.sets));
}

/**
 * Rows drawn before, by `key`: their line's text and what their drawing reads of where they stand
 * (`placeKey`). `get` gives one still right, `keep` the one to use for a new row.
 */
export interface RowCache {
  get(key: string): RowView | undefined;
  keep(key: string, row: RowView): RowView;
}

const NO_CACHE: RowCache = { get: () => undefined, keep: (_key, row) => row };

/**
 * What a grid reads beyond its text: a block build's (`BlockDraw`), which notes what it read so
 * that the table is drawn again when that changes, or the state's alone.
 */
type GridReads = Pick<BlockDraw, 'placeKey' | 'marks'>;

function stateReads(state: EditorState): GridReads {
  return { placeKey: (node) => placeKey(state, node), marks: (from, to) => sourceMarks(state, from, to) };
}

/**
 * The grid for a table: its rows' cells and their drawing from their `TableCell` nodes, the rows
 * `cache` still has taken from it and the others drawn together, with what `reads` gives of
 * where each row stands and of other features' marks.
 */
export function gridOf(
  state: EditorState,
  info: TableInfo,
  cache: RowCache = NO_CACHE,
  reads: GridReads = stateReads(state),
): GridView {
  const lines = [info.lines[0]!, ...info.lines.slice(2)];
  const places = [info.table.header, ...info.table.rows];
  const rowNodes: SyntaxNode[] = [];
  for (let row = info.node.firstChild; row; row = row.nextSibling)
    if (row.name === 'TableHeader' || row.name === 'TableRow') rowNodes.push(row);
  const rows: (RowView | null)[] = [];
  /** The rows to draw, each with its index and its line's start. */
  const unread: { index: number; from: number; key: string }[] = [];
  /** Their row nodes, whose cells the inline features draw: a walk over a row is a walk over its cells. */
  const toDraw: SyntaxNode[] = [];
  lines.forEach((line, index) => {
    const node = rowNodes[index];
    const key = `${state.doc.sliceString(line.from, line.to)}\u0000${node ? reads.placeKey(node) : ''}`;
    const known = cache.get(key);
    rows.push(known ?? null);
    if (known || !node) return;
    unread.push({ index, from: line.from, key });
    toDraw.push(node);
  });
  if (unread.length) {
    // One drawing for every row to draw, its ranges then shared out by row.
    const ranges = unread.map(() => [] as Range<Decoration>[][]);
    for (const set of inlineDrawing(state, OWNER, toDraw)) {
      ranges.forEach((row) => row.push([]));
      let at = 0;
      for (let cursor = set.iter(); cursor.value; cursor.next()) {
        while (at + 1 < unread.length && unread[at + 1]!.from <= cursor.from) at++;
        const from = unread[at]!.from;
        ranges[at]!.at(-1)!.push(cursor.value.range(cursor.from - from, cursor.to - from));
      }
    }
    unread.forEach(({ index, from, key }, i) => {
      const line = lines[index]!;
      const drawing: DecorationSet[] = ranges[i]!.map((r) => (r.length ? Decoration.set(r) : Decoration.none));
      rows[index] = cache.keep(key, {
        source: state.doc.sliceString(line.from, line.to),
        cells: places[index]!.map((cell) => [cell.from - from, cell.to - from] as const),
        drawing,
      });
    });
  }
  return {
    width: info.width,
    align: info.table.align,
    rows: rows as RowView[],
    starts: lines.map((line) => line.from - info.from),
    marks: rowMarks(reads, info, lines),
  };
}

export function sameGrid(a: GridView, b: GridView): boolean {
  return (
    a.width === b.width &&
    a.align.join() === b.align.join() &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => row === b.rows[i] && sameMarks(a.marks[i] ?? NO_MARKS, b.marks[i] ?? NO_MARKS))
  );
}

/** The widgets drawn in each widget element's cells, so each is destroyed when its element leaves. */
const cellWidgets = new WeakMap<HTMLElement, Map<HTMLElement, RichWidget>>();

/** Destroys the widgets drawn in `root`'s cells that have left it (every one of them with `all`). */
export function sweepWidgets(root: HTMLElement, all = false): void {
  const widgets = cellWidgets.get(root);
  if (!widgets) return;
  for (const [element, widget] of widgets) {
    if (!all && root.contains(element)) continue;
    widget.destroy(element);
    widgets.delete(element);
  }
}

/** Where the cell element `cell`'s source starts in the document, from the grid last drawn into `root`. */
function cellStart(view: EditorView, root: HTMLElement, cell: HTMLElement): number | null {
  const ref = refOf(cell);
  const grid = lastGrid(root);
  const place = ref && grid?.rows[ref.row]?.cells[ref.col];
  const table = place ? posOf(view, root) : null;
  return table === null || !place ? null : table + grid!.starts[ref!.row]! + place[0];
}

function drawCell(view: EditorView, root: HTMLElement, cell: HTMLElement, grid: GridView, ref: CellRef): void {
  const row = grid.rows[ref.row];
  const place = row?.cells[ref.col];
  if (!row || !place) {
    cell.replaceChildren();
    return;
  }
  const marks = grid.marks[ref.row] ?? NO_MARKS;
  const drawn = inlineDom(view, [...row.drawing, ...marks.sets], row.source, place[0], place[1]);
  setDrawingStart(cell, () => cellStart(view, root, cell));
  let widgets = cellWidgets.get(root);
  if (!widgets) cellWidgets.set(root, (widgets = new Map()));
  for (const [element, widget] of drawn.widgets) widgets.set(element, widget);
  cell.replaceChildren(...drawn.nodes);
}

/** The last grid each widget element drew, so a closing field can draw its cell again. */
const drawnGrids = new WeakMap<HTMLElement, GridView>();

function lastGrid(root: HTMLElement): GridView | undefined {
  return drawnGrids.get(root);
}

export function tableOf(root: HTMLElement): HTMLTableElement | null {
  return root.querySelector<HTMLTableElement>('table.tm-table');
}

export function cellElement(root: HTMLElement, ref: CellRef): HTMLTableCellElement | null {
  const table = tableOf(root);
  if (!table) return null;
  const row = ref.row === 0 ? table.tHead?.rows[0] : table.tBodies[0]?.rows[ref.row - 1];
  return (row?.cells[ref.col] as HTMLTableCellElement | undefined) ?? null;
}

export function refOf(cell: HTMLElement): CellRef | null {
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  return Number.isInteger(row) && Number.isInteger(col) ? { row, col } : null;
}

export function fillCell(view: EditorView, root: HTMLElement, cell: HTMLElement, ref: CellRef): void {
  const grid = lastGrid(root);
  if (grid) drawCell(view, root, cell, grid, ref);
  else cell.replaceChildren();
  sweepWidgets(root);
}

function setAlign(cell: HTMLElement, align: Align | undefined): void {
  cell.style.textAlign = !align || align === 'none' ? '' : align;
}

/** The row each table row element shows, with the width and the marks it was drawn with. */
const drawnRows = new WeakMap<HTMLTableRowElement, { row: RowView; width: number; marks: RowMarks }>();

/**
 * Brings the table inside `root` to `grid`, reusing rows and cells in place. The cell at
 * `keep` (an open field) keeps its children; a row that shows the same `RowView` at the same
 * width, with the same marks, keeps its cells' content; everything else is drawn again.
 */
export function syncGrid(view: EditorView, root: HTMLElement, grid: GridView, keep: CellRef | null): void {
  drawnGrids.set(root, grid);
  const doc = root.ownerDocument;
  const table = tableOf(root)!;
  const head = table.tHead ?? table.createTHead();
  const body = table.tBodies[0] ?? table.createTBody();

  const syncRow = (tr: HTMLTableRowElement, row: number, tag: 'th' | 'td') => {
    const shown = drawnRows.get(tr);
    const marks = grid.marks[row] ?? NO_MARKS;
    const same =
      !!shown &&
      shown.row === grid.rows[row] &&
      shown.width === grid.width &&
      tr.cells.length === grid.width &&
      sameDrawing(shown.marks.sets, marks.sets);
    const lineBefore = shown?.marks.line.split(' ').filter(Boolean) ?? [];
    const lineNow = marks.line.split(' ').filter(Boolean);
    drawnRows.set(tr, { row: grid.rows[row]!, width: grid.width, marks });
    for (let col = 0; col < grid.width; col++) {
      let cell = tr.cells[col] as HTMLTableCellElement | undefined;
      if (!cell) {
        cell = doc.createElement(tag);
        tr.appendChild(cell);
      }
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      setAlign(cell, grid.align[col]);
      // The classes of the line's own marks (the outside-change mark) go on each of its cells.
      cell.classList.remove(...lineBefore);
      cell.classList.add(...lineNow);
      if ((keep && keep.row === row && keep.col === col) || same) continue;
      drawCell(view, root, cell, grid, { row, col });
    }
    while (tr.cells.length > grid.width) tr.deleteCell(-1);
  };

  const headRow = head.rows[0] ?? head.insertRow();
  syncRow(headRow, 0, 'th');
  while (head.rows.length > 1) head.deleteRow(-1);

  const bodyRows = grid.rows.length - 1;
  for (let i = 0; i < bodyRows; i++) syncRow(body.rows[i] ?? body.insertRow(), i + 1, 'td');
  while (body.rows.length > bodyRows) body.deleteRow(-1);
  sweepWidgets(root);
}

function textsOf(element: Element): Text[] {
  const texts: Text[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  return texts;
}

/** The source offset of the caret position (node, offset) in a drawn cell whose text nodes are `texts`. */
function originAt(texts: readonly Text[], node: Node, offset: number): number | undefined {
  if (node.nodeType === Node.TEXT_NODE) return originsOf(node as Text)?.[offset];
  // A position between elements: the start of the next text, or the end of the last.
  const point = node.ownerDocument!.createRange();
  point.setStart(node, offset);
  for (const text of texts) if (point.comparePoint(text, 0) >= 0) return originsOf(text)?.[0];
  const last = texts[texts.length - 1];
  return last && originsOf(last)?.[last.length];
}

function distance(rect: DOMRect, x: number, y: number): number {
  return Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
}

function caretRect(text: Text, offset: number): DOMRect {
  const range = text.ownerDocument.createRange();
  range.setStart(text, offset);
  return range.getBoundingClientRect();
}

/**
 * True when (x, y) lies on the cell's text or inside its content box, not in its padding. The
 * text counts too: with collapsed borders the box can be off by half a border's width.
 */
function inContent(cell: HTMLElement, x: number, y: number): boolean {
  const contents = cell.ownerDocument.createRange();
  contents.selectNodeContents(cell);
  if ([...contents.getClientRects()].some((r) => distance(r, x, y) === 0)) return true;
  const rect = cell.getBoundingClientRect();
  const style = cell.ownerDocument.defaultView?.getComputedStyle(cell);
  const pad = (side: 'Left' | 'Right' | 'Top' | 'Bottom') => parseFloat(style?.[`padding${side}`] ?? '') || 0;
  const left = rect.left + cell.clientLeft + pad('Left');
  const top = rect.top + cell.clientTop + pad('Top');
  const right = rect.left + cell.clientLeft + cell.clientWidth - pad('Right');
  const bottom = rect.top + cell.clientTop + cell.clientHeight - pad('Bottom');
  return x >= left && x <= right && y >= top && y <= bottom;
}

/**
 * Where in the table's source, from its first line's start, lies the middle of what `element`
 * draws in cell `ref` of the grid last drawn into `root`: a place inside the link or tag it
 * stands for. Null when it draws no text from the source.
 */
export function elementSource(root: HTMLElement, ref: CellRef, element: Element): number | null {
  const grid = lastGrid(root);
  const place = grid?.rows[ref.row]?.cells[ref.col];
  const texts = textsOf(element).filter((text) => originsOf(text));
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (!place || !first || !last) return null;
  const from = originsOf(first)![0]!;
  const to = originsOf(last)![last.length]!;
  return grid!.starts[ref.row]! + place[0] + Math.floor((from + to) / 2);
}

/**
 * The offset in a cell's source, from the cell's start, for a click at (x, y) on the drawn
 * cell, read from the origins its text nodes carry: inside its content, the caret position
 * there; in its padding, the nearer end of its text.
 */
export function sourceOffsetAt(cell: HTMLElement, x: number, y: number): number {
  const texts = textsOf(cell);
  const first = texts[0];
  const last = texts[texts.length - 1];
  if (!first || !last) return 0;
  if (inContent(cell, x, y)) {
    const caret = cell.ownerDocument.caretPositionFromPoint(x, y);
    const at = caret && cell.contains(caret.offsetNode) ? originAt(texts, caret.offsetNode, caret.offset) : undefined;
    if (at !== undefined) return at;
  }
  const start = originsOf(first)?.[0] ?? 0;
  const end = originsOf(last)?.[last.length] ?? start;
  return distance(caretRect(first, 0), x, y) < distance(caretRect(last, last.length), x, y) ? start : end;
}
