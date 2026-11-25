// Grid tables (markdown/gridTables.ts), drawn as a table: a drawn block (render/drawnBlock.ts)
// whose pencil, or the cursor, opens the source above the drawing. The cells are read-only in
// the drawing: a grid table's columns are kept by padding every line of a row to its borders,
// so a change to one cell rewrites the whole row, which the table editor's promise of one
// cell's change in the file cannot keep.
//
// A cell's markdown (tables/gridCells.ts) is drawn by an editor state of its own that holds that
// part of the file (`filePart`): its paragraphs and lists are drawn, and its inline content as a
// line draws it (`inlineDrawing`), with the file's definitions and footnote numbers, the marks
// other features draw (`BlockDraw.marks`), and each character's origin in the file, so a link or a
// tag in it follows and shows its card as in a table's cell. The text a table is drawn from
// begins with a key of all of that.

import { syntaxTree } from '@codemirror/language';
import { StateEffect, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isSpaceOrTab } from '../../core/markdownText';
import { runCommand } from '../commands/registry';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { innerState } from '../innerStates';
import { getMode, type Mode } from '../modes';
import {
  cellLineEnd,
  cellOrigin,
  cellSpans,
  gridReading,
  type GridAlign,
  type GridCell,
  type GridRow,
  type GridTable,
} from '../tables/gridCells';
import { codeLines } from './code';
import { drawBlock, drawnBlockKeys, drawnBlockStart, drawnBlockTheme, type DrawnKind } from './drawnBlock';
import { followsLink } from './follow';
import {
  blockFeature,
  drawnSpan,
  filePart,
  inlineDrawing,
  inlineKey,
  marksKey,
  recordElementOrigin,
  setDrawingStart,
  withFullTree,
  type BlockDraw,
  type FilePart,
  type RichWidget,
} from './framework';
import { inlineDom, inlineText } from './inlineDom';
import type { BlockEntry } from './lines';
import { toggleTaskAt } from './lists';

/** The feature drawn again when a module a cell's inline content needs has loaded. */
const OWNER = 'gridTables';

/**
 * Where a table was drawn from: the state its build saw, where the table's first line starts
 * in it, and the marks other features draw over the table there.
 */
interface GridPlace {
  state: EditorState;
  start: number;
  marks: readonly DecorationSet[];
}

/** What a drawing's cells are drawn with, and the widgets drawn in them, destroyed with the drawing. */
interface CellDrawer {
  view: EditorView;
  ctx: PanelContext;
  mode: Mode;
  place: GridPlace;
  widgets: [HTMLElement, RichWidget][];
}

/** A cell being drawn: its markdown, the state that reads it, and the other features' marks over it, at its positions. */
interface DrawnCell {
  cell: GridCell;
  state: EditorState;
  marks: DecorationSet[];
}

/** The marks over `cell`'s text of each of `place`'s sets, at the cell's positions. */
function cellMarks(place: GridPlace, cell: GridCell): DecorationSet[] {
  return place.marks.map((set) => {
    const ranges: Range<Decoration>[] = [];
    cell.starts.forEach((start, k) => {
      const from = place.start + cell.places[k]!;
      const to = from + cellLineEnd(cell, k) - start;
      set.between(from, to, (a, b, deco) => {
        const at = Math.max(a, from);
        const end = Math.min(b, to);
        if (!(deco as Decoration & { point: boolean }).point && end > at)
          ranges.push(deco.range(start + at - from, start + end - from));
      });
    });
    return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
  });
}

/** The classes of the marks other features draw on `row`'s lines themselves (the outside-change mark). */
function lineClasses(place: GridPlace, row: GridRow): string[] {
  const classes = new Set<string>();
  for (const set of place.marks) {
    for (const line of row.lines) {
      const at = place.start + line;
      set.between(at, at, (from, _to, deco) => {
        if (from === at && (deco as Decoration & { point: boolean }).point && deco.spec.class)
          for (const name of String(deco.spec.class).split(' ')) if (name) classes.add(name);
      });
    }
  }
  return [...classes];
}

