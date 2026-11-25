// GFM pipe tables: parse a table's source lines, write a table back, and edit its structure.
//
// Rows and cells are found the way @lezer/markdown's Table extension finds them (the
// parser the panel draws with), so a cell's span here is the same span the panel sees:
// a pipe divides cells unless a backslash escapes it (inside code spans too), a
// backslash escapes whatever character follows it, and a cell's text is trimmed of
// spaces and tabs. Rows shorter than the header are padded with empty cells and longer
// ones are cut, as GFM renders them.
//
// `splitRow` and DELIMITER_ROW follow @lezer/markdown 1.8.1's `parseRow` and `delimiterLine`
// (MIT), with no blockquote markers in the delimiter row. @lezer/markdown's notice:
//
//   Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { CODE_BACKSLASH, CODE_PIPE, isSpaceOrTab } from './markdownText';

export type Align = 'none' | 'left' | 'center' | 'right';

export interface TableCell {
  /** The cell's source text as written, trimmed. */
  text: string;
  /**
   * That text's span in the table source. An empty cell between two pipes has a
   * zero-length span one space in from its opening pipe, so text put there reads "| x |".
   * A cell the row does not have at all (the row is shorter than the header) has a
   * zero-length span at the end of its row's line, and is the only kind of cell whose
   * span sits there: text put at that spot becomes a new cell only when the line ends
   * with a pipe, so write such a cell by rewriting the row or the table.
   */
  from: number;
  to: number;
}

export interface ParsedTable {
  header: TableCell[];
  align: Align[];
  rows: TableCell[][];
}

export interface TableData {
  header: string[];
  align: Align[];
  rows: string[][];
}

// The delimiter row, as @lezer/markdown tests it (without its blockquote markers).
const DELIMITER_ROW = /^[ \t]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

interface RawCell {
  from: number;
  to: number;
}

/**
 * Splits one line into cells, as @lezer/markdown's parseRow does. A leading pipe opens
 * the row without making a cell; every later pipe closes one; text after the last pipe
 * is a cell; a trailing pipe makes no extra cell. Offsets are within the line.
 */
function splitRow(line: string): RawCell[] {
  const cells: RawCell[] = [];
  let first = true;
  let cellStart = -1;
  let cellEnd = -1;
  let esc = false;
  let lastPipe = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === CODE_PIPE && !esc) {
      if (!first || cellStart > -1) {
        cells.push(cellStart > -1 ? { from: cellStart, to: cellEnd } : { from: emptySpot(line, lastPipe, i), to: -1 });
      }
      first = false;
      lastPipe = i;
      cellStart = cellEnd = -1;
    } else if (esc || !isSpaceOrTab(c)) {
      if (cellStart < 0) cellStart = i;
      cellEnd = i + 1;
    }
    esc = !esc && c === CODE_BACKSLASH;
  }
  if (cellStart > -1) cells.push({ from: cellStart, to: cellEnd });
  for (const cell of cells) if (cell.to < 0) cell.to = cell.from;
  return cells;
}

/** How many cells a row's text holds as written, counted the way @lezer/markdown counts them. */
export function countCells(line: string): number {
  return splitRow(line).length;
}

/**
 * Where an empty cell between the pipes at `open` and `close` sits: one space in from
 * the opening pipe when there is a space, so text typed there reads "| x |".
 */
function emptySpot(line: string, open: number, close: number): number {
  const spot = open + 1;
  const space = spot < close && isSpaceOrTab(line.charCodeAt(spot));
  return space ? spot + 1 : spot;
}

/** True when the line holds a pipe that no backslash escapes. */
function hasPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === CODE_PIPE) return true;
    if (c === CODE_BACKSLASH) i++;
  }
  return false;
}

function alignOf(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':') && t.length > 1;
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return 'none';
}

/**
 * Parses the source of one table (its lines only, LF). Returns null when the lines are
 * not a GFM table: fewer than two lines, a header line with no unescaped pipe, a
 * delimiter row that is not one, a header and delimiter row with different cell
 * counts, or a blank line inside the table. A final newline (or trailing blank lines) is allowed.
 */
