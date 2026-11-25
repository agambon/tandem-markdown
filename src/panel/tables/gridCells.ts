// A Pandoc grid table's cells (markdown/gridTables.ts), read from the table's lines: each cell's
// markdown, and where each of its lines lies in the file, since a cell's line is a stretch of a
// file line. So what a cell draws is placed in the file as a line's drawing is, and what is found
// at a place in the file inside a cell (a link, a footnote) is found in that cell's markdown.
//
// A table is read from the positions of the `+` in its first line, which mark the columns;
// every row's `|` and border `+` must stand at those positions. One that does not read so
// (cells that span rows or columns, a missing border) is not a table.

import { language } from '@codemirror/language';
import { Text, type EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { BORDER } from '../markdown/gridTables';
import { LruCache } from '../render/lruCache';

export type GridAlign = 'left' | 'right' | 'center' | null;

export interface GridCell {
  /** The cell's lines less blank lines around them, trailing spaces and the indentation they all share. */
  readonly text: string;
  /** Start offset of each line inside `text`. */
  readonly starts: readonly number[];
  /** Start offset of each line in the file, relative to the table's first line. */
  readonly places: readonly number[];
}

export interface GridRow {
  readonly cells: readonly GridCell[];
  /** Where each of the row's lines starts, counted from the start of the table's first line. */
  readonly lines: readonly number[];
}

export interface GridTable {
  readonly align: GridAlign[];
  readonly head: readonly GridRow[];
  readonly body: readonly GridRow[];
}

/** The blocks a cell draws: paragraphs, lists, and tasks. Any other block in a cell shows as typed. */
const CELL_BLOCKS: ReadonlySet<string> = new Set([
  'Paragraph',
  'BulletList',
  'OrderedList',
  'ListItem',
  'Task',
  'MarkedTask',
]);

/** The columns' alignment from a border line: a `:` at the start, the end or both of each run. */
function alignments(border: string, bounds: readonly number[]): GridAlign[] {
  const out: GridAlign[] = [];
  for (let c = 0; c + 1 < bounds.length; c++) {
    const run = border.slice(bounds[c]! + 1, bounds[c + 1]!);
    const left = run.startsWith(':');
    const right = run.endsWith(':');
    out.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return out;
}

/** One line of a cell as the table holds it: its text between the column's borders, and where that starts. */
interface Part {
  text: string;
  place: number;
}

function cellOf(parts: readonly Part[]): GridCell {
  const lines = parts.map((part) => part.text.trimEnd());
  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first]) first++;
  while (last > first && !lines[last - 1]) last--;
  let common = Infinity;
  for (let n = first; n < last; n++)
    if (lines[n]) common = Math.min(common, lines[n]!.length - lines[n]!.trimStart().length);
  const shared = Number.isFinite(common) ? common : 0;
  const texts: string[] = [];
  const starts: number[] = [];
  const places: number[] = [];
  let at = 0;
  for (let n = first; n < last; n++) {
    const text = lines[n]!.slice(shared);
    texts.push(text);
    starts.push(at);
    places.push(parts[n]!.place + shared);
    at += text.length + 1;
  }
  return { text: texts.join('\n'), starts, places };
}

/**
 * The table that `lines` (a grid table's lines, each with the `indent` characters of the
 * containers it stands in left out) holds, or null when they do not read as one.
 */
export function readGridTable(lines: readonly string[], indent = 0): GridTable | null {
  const first = lines[0]?.trimEnd() ?? '';
  const last = lines[lines.length - 1]?.trimEnd() ?? '';
  if (lines.length < 2 || !BORDER.test(first) || !BORDER.test(last)) return null;
  const bounds: number[] = [];
  for (let i = first.indexOf('+'); i >= 0; i = first.indexOf('+', i + 1)) bounds.push(i);
  const isBorder = (line: string) =>
    line.length === first.length && BORDER.test(line) && bounds.every((b) => line[b] === '+');
  const head: GridRow[] = [];
  const body: GridRow[] = [];
  let align = alignments(first, bounds);
  let parts: Part[][] = bounds.slice(1).map(() => []);
  let rowLines: number[] = [];
  // Where line n starts, from the start of the first line.
  let offset = indent + lines[0]!.length + 1;
  for (let n = 1; n < lines.length; offset += indent + lines[n]!.length + 1, n++) {
    const line = lines[n]!.trimEnd();
    if (isBorder(line)) {
      if (rowLines.length) body.push({ cells: parts.map(cellOf), lines: rowLines });
      parts = bounds.slice(1).map(() => []);
      rowLines = [];
      // The rows above a border of `=` are the header.
      if (line.includes('=')) {
        if (head.length || !body.length) return null;
        head.push(...body.splice(0));
        align = alignments(line, bounds);
      }
      continue;
    }
    if (line.length !== first.length || !bounds.every((b) => line[b] === '|')) return null;
    rowLines.push(offset);
    for (let c = 0; c + 1 < bounds.length; c++)
      parts[c]!.push({ text: line.slice(bounds[c]! + 1, bounds[c + 1]!), place: offset + indent + bounds[c]! + 1 });
  }
  return { align, head, body };
}