/** The inline content of `block`, a block of the cell's markdown, in [from, to], as a line draws it. */
function inlineNodes(
  drawer: CellDrawer,
  drawn: DrawnCell,
  block: SyntaxNode,
  from = block.from,
  to = block.to,
): Node[] {
  const drawing = inlineDrawing(drawn.state, OWNER, [block]);
  const origin = (pos: number) => cellOrigin(drawn.cell, pos);
  const nodes = inlineDom(drawer.view, [...drawing, ...drawn.marks], drawn.cell.text, from, to, origin);
  drawer.widgets.push(...nodes.widgets);
  return nodes.nodes;
}

/** First block child of `parent`, or null. */
function firstBlockChild(parent: SyntaxNode): SyntaxNode | null {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.type.is('Block')) return child;
  }
  return null;
}

/** Draws a `Task` or `MarkedTask` block inside a grid table cell with an interactive checkbox or mark box. */
function taskNodes(drawer: CellDrawer, drawn: DrawnCell, block: SyntaxNode): Node[] {
  const marker = block.firstChild;
  if (!marker || (marker.name !== 'TaskMarker' && marker.name !== 'MarkedTaskMarker')) {
    return inlineNodes(drawer, drawn, block);
  }
  const doc = drawer.view.dom.ownerDocument;
  const text = drawn.cell.text;
  const source = text.slice(marker.from, marker.to);
  let contentFrom = marker.to;
  while (contentFrom < block.to && isSpaceOrTab(text.charCodeAt(contentFrom))) contentFrom++;
  const drawing = inlineDrawing(drawn.state, OWNER, [block]);
  const label = inlineText(drawing, drawn.state.doc, contentFrom, block.to).replace(/\s+/g, ' ').trim() || 'Task';
  const origin = (pos: number) => cellOrigin(drawn.cell, pos);
  const inline = inlineDom(drawer.view, [...drawing, ...drawn.marks], text, contentFrom, block.to, origin);
  drawer.widgets.push(...inline.widgets);

  const box = doc.createElement('span');
  box.className = 'tm-task-box tm-grid-task-box';
  const relFrom = cellOrigin(drawn.cell, marker.from);
  const relTo = cellOrigin(drawn.cell, marker.to);
  recordElementOrigin(box, relFrom, relTo);

  if (block.name === 'MarkedTask') {
    const mark = doc.createElement('span');
    mark.className = 'tm-task-mark';
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', `${label}, marked ${source[1] ?? ''}`);
    const char = doc.createElement('span');
    char.className = 'tm-task-mark-char';
    char.textContent = source[1] ?? '';
    mark.appendChild(char);
    box.appendChild(mark);
  } else {
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.className = 'tm-task';
    input.tabIndex = -1;
    input.checked = source[1] !== ' ';
    input.disabled = drawer.ctx.doc.readOnly;
    input.setAttribute('aria-label', label);
    recordElementOrigin(input, relFrom, relTo);
    input.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    input.addEventListener('click', (event) => {
      event.stopPropagation();
      const tableStart = drawnBlockStart(drawer.view, input);
      if (tableStart === null || !toggleTaskAt(drawer.view, tableStart + relFrom)) {
        input.checked = !input.checked;
      }
    });
    box.appendChild(input);
  }
  return [box, ...inline.nodes];
}

