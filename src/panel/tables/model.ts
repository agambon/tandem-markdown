// Tables as the panel sees them: the parser's `Table` node read with core/tableModel, every
// span a document offset, plus what the editing code needs to know about the source.
//
// A table inside a quote or a list item has a prefix on each line (`> `, indentation). The
// prefixes are blanked to spaces before core/tableModel reads the lines, so its offsets stay
// document offsets, and a rewrite of the whole table puts each line's prefix back.

import type { ChangeSpec, EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { CODE_BACKSLASH, CODE_LF } from '../../core/markdownText';
import { countCells, parseTable, toData, writeTable, type ParsedTable, type TableCell } from '../../core/tableModel';
import { treeForLine } from '../markdown/tree';

interface TableLine {
  /** The line's start and end in the document. */
  from: number;
  to: number;
  /** What stands before the row on this line: indentation, quote markers. */
  prefix: string;
  /** How many cells the line holds as written (a row may hold more or fewer than the header). */
  count: number;
}

export interface TableInfo {
  node: SyntaxNode;
  /** Start of the table's first line and end of its last line. */
  from: number;
  to: number;
  /** One per line: the header, the delimiter row, then the body rows. */
  lines: TableLine[];
  /** core/tableModel's reading, with every span a document offset. */
  table: ParsedTable;
  /** The number of columns (the header's cell count). */
  width: number;
  /**
   * A body row holds more cells than the header. GFM does not show the extra cells, and a
   * rewrite of the whole table through writeTable would delete their text.
   */
  overlong: boolean;
  /**
   * False when the table starts on a list item's marker line (`- | a | b |`): drawing it as a
   * grid would hide the item's marker, so it stays source text.
   */
  drawable: boolean;
}

/** A cell by its place in the grid: row 0 is the header, rows 1 and on are the body rows. */
export interface CellRef {
  row: number;
  col: number;
}

const ROW_NODES = new Set(['TableHeader', 'TableDelimiter', 'TableRow']);

function shift(cell: TableCell, by: number): TableCell {
  return { text: cell.text, from: cell.from + by, to: cell.to + by };
}

/** Reads a `Table` node. Null when its lines are not what the parser's rows say they are. */
export function readTable(doc: Text, node: SyntaxNode): TableInfo | null {
  const rows: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (ROW_NODES.has(child.name)) rows.push(child);
  const firstLine = doc.lineAt(node.from);
  const lastLine = doc.lineAt(node.to);
  if (rows.length !== lastLine.number - firstLine.number + 1) return null;
  const lines: TableLine[] = [];
  let cleaned = '';
  for (let i = 0; i < rows.length; i++) {
    const line = doc.line(firstLine.number + i);
    const row = rows[i]!;
    if (row.from < line.from || row.from > line.to) return null;
    const prefix = line.text.slice(0, row.from - line.from);
    const content = line.text.slice(row.from - line.from);
    lines.push({ from: line.from, to: line.to, prefix, count: countCells(content) });
    cleaned += (i ? '\n' : '') + ' '.repeat(prefix.length) + content;
  }
  const parsed = parseTable(cleaned);
  if (!parsed) return null;
  const by = firstLine.from;
  const table: ParsedTable = {
    header: parsed.header.map((c) => shift(c, by)),
    align: parsed.align,
    rows: parsed.rows.map((row) => row.map((c) => shift(c, by))),
  };
  const width = table.header.length;
  return {
    node,
    from: firstLine.from,
    to: lastLine.to,
    lines,
    table,
    width,
    overlong: lines.slice(2).some((l) => l.count > width),
    drawable: /^[ \t>]*$/.test(lines[0]!.prefix),
  };
}

/** The innermost `Table` node with a line holding `pos`. */
export function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const line = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length)));
  let found: SyntaxNode | null = null;
  treeForLine(state, line.from).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name === 'Table') {
        if (node.from <= line.to && node.to >= line.from) found = node.node;
        return false;
      }
      return node.type.isTop || node.type.is('Block');
    },
  });
  return found;
}

