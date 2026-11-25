// What several features share about where text sits: the deepest list and quote the stylesheet
// has classes for, a marker box's width, hiding a line's source indentation (a container's
// included), removing a block, and marking or hiding a stretch that runs over lines.

import type { SyntaxNode } from '@lezer/common';
import { isSpaceOrTab } from '../../core/markdownText';
import { CODE_GREATER_THAN, columnsBetween, nextColumn } from '../markdown/chars';
import type { BlockDraw, InlineDraw } from './framework';
import type { BlockEntry } from './lines';

/** Deepest list depth the stylesheet has a class for (`tm-ld<n>`); deeper items draw at this depth. */
export const MAX_LIST_DEPTH = 9;

/** Deepest quote depth the stylesheet has a class for (`tm-qd<n>`). */
export const MAX_QUOTE_DEPTH = 6;

/** Left indentation of a block widget matching the list and quote lines it replaces. */
export const BLOCK_INDENT = 'calc(var(--tm-ld, 0) * var(--tm-list-step) + var(--tm-qd, 0) * var(--tm-quote-step))';

/** Classes that give a block widget the list and quote depth (and quote bars) of the lines it replaces. */
export function blockLayoutClasses(block: BlockEntry): string {
  const classes: string[] = [];
  if (block.listDepth > 0) classes.push(`tm-ld${Math.min(block.listDepth, MAX_LIST_DEPTH)}`);
  if (block.quoteDepth > 0) {
    let outermost: SyntaxNode | null = null;
    for (let n = block.node.parent; n; n = n.parent) if (n.name === 'Blockquote') outermost = n;
    let lists = 0;
    for (let n = outermost?.parent ?? null; n; n = n.parent) if (n.name === 'ListItem') lists++;
    classes.push(
      'tm-quote',
      `tm-qd${Math.min(block.quoteDepth, MAX_QUOTE_DEPTH)}`,
      `tm-qx${Math.min(lists, MAX_LIST_DEPTH)}`,
    );
  }
  return classes.join(' ');
}

/**
 * Markers up to this many characters fit the box (one list step). A wider one (a numbered
 * list's `1000. `, a task's `- [ ] ` or a footnote's `[^note]: ` shown as typed) takes
 * `tm-mw<n>` (n characters), on its line or on itself: the box grows to the left, as a
 * browser's list numbers do, so the text stays where its next lines start and does not move
 * when the marker is revealed.
 */
const FITS = 3;
/** The widest class the stylesheet has (nine digits, a `.`, spaces, a task's `[ ]`). */
const WIDEST = 20;

/** The class for a marker box `chars` characters wide, or '' when it fits one list step. */
export function markerWidthClass(chars: number): string {
  return chars > FITS ? `tm-mw${Math.min(chars, WIDEST)}` : '';
}

/** Hides up to `columns` columns of leading whitespace from index `start` of a line's text. */
export function hideIndent(d: BlockDraw, lineFrom: number, text: string, start: number, columns: number): void {
  d.hide(lineFrom + start, lineFrom + indexAfterColumns(text, start, columns));
}

/**
 * Removes `block`'s lines, and the one blank line after it, so the page reads as if the block
 * were not there.
 */
export function hideWithGap(d: BlockDraw, block: BlockEntry): void {
  const next = block.lastLine + 1;
  const end = next <= d.lines.count && d.lines.text(next).trim() === '' ? next : block.lastLine;
  d.hideLines(d.lines.start(block.firstLine), d.lines.end(end));
}

/** Index into `text` just after up to `quotes` quote markers at its start (`>`, and one space after each). */
function afterQuoteMarkers(text: string, quotes: number): number {
  let i = 0;
  for (let q = 0; q < quotes; q++) {
    let j = i;
    while (j < text.length && isSpaceOrTab(text.charCodeAt(j))) j++;
    if (text.charCodeAt(j) !== CODE_GREATER_THAN) break;
    i = j + 1;
    if (isSpaceOrTab(text.charCodeAt(i))) i++;
  }
  return i;
}