/** The DOM for a cell's markdown: paragraphs, lists, and tasks drawn, other blocks as typed; a lone paragraph or task as its nodes. */
function blockNodes(drawer: CellDrawer, drawn: DrawnCell, parent: SyntaxNode): Node[] {
  const doc = drawer.view.dom.ownerDocument;
  const blocks: SyntaxNode[] = [];
  for (let block = parent.firstChild; block; block = block.nextSibling) if (block.type.is('Block')) blocks.push(block);
  const only = blocks.length === 1 ? blocks[0]! : null;
  if (only?.name === 'Paragraph') return inlineNodes(drawer, drawn, only);
  if (only && (only.name === 'Task' || only.name === 'MarkedTask')) return taskNodes(drawer, drawn, only);
  const out: Node[] = [];
  for (const block of blocks) {
    if (block.name === 'Paragraph') {
      const p = doc.createElement('p');
      p.append(...inlineNodes(drawer, drawn, block));
      out.push(p);
    } else if (block.name === 'Task' || block.name === 'MarkedTask') {
      const p = doc.createElement('p');
      p.append(...taskNodes(drawer, drawn, block));
      out.push(p);
    } else if (block.name === 'BulletList' || block.name === 'OrderedList') {
      const list = doc.createElement(block.name === 'BulletList' ? 'ul' : 'ol');
      for (let item = block.firstChild; item; item = item.nextSibling) {
        if (item.name !== 'ListItem') continue;
        const li = doc.createElement('li');
        const first = firstBlockChild(item);
        if (first && (first.name === 'Task' || first.name === 'MarkedTask')) li.className = 'tm-grid-task';
        li.append(...blockNodes(drawer, drawn, item));
        list.appendChild(li);
      }
      out.push(list);
    } else {
      const p = doc.createElement('p');
      p.className = 'tm-grid-raw';
      p.textContent = drawn.state.doc.sliceString(block.from, block.to);
      out.push(p);
    }
  }
  return out;
}

/**
 * An editor state for `cell`'s markdown that holds that part of the file: of `file`, in which
 * the table's first line starts at `start`.
 */
export function gridCellState(
  ctx: PanelContext,
  mode: Mode,
  file: EditorState,
  start: number,
  cell: GridCell,
): EditorState {
  const part: FilePart = {
    state: file,
    at: (pos) => start + cellOrigin(cell, pos),
    spans: (from, to) => cellSpans(cell, from, to).map((span) => ({ from: start + span.from, to: start + span.to })),
  };
  const own = innerState(file, { ctx, text: cell.text, mode });
  return withFullTree(own.update({ effects: StateEffect.appendConfig.of(filePart.of(part)) }).state);
}

function cellElement(
  drawer: CellDrawer,
  tag: 'th' | 'td',
  cell: GridCell,
  row: GridRow,
  align: GridAlign,
): HTMLTableCellElement {
  const view = drawer.view;
  const element = view.dom.ownerDocument.createElement(tag);
  if (align) element.style.textAlign = align;
  element.classList.add(...lineClasses(drawer.place, row));
  // The cell's origins count from the table's first line, wherever the table stands when asked.
  setDrawingStart(element, () => drawnBlockStart(view, element));
  if (cell.text) {
    const { ctx, mode, place } = drawer;
    const state = gridCellState(ctx, mode, place.state, place.start, cell);
    const drawn: DrawnCell = { cell, state, marks: cellMarks(place, cell) };
    element.append(...blockNodes(drawer, drawn, syntaxTree(drawn.state).topNode));
  }
  return element;
}

/** The table drawn, with createElement and text nodes only. A link or a tag in a cell follows with a link's keys. */
function drawGridTable(drawer: CellDrawer, table: GridTable): HTMLTableElement {
  const view = drawer.view;
  const element = view.dom.ownerDocument.createElement('table');
  element.className = 'tm-table tm-grid-table';
  const sections: [HTMLTableSectionElement, readonly GridRow[], 'th' | 'td'][] = [];
  if (table.head.length) sections.push([element.createTHead(), table.head, 'th']);
  if (table.body.length) sections.push([element.createTBody(), table.body, 'td']);
  for (const [section, rows, tag] of sections) {
    for (const row of rows) {
      const tr = section.insertRow();
      row.cells.forEach((cell, c) => tr.appendChild(cellElement(drawer, tag, cell, row, table.align[c] ?? null)));
    }
  }
  element.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    if (event.button !== 0 || !target || !followsLink(view, event)) return;
    const span = drawnSpan(target);
    if (span && runCommand(view, 'openLink', { at: span.from, cell: true })) event.preventDefault();
  });
  return element;
}