export function parseTable(source: string): ParsedTable | null {
  const lines: { text: string; start: number }[] = [];
  let start = 0;
  while (start <= source.length) {
    const nl = source.indexOf('\n', start);
    const end = nl < 0 ? source.length : nl;
    lines.push({ text: source.slice(start, end), start });
    if (nl < 0) break;
    start = nl + 1;
  }
  const blank = (l: { text: string }) => /^[ \t]*$/.test(l.text);
  while (lines.length > 0 && blank(lines[lines.length - 1]!)) lines.pop();
  if (lines.length < 2) return null;
  if (lines.some(blank)) return null;

  const headerLine = lines[0]!;
  const delimiterLine = lines[1]!;
  if (!hasPipe(headerLine.text)) return null;
  if (!DELIMITER_ROW.test(delimiterLine.text)) return null;
  const headerRaw = splitRow(headerLine.text);
  const delimiterRaw = splitRow(delimiterLine.text);
  if (headerRaw.length !== delimiterRaw.length || headerRaw.length === 0) return null;

  const toCell = (line: { text: string; start: number }, c: RawCell): TableCell => ({
    text: line.text.slice(c.from, c.to),
    from: line.start + c.from,
    to: line.start + c.to,
  });

  const width = headerRaw.length;
  const header = headerRaw.map((c) => toCell(headerLine, c));
  const align = delimiterRaw.map((c) => alignOf(delimiterLine.text.slice(c.from, c.to)));
  const rows: TableCell[][] = [];
  for (let r = 2; r < lines.length; r++) {
    const line = lines[r]!;
    const raw = splitRow(line.text).slice(0, width);
    const row = raw.map((c) => toCell(line, c));
    // A missing cell sits, zero-length, at the end of its row's line.
    const end = line.start + line.text.length;
    while (row.length < width) row.push({ text: '', from: end, to: end });
    rows.push(row);
  }
  return { header, align, rows };
}

export function toData(table: ParsedTable): TableData {
  return {
    header: table.header.map((c) => c.text),
    align: [...table.align],
    rows: table.rows.map((row) => row.map((c) => c.text)),
  };
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Writes a table. Every line has leading and trailing pipes; no final newline.
 * With `align: true` every cell is padded to its column's width (East Asian wide
 * characters count as two), left, right or centered as the column is aligned, and the
 * delimiter row is as wide as the column. With `align: false` each cell has one space
 * either side. Either way a delimiter cell has at least three dashes: `---`, `:---`,
 * `---:`, `:---:`.
 *
 * Cells are written as given, except that what would break the table is made safe the
 * way cellFromInput does it: a line break becomes <br> and an unescaped pipe is escaped.
 * Rows are fitted to the header: short rows get empty cells, long rows are cut.
 * Throws a RangeError for a table with no columns.
 */
export function writeTable(data: TableData, options: { align: boolean }): string {
  const cols = data.header.length;
  if (cols === 0) throw new RangeError('writeTable: a table needs at least one column');
  const header = data.header.map(safeCell);
  const align = fit(data.align, cols, 'none' as Align);
  const rows = data.rows.map((row) => fit(row, cols, '').map(safeCell));

  if (!options.align) {
    const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
    const delim = align.map((a) => delimiterCell(a, minDelimiterWidth(a)));
    return [line(header), line(delim), ...rows.map(line)].join('\n');
  }

  const widths = header.map((h, c) => {
    let w = Math.max(minDelimiterWidth(align[c]!), displayWidth(h));
    for (const row of rows) w = Math.max(w, displayWidth(row[c]!));
    return w;
  });
  const line = (cells: string[]) => '| ' + cells.map((cell, c) => pad(cell, widths[c]!, align[c]!)).join(' | ') + ' |';
  const delim = '| ' + align.map((a, c) => delimiterCell(a, widths[c]!)).join(' | ') + ' |';
  return [line(header), delim, ...rows.map(line)].join('\n');
}

/** Three dashes plus the alignment colons. */
function minDelimiterWidth(align: Align): number {
  return align === 'center' ? 5 : align === 'none' ? 3 : 4;
}