export function cellLineEnd(cell: GridCell, k: number): number {
  return k + 1 < cell.starts.length ? cell.starts[k + 1]! - 1 : cell.text.length;
}

function lineOf(cell: GridCell, pos: number): number {
  let lo = 0;
  let hi = cell.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cell.starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where `pos`, a position in `cell.text`, lies in the file, counted from the start of the table's first line. */
export function cellOrigin(cell: GridCell, pos: number): number {
  const k = lineOf(cell, pos);
  return (cell.places[k] ?? 0) + pos - (cell.starts[k] ?? 0);
}

/** The stretches of the file, counted from the start of the table's first line, that [from, to] of `cell.text` covers. */
export function cellSpans(cell: GridCell, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let k = 0; k < cell.starts.length; k++) {
    const start = cell.starts[k]!;
    const a = Math.max(from, start);
    const b = Math.min(to, cellLineEnd(cell, k));
    if (a <= b && (a < b || from === to))
      out.push({ from: cell.places[k]! + a - start, to: cell.places[k]! + b - start });
  }
  return out;
}

/** Where `place` (counted from the start of the table's first line) lies in `cell.text`; null when it is not in the cell's text. */
function cellPosAt(cell: GridCell, place: number): number | null {
  for (let k = 0; k < cell.starts.length; k++) {
    const start = cell.places[k]!;
    if (place >= start && place <= start + cellLineEnd(cell, k) - cell.starts[k]!)
      return cell.starts[k]! + place - start;
  }
  return null;
}

/** Whether `node`, a node of a cell's markdown, is drawn by the cell: neither it nor a block holding it is one shown as typed. */
export function drawnInCell(node: SyntaxNode): boolean {
  for (let up: SyntaxNode | null = node; up && !up.type.isTop; up = up.parent)
    if (up.type.is('Block') && !CELL_BLOCKS.has(up.name)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// A grid table of the file, for what reads the file at a place

/** A grid table of the file, read: where its first line starts in the file, and its rows. */
interface FileGrid {
  readonly start: number;
  readonly table: GridTable;
}

/** A cell of a grid table of the file, its markdown parsed as the file is. */
interface ParsedCell {
  readonly cell: GridCell;
  /** The cell's markdown, which `tree`'s positions count in. */
  readonly doc: Text;
  readonly tree: Tree;
  /** Where `pos`, a position in `doc`, lies in the file. */
  at(pos: number): number;
}

const CACHE_SIZE = 64;
const readings = new LruCache<string, GridTable | null>(CACHE_SIZE);

/** Cached `readGridTable` keyed by lines and container indent. */
export function gridReading(lines: readonly string[], indent: number): GridTable | null {
  const key = `${indent}\n${lines.join('\n')}`;
  let table = readings.get(key);
  if (table === undefined) {
    table = readGridTable(lines, indent);
    readings.set(key, table);
  }
  return table;
}

/** The lines of the `GridTable` node `node` of `doc`, with the indent of the containers it stands in left out. */
function gridLines(doc: Text, node: SyntaxNode): { start: number; indent: number; lines: string[] } {
  const first = doc.lineAt(node.from);
  const indent = node.from - first.from;
  const last = doc.lineAt(Math.min(node.to, doc.length)).number;
  const lines: string[] = [];
  for (let n = first.number; n <= last; n++) lines.push(doc.line(n).text.slice(indent));
  return { start: first.from, indent, lines };
}

/** The `GridTable` node `node` of `state`'s file read as a table; null when it does not read as one. */
export function fileGrid(state: EditorState, node: SyntaxNode): FileGrid | null {
  const { start, indent, lines } = gridLines(state.doc, node);
  const table = gridReading(lines, indent);
  return table && { start, table };
}

export function gridCells(grid: FileGrid): GridCell[] {
  return [...grid.table.head, ...grid.table.body].flatMap((row) => row.cells);
}

const parses = new WeakMap<GridCell, { tree: Tree; doc: Text; of: unknown }>();

/** `cell`, a cell of `grid`, with its markdown parsed by `state`'s language; null when the state has none. */
export function parseCell(state: EditorState, grid: FileGrid, cell: GridCell): ParsedCell | null {
  const lang = state.facet(language);
  if (!lang) return null;
  let parsed = parses.get(cell);
  if (parsed?.of !== lang) {
    parsed = { tree: lang.parser.parse(cell.text), doc: Text.of(cell.text.split('\n')), of: lang };
    parses.set(cell, parsed);
  }
  const { tree, doc } = parsed;
  return { cell, doc, tree, at: (pos) => grid.start + cellOrigin(cell, pos) };
}

/** The cell of `grid` whose text holds the file position `pos`, parsed, with `pos` in it; null when no cell's text holds it. */
export function cellAt(state: EditorState, grid: FileGrid, pos: number): { parsed: ParsedCell; pos: number } | null {
  for (const cell of gridCells(grid)) {
    const at = cellPosAt(cell, pos - grid.start);
    if (at === null) continue;
    const parsed = parseCell(state, grid, cell);
    return parsed && { parsed, pos: at };
  }
  return null;
}