/** Separates the parts of the key a table is drawn under. */
const KEY_SEP = '\u0000';

/** A grid table longer than this shows as code with a "Draw anyway" button. */
const GRID_LIMIT = 100_000;
/** The height kept for a grid table never measured. */
const GRID_ESTIMATE = 160;

const GRID_TABLE: DrawnKind<GridPlace> = {
  name: 'Table',
  editLabel: 'Edit the table',
  doneLabel: 'Done editing the table',
  limit: GRID_LIMIT,
  estimate: GRID_ESTIMATE,
  draw(text, view, place) {
    // The first line is the key the table was drawn under (`drawnText`), its indent first.
    const head = text.slice(0, text.indexOf('\n'));
    const table = gridReading(text.slice(head.length + 1).split('\n'), Number(head.slice(0, head.indexOf(KEY_SEP))));
    const ctx = view.state.facet(panelContext);
    if (!table || !ctx) return { error: 'This grid table could not be read.' };
    const drawer: CellDrawer = { view, ctx, mode: getMode(view.state), place, widgets: [] };
    const node = drawGridTable(drawer, table);
    return {
      node,
      dispose: () => {
        for (const [element, widget] of drawer.widgets) widget.destroy(element);
      },
    };
  },
};

/**
 * What a grid table is drawn from: on its first line a key of all the drawing reads beyond the
 * table's lines (the indent of the containers it stands in, `inlineKey`, what its cells read of
 * where they stand, the other features' marks over it), its line breaks made spaces, as a link
 * definition's title can hold one; then the table's lines.
 */
function drawnText(
  d: BlockDraw,
  block: BlockEntry,
  indent: number,
  lines: readonly string[],
  place: GridPlace,
): string {
  const key = [indent, inlineKey(d.state), d.placeKey(block.node), marksKey(place.marks, place.start)].join(KEY_SEP);
  return `${key.replace(/\n/g, ' ')}\n${lines.join('\n')}`;
}

export const gridTables: Feature = {
  id: 'gridTables',
  extension: () => [
    blockFeature(
      'gridTables',
      (d) => {
        d.blocks((block) => {
          if (block.name !== 'GridTable') return;
          const start = d.lines.start(block.firstLine);
          const indent = block.from - start;
          const lines: string[] = [];
          for (let n = block.firstLine; n <= block.lastLine; n++) lines.push(d.lines.text(n).slice(indent));
          if (!gridReading(lines, indent)) return codeLines(d, block.firstLine, block.lastLine);
          const place: GridPlace = { state: d.state, start, marks: d.marks(start, d.lines.end(block.lastLine)) };
          drawBlock(d, block, GRID_TABLE, drawnText(d, block, indent, lines, place), false, place);
        });
      },
      { inline: true },
    ),
    drawnBlockKeys,
    drawnBlockTheme,
    EditorView.baseTheme({
      '& .cm-content .tm-grid-table td, & .cm-content .tm-grid-table th': { cursor: 'default' },
      '& .cm-content .tm-grid-table p': { margin: '0 0 8px' },
      '& .cm-content .tm-grid-table p:last-child': { marginBottom: '0' },
      '& .cm-content .tm-grid-table ul, & .cm-content .tm-grid-table ol': { margin: '0', paddingLeft: '1.5em' },
      '& .cm-content .tm-grid-table li.tm-grid-task': { listStyle: 'none', marginLeft: '-1.35em' },
      '& .cm-content .tm-grid-table .tm-grid-task-box': {
        display: 'inline-block',
        paddingRight: '0.4em',
        textAlign: 'left',
      },
      '& .cm-content .tm-grid-table .tm-grid-raw': { fontFamily: 'var(--tm-mono)', whiteSpace: 'pre-wrap' },
    }),
  ],
};