function delimiterCell(align: Align, width: number): string {
  switch (align) {
    case 'left':
      return ':' + '-'.repeat(width - 1);
    case 'center':
      return ':' + '-'.repeat(width - 2) + ':';
    case 'right':
      return '-'.repeat(width - 1) + ':';
    default:
      return '-'.repeat(width);
  }
}

function pad(cell: string, width: number, align: Align): string {
  const room = width - displayWidth(cell);
  if (room <= 0) return cell;
  if (align === 'right') return ' '.repeat(room) + cell;
  if (align === 'center') {
    const left = Math.floor(room / 2);
    return ' '.repeat(left) + cell + ' '.repeat(room - left);
  }
  return cell + ' '.repeat(room);
}

function fit<T>(items: readonly T[], length: number, filler: T): T[] {
  const out = items.slice(0, length);
  while (out.length < length) out.push(filler);
  return out;
}

function safeCell(text: string): string {
  return escapePipes(text.replace(/\r\n|\r|\n/g, '<br>'));
}

/** Escapes every pipe not already escaped (a pipe after an odd run of backslashes is escaped). */
function escapePipes(text: string): string {
  if (text.indexOf('|') < 0) return text;
  let out = '';
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '|' && !esc) out += '\\';
    out += c;
    esc = !esc && c === '\\';
  }
  return out;
}

/**
 * What the user typed into a cell, as cell source: trimmed, each line break written
 * <br>, every unescaped pipe escaped. A trailing lone backslash is doubled, so it shows
 * as a backslash and does not swallow the space before the next pipe.
 */
export function cellFromInput(text: string): string {
  let t = safeCell(text.trim());
  let run = 0;
  while (run < t.length && t[t.length - 1 - run] === '\\') run++;
  if (run % 2 === 1) t += '\\';
  return t;
}

// ---------------------------------------------------------------------------
// Display width

// East Asian Wide and Fullwidth ranges (Unicode EastAsianWidth W and F), plus emoji.
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

const COMBINING = /[\p{Mn}\p{Me}]/u;

/** Joiners, direction marks and variation selectors: present in the text, drawn as nothing. */
const isInvisible = (cp: number) => (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f);

/** Columns a string fills in a monospace font: wide characters 2, combining marks 0, others 1. */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x7f) w += cp >= 0x20 ? 1 : 0;
    else if (isInvisible(cp) || COMBINING.test(ch)) continue;
    else w += isWide(cp) ? 2 : 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Spreadsheet paste

/**
 * Tab-separated text, as a spreadsheet puts on the clipboard, as an aligned table
 * source with the first row as header, every column unaligned. Quoted fields ("a""b",
 * or a cell holding a line break) are read the way Excel and Google Sheets write them,
 * and a line break inside a cell becomes <br>. Returns null unless there are at least two
 * rows, every row has the same number of fields, at least two, and some row has two
 * non-empty fields: that keeps a single line with a tab, code indented with tabs, or prose
 * with a stray tab from turning into a table.
 */
export function tsvToTable(tsv: string): string | null {
  const rows = readTsv(tsv);
  if (rows.length < 2) return null;
  const width = rows[0]!.length;
  if (width < 2) return null;
  if (rows.some((r) => r.length !== width)) return null;
  if (!rows.some((r) => r.filter((f) => f.trim() !== '').length >= 2)) return null;
  const cells = rows.map((r) => r.map(cellFromInput));
  return writeTable(
    { header: cells[0]!, align: cells[0]!.map(() => 'none' as Align), rows: cells.slice(1) },
    { align: true },
  );
}

