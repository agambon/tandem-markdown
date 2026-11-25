// Git's conflict markers, as a merge leaves them in a file:
//
//   <<<<<<< HEAD           the current change, after the name git gives it
//   ||||||| 1a2b3c4        the lines before either change, when git is set to write them
//   =======
//   >>>>>>> north-wall     the incoming change, before its name
//
// A block from a line that starts with a run of seven or more `<` to a line that starts with a
// run of as many `>`, holding a line of as many `=`, is one conflict, read raw: nothing in it is
// markdown, so the line above `=======` is no heading. It opens only at the first column of a
// line outside any quote, list or box, and ends a paragraph. An opener with no closer before the
// next opener is text. Node: `ConflictBlock`, a leaf block with a `ConflictMark` per marker line.

import type { Input } from '@lezer/common';
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';
import { parseInput, reached } from './blockContext';
import { CODE_LESS_THAN } from './chars';

/** Git's shortest marker; `conflict-marker-size` can make them longer. */
const MIN_MARKER = 7;

/** What a line that may open a conflict starts with. */
export const CONFLICT_OPENER = '<'.repeat(MIN_MARKER);

/** The start of a line that may divide or close a conflict. */
const DIVIDE_OR_CLOSE = new RegExp(`(?:^|\\n)(?:>{${MIN_MARKER}}|={${MIN_MARKER}}|\\|{${MIN_MARKER}})`);

/** Whether `text` holds a line that may divide or close a conflict (the parse wrapper asks, reparse.ts). */
export function mayDivideOrClose(text: string): boolean {
  return DIVIDE_OR_CLOSE.test(text);
}

/** How much of the file is read at a time when looking down for a conflict's end. */
const READ_SIZE = 4096;

/** A marker line's place, as offsets from the start of the conflict's first line. */
interface Span {
  from: number;
  to: number;
}

/** Where a conflict's marker lines are. */
interface Shape {
  opener: Span;
  /** The line before the lines as they were before either change; null when git wrote none. */
  base: Span | null;
  separator: Span;
  closer: Span;
}

/** The length of the run of `char` that starts `line`. */
function runOf(line: string, char: string): number {
  let n = 0;
  while (line[n] === char) n++;
  return n;
}

/** Whether `line` opens a conflict: seven or more `<`, then nothing or a space and a name. */
function openerSize(line: string): number {
  const size = runOf(line, '<');
  return size >= MIN_MARKER && (size === line.length || line[size] === ' ' || line[size] === '\t') ? size : 0;
}

/** Whether `line` is a marker of `size` made of `char`: with a name after a space when `named`, else with nothing after. */
function isMarker(line: string, char: string, size: number, named: boolean): boolean {
  if (runOf(line, char) !== size) return false;
  const rest = line.slice(size);
  return named ? rest === '' || rest[0] === ' ' || rest[0] === '\t' : rest.trim() === '';
}

/** The shape of the conflict whose first line is the first of `lines`; null when they hold none. */
function shapeOf(lines: Iterable<string>): Shape | null {
  let size = 0;
  let at = 0;
  let opener: Span | null = null;
  let base: Span | null = null;
  let separator: Span | null = null;
  for (const line of lines) {
    const span = { from: at, to: at + line.length };
    at = span.to + 1;
    if (!opener) {
      size = openerSize(line);
      if (!size) return null;
      opener = span;
    } else if (openerSize(line)) {
      return null;
    } else if (!separator && !base && isMarker(line, '|', size, true)) {
      base = span;
    } else if (!separator && isMarker(line, '=', size, false)) {
      separator = span;
    } else if (isMarker(line, '>', size, true)) {
      return separator ? { opener, base, separator, closer: span } : null;
    }
  }
  return null;
}

/** The lines of `input` from `from`, the start of a line, read a piece at a time. */
function* linesFrom(input: Input, from: number): Generator<string> {
  let pos = from;
  let carry = '';
  while (pos < input.length) {
    const end = Math.min(input.length, pos + READ_SIZE);
    const text = carry + input.read(pos, end);
    pos = end;
    let start = 0;
    for (let eol = text.indexOf('\n'); eol >= 0; eol = text.indexOf('\n', start)) {
      yield text.slice(start, eol);
      start = eol + 1;
    }
    carry = text.slice(start);
  }
  yield carry;
}

/** The conflict that opens at the first column of `line`, at the top of the file's blocks; null when it opens none. */
function conflictAt(cx: BlockContext, line: Line, depth: number): Shape | null {
  if (line.pos !== 0 || line.next !== CODE_LESS_THAN || depth !== 1) return null;
  const input = parseInput(cx);
  return input ? shapeOf(linesFrom(input, cx.lineStart)) : null;
}

function parseConflict(cx: BlockContext, line: Line): boolean {
  const shape = conflictAt(cx, line, cx.depth);
  if (!shape) return false;
  const from = cx.lineStart;
  const end = from + shape.closer.to;
  const marks = [shape.opener, shape.base, shape.separator, shape.closer]
    .filter((span) => span !== null)
    .map((span) => cx.elt('ConflictMark', from + span.from, from + span.to));
  while (cx.lineStart + line.text.length < end) if (!cx.nextLine()) break;
  cx.nextLine();
  cx.addElement(cx.elt('ConflictBlock', from, end, marks));
  return true;
}

export const ConflictMarkers: MarkdownConfig = {
  defineNodes: [{ name: 'ConflictBlock', block: true }, 'ConflictMark'],
  parseBlock: [
    {
      name: 'ConflictBlock',
      parse: parseConflict,
      // A conflict ends the paragraph above it; the quotes and lists around that close at a line
      // that starts at the first column.
      endLeaf: (cx, line) => conflictAt(cx, line, reached(line)) !== null,
      before: 'LinkReference',
    },
  ],
};

/** One side of a conflict: the name git gave it, and its lines. */
export interface ConflictSide {
  /** The name on its marker line, as git wrote it; empty when there is none. */
  name: string;
  lines: string[];
}

export interface Conflict {
  current: ConflictSide;
  /** The lines as they were before either change, when git wrote them. */
  base: ConflictSide | null;
  incoming: ConflictSide;
}

/** The sides of the conflict that `text` (a `ConflictBlock`'s source) holds; null when it holds none. */
export function readConflict(text: string): Conflict | null {
  const shape = shapeOf(text.split('\n'));
  if (!shape) return null;
  const name = (marker: Span) =>
    text
      .slice(marker.from, marker.to)
      .replace(/^(.)\1*/, '')
      .trim();
  const between = (after: Span, before: Span) =>
    before.from > after.to + 1 ? text.slice(after.to + 1, before.from - 1).split('\n') : [];
  const firstAfterCurrent = shape.base ?? shape.separator;
  return {
    current: { name: name(shape.opener), lines: between(shape.opener, firstAfterCurrent) },
    base: shape.base ? { name: name(shape.base), lines: between(shape.base, shape.separator) } : null,
    incoming: { name: name(shape.closer), lines: between(shape.separator, shape.closer) },
  };
}
