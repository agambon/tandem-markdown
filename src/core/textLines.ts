// Lines and offsets in LF text: where a line starts and ends, the whole lines around a stretch,
// offsets carried through text changes, and the search of a sorted list of offsets. Offsets are
// in UTF-16 code units of LF text, as everywhere in the core.

import type { TextChange } from './diff';

/** The end of the line holding offset `at` of `text` (the offset of its line break, or the text's length). */
export function lineEndAt(text: string, at: number): number {
  const n = text.indexOf('\n', at);
  return n < 0 ? text.length : n;
}

/** A stretch of a text, from its first offset up to its second. */
export type Run = [number, number];

/**
 * Whether `piece`, inserted or deleted at `at` in `text`, is whole lines: it ends with a line
 * break and begins a line, or begins with one and ends where a line does.
 */
export function wholeLines(text: string, at: number, piece: string): boolean {
  if (piece.endsWith('\n') && (at === 0 || text[at - 1] === '\n')) return true;
  return piece.startsWith('\n') && (at === text.length || text[at] === '\n');
}

/**
 * An offset of a text carried through `changes` to the text they make. One that a change
 * covers or touches goes to the start of what replaced it (`start`) or its end (`end`), so a
 * place carried this way holds every change next to it.
 */
export function carryOffset(x: number, changes: readonly TextChange[], side: 'start' | 'end'): number {
  let shift = 0;
  for (const c of changes) {
    if (c.to < x) {
      shift += c.insert.length - (c.to - c.from);
      continue;
    }
    if (c.from > x) break;
    const from = c.from + shift;
    return side === 'start' ? from : from + c.insert.length;
  }
  return x + shift;
}

/**
 * Every place the deletion of text[from, to) could have been told: the same text deleted one
 * character earlier or later, as far as it slides, as one stretch.
 */
export function slidRange(text: string, from: number, to: number): Run {
  let lo = from;
  for (let a = from, b = to; a > 0 && text[a - 1] === text[b - 1]; a--, b--) lo = a - 1;
  let hi = to;
  for (let a = from, b = to; b < text.length && text[a] === text[b]; a++, b++) hi = b + 1;
  return [lo, hi];
}

/** The last line of `text` with words on it, or null where it has none. */
export function lastLineWithWords(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() !== '') return lines[i]!;
  return null;
}

/** The start of the line holding offset `at` of `text`. */
export function lineStartAt(text: string, at: number): number {
  return at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1;
}

/**
 * The lines of `text` that hold [from, to) (the line holding `from` for an empty range): from the
 * start of the first to the end of the last, before its line break.
 */
export function lineSpanOf(text: string, from: number, to: number): [number, number] {
  const start = lineStartAt(text, from);
  const end = to > from && text[to - 1] === '\n' ? to - 1 : lineEndAt(text, to);
  return [start, Math.max(start, end)];
}

/** The whole lines of `text` that hold [from, to), before the last one's line break; '' for an empty range. */
export function linesHolding(text: string, from: number, to: number): string {
  if (to <= from) return '';
  const [a, b] = lineSpanOf(text, from, to);
  return text.slice(a, b);
}

/** `text` without one line break at its end. */
export function withoutBreak(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** The first entry of the sorted `list` at or after `min`, or -1. */
export function firstFrom(list: readonly number[], min: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < min) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo]! : -1;
}