/** The table with a line holding `pos`, read. */
export function readTableAt(state: EditorState, pos: number): TableInfo | null {
  const node = tableNodeAt(state, pos);
  return node ? readTable(state.doc, node) : null;
}

/** The line of `info.lines` that holds grid row `row`. */
export function lineOfRow(info: TableInfo, row: number): TableLine {
  return info.lines[row === 0 ? 0 : row + 1]!;
}

export function cellAt(info: TableInfo, ref: CellRef): TableCell | null {
  const row = ref.row === 0 ? info.table.header : info.table.rows[ref.row - 1];
  return row?.[ref.col] ?? null;
}

/**
 * The cell whose span is exactly [from, to], with its place in the grid. The cells a short
 * row does not have all sit at one spot (the end of its line), so `col` says which of them;
 * null when it is not one of them.
 */
export function findCell(
  info: TableInfo,
  from: number,
  to: number,
  col?: number,
): (CellRef & { cell: TableCell }) | null {
  const rows = [info.table.header, ...info.table.rows];
  const hits: (CellRef & { cell: TableCell })[] = [];
  for (let row = 0; row < rows.length; row++) {
    const cells = rows[row]!;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]!;
      if (cell.from === from && cell.to === to) hits.push({ row, col: c, cell });
    }
  }
  if (hits.length <= 1) return hits[0] ?? null;
  return hits.find((hit) => hit.col === col) ?? null;
}

/** True for a cell the row does not have at all (the row is shorter than the header). */
export function isMissing(info: TableInfo, ref: CellRef): boolean {
  return ref.col >= lineOfRow(info, ref.row).count;
}

/** True when the table's source is exactly what writeTable writes with `align: true`. */
export function isAligned(info: TableInfo, doc: Text): boolean {
  const written = writeTable(toData(info.table), { align: true }).split('\n');
  if (written.length !== info.lines.length) return false;
  return info.lines.every((line, i) => doc.sliceString(line.from + line.prefix.length, line.to) === written[i]);
}

/**
 * The single change that turns `old` (at `from`) into `next`, or null when they are equal.
 * It covers whole lines: the lines both share at the start and at the end are left out, so a
 * new row is one inserted line and an edited row one replaced line.
 */
function minimalChange(from: number, old: string, next: string): ChangeSpec | null {
  if (old === next) return null;
  let start = 0;
  while (start < old.length && start < next.length && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  start = old.lastIndexOf('\n', start - 1) + 1;
  const lineStart = (text: string, at: number) => at === start || text.charCodeAt(at - 1) === CODE_LF;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old.charCodeAt(old.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  while (end > 0 && !(lineStart(old, old.length - end) && lineStart(next, next.length - end))) end--;
  return { from: from + start, to: from + old.length - end, insert: next.slice(start, next.length - end) };
}

/** The prefix a rewritten table's line `i` gets: the old line's, or the last old line's for an added line. */
function prefixFor(info: TableInfo, i: number): string {
  return (info.lines[i] ?? info.lines[info.lines.length - 1]!).prefix;
}

/**
 * The change that replaces the table's lines with `text` (lines without prefixes, as
 * writeTable writes them), each line given back its prefix. Null when nothing changes.
 */
export function rewriteChange(doc: Text, info: TableInfo, text: string): ChangeSpec | null {
  const next = text
    .split('\n')
    .map((line, i) => prefixFor(info, i) + line)
    .join('\n');
  return minimalChange(info.from, doc.sliceString(info.from, info.to), next);
}

/** An empty body row of `width` cells, as text: `|  |  |`. */
export function emptyRow(width: number): string {
  return '| ' + new Array<string>(width).fill('').join(' | ') + ' |';
}

/** True when `text` ends with a pipe no backslash escapes. */
export function endsWithPipe(text: string): boolean {
  if (!text.endsWith('|')) return false;
  let run = 0;
  while (run < text.length - 1 && text.charCodeAt(text.length - 2 - run) === CODE_BACKSLASH) run++;
  return run % 2 === 0;
}