/** Rows of fields. A final line break is dropped. */
function readTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let atFieldStart = true;
  while (i < text.length) {
    const c = text[i]!;
    if (atFieldStart && c === '"') {
      const quoted = readQuoted(text, i);
      if (quoted) {
        field = quoted.value;
        i = quoted.end;
        atFieldStart = false;
        continue;
      }
      // An opening quote with no proper closing one is plain text.
    }
    if (c === '\t') {
      row.push(field);
      field = '';
      atFieldStart = true;
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      atFieldStart = false;
      i++;
    }
  }
  if (!atFieldStart || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A quoted field starting at `start` (on its opening quote): it runs to the next quote
 * that is not doubled, and must be followed by a tab, a line break or the end. Null
 * when it is not a quoted field.
 */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let j = start + 1;
  let value = '';
  for (;;) {
    const q = text.indexOf('"', j);
    if (q < 0) return null;
    value += text.slice(j, q);
    if (text[q + 1] === '"') {
      value += '"';
      j = q + 2;
    } else {
      j = q + 1;
      break;
    }
  }
  const next = text[j];
  if (next !== undefined && next !== '\t' && next !== '\n' && next !== '\r') return null;
  return { value, end: j };
}

// ---------------------------------------------------------------------------
// Structure edits. Each returns new TableData and leaves its argument alone; an edit
// that cannot apply (an index out of range, deleting the last column) returns the
// same object it was given, so `result === data` means nothing changed.

export function insertRow(d: TableData, index: number): TableData {
  if (!isIndex(index, d.rows.length + 1)) return d;
  const rows = d.rows.map((r) => [...r]);
  rows.splice(
    index,
    0,
    d.header.map(() => ''),
  );
  return { header: [...d.header], align: [...d.align], rows };
}

/** Deletes a body row; the header row cannot be deleted. */
export function deleteRow(d: TableData, index: number): TableData {
  if (!isIndex(index, d.rows.length)) return d;
  const rows = d.rows.map((r) => [...r]);
  rows.splice(index, 1);
  return { header: [...d.header], align: [...d.align], rows };
}

/** Moves body row `from` so that it ends up at index `to`. */
export function moveRow(d: TableData, from: number, to: number): TableData {
  if (!isIndex(from, d.rows.length) || !isIndex(to, d.rows.length) || from === to) return d;
  const rows = d.rows.map((r) => [...r]);
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row!);
  return { header: [...d.header], align: [...d.align], rows };
}

export function insertColumn(d: TableData, index: number): TableData {
  const cols = d.header.length;
  if (!isIndex(index, cols + 1)) return d;
  const insert = <T>(items: readonly T[], filler: T) => {
    const out = fit(items, cols, filler);
    out.splice(index, 0, filler);
    return out;
  };
  return {
    header: insert(d.header, ''),
    align: insert(d.align, 'none' as Align),
    rows: d.rows.map((r) => insert(r, '')),
  };
}

/** Deletes a column; a table's last column cannot be deleted. */
export function deleteColumn(d: TableData, index: number): TableData {
  const cols = d.header.length;
  if (cols <= 1 || !isIndex(index, cols)) return d;
  const remove = <T>(items: readonly T[], filler: T) => {
    const out = fit(items, cols, filler);
    out.splice(index, 1);
    return out;
  };
  return {
    header: remove(d.header, ''),
    align: remove(d.align, 'none' as Align),
    rows: d.rows.map((r) => remove(r, '')),
  };
}

/** Moves column `from` so that it ends up at index `to`. */
export function moveColumn(d: TableData, from: number, to: number): TableData {
  const cols = d.header.length;
  if (!isIndex(from, cols) || !isIndex(to, cols) || from === to) return d;
  const move = <T>(items: readonly T[], filler: T) => {
    const out = fit(items, cols, filler);
    const [item] = out.splice(from, 1);
    out.splice(to, 0, item!);
    return out;
  };
  return {
    header: move(d.header, ''),
    align: move(d.align, 'none' as Align),
    rows: d.rows.map((r) => move(r, '')),
  };
}

export function setAlign(d: TableData, column: number, align: Align): TableData {
  const cols = d.header.length;
  if (!isIndex(column, cols)) return d;
  const next = fit(d.align, cols, 'none' as Align);
  if (next[column] === align && d.align.length === cols) return d;
  next[column] = align;
  return { header: [...d.header], align: next, rows: d.rows.map((r) => [...r]) };
}

function isIndex(i: number, length: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < length;
}