/** Index into `text` reached by moving `columns` columns of spaces and tabs on from index `from`. */
function indexAfterColumns(text: string, from: number, columns: number): number {
  let i = from;
  let column = 0;
  while (i < text.length && column < columns && isSpaceOrTab(text.charCodeAt(i))) {
    column = nextColumn(column, text.charCodeAt(i));
    i++;
  }
  return i;
}

/** The lines of the list items in lists `container` holds directly, which hide their own lines' indentation. */
export function listLinesIn(container: BlockEntry, items: readonly BlockEntry[]): Set<number> {
  const lines = new Set<number>();
  for (const item of items) {
    const holder = item.node.parent?.parent;
    if (!holder || holder.from !== container.from || holder.name !== container.name) continue;
    for (let n = item.firstLine; n <= item.lastLine; n++) lines.add(n);
  }
  return lines;
}

function quotesOutside(block: BlockEntry): number {
  let quotes = 0;
  for (let p = block.node.parent; p; p = p.parent) if (p.name === 'Blockquote') quotes++;
  return quotes;
}

/** The column of `pos` on its line, counted from just after the quote markers outside `block`. */
export function columnInQuotes(d: BlockDraw, block: BlockEntry, pos: number): number {
  const n = d.lines.numberAt(pos);
  const text = d.lines.text(n);
  return columnsBetween(text, afterQuoteMarkers(text, quotesOutside(block)), pos - d.lines.start(n));
}

/**
 * Where a container's own indentation starts on its lines, as a column after the quote
 * markers outside it: at the top level (`top`), the line's start; inside another container,
 * the column `markerAt` stands at on the container's first line, since that container hides
 * the columns before it.
 */
export function containerBase(d: BlockDraw, block: BlockEntry, markerAt: number, top = block.top): number {
  return top ? 0 : columnInQuotes(d, block, markerAt);
}

/**
 * Hides, on each line of a container after its first (an admonition's body, a definition's
 * further lines), the `columns` columns of indentation the container puts before its text,
 * from the column `base`. Lines in `skip` are left alone.
 */
export function hideContainerIndent(
  d: BlockDraw,
  block: BlockEntry,
  base: number,
  columns: number,
  skip: ReadonlySet<number>,
): void {
  const quotes = quotesOutside(block);
  for (let n = block.firstLine + 1; n <= block.lastLine; n++) {
    if (skip.has(n)) continue;
    const text = d.lines.text(n);
    hideIndent(d, d.lines.start(n), text, indexAfterColumns(text, afterQuoteMarkers(text, quotes), base), columns);
  }
}

/** Calls `fn` with the part of [from, to] on each line it runs over; nothing when it is empty. */
function byLine(d: InlineDraw, from: number, to: number, fn: (from: number, to: number) => void): void {
  if (to <= from) return;
  const lines = d.lines;
  for (let n = lines.numberAt(from), last = lines.numberAt(to); n <= last; n++) {
    fn(Math.max(from, lines.start(n)), Math.min(to, lines.end(n)));
  }
}

/** Hides [from, to], line by line: a stretch inside a paragraph (a link's address) can run over lines. */
export function hideRange(d: InlineDraw, from: number, to: number): void {
  byLine(d, from, to, (start, end) => d.hide(start, end));
}

/** Marks [from, to] with `className`, line by line. */
export function markRange(
  d: InlineDraw,
  from: number,
  to: number,
  className: string,
  attrs?: Record<string, string>,
): void {
  byLine(d, from, to, (start, end) => d.mark(start, end, className, attrs));
}

/** A comment over [from, to], line by line: hidden in Rich view, marked `className` in Rich editor. */
export function drawComment(d: InlineDraw, from: number, to: number, className: string): void {
  if (d.mode === 'view') hideRange(d, from, to);
  else markRange(d, from, to, className);
}
