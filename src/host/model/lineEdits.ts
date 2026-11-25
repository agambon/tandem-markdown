// Where a line of a document stands after an edit: moved by the lines the edit inserts and
// deletes above it. A line inside a range the edit replaced has no place of its own after it, so
// the caller says where it goes: to the start of the range, or to the end of what replaced it.

/** One change of an edit, by lines: it replaced lines `from` to `to` with text holding `lines` line breaks. */
export interface LineEdit {
  from: number;
  to: number;
  lines: number;
}

/** What a text document event gives of one change: the lines it replaced, and the text put there. */
interface ContentChange {
  range: { start: { line: number }; end: { line: number } };
  text: string;
}

const BREAKS = /\r\n|\r|\n/g;

/** One change of a text document event as a LineEdit, each "\r\n", "\r" and "\n" one line break. */
export function lineEditOf(change: ContentChange): LineEdit {
  return { from: change.range.start.line, to: change.range.end.line, lines: change.text.match(BREAKS)?.length ?? 0 };
}

/** A line inside a replaced range (after its first line, up to its last): it has no place of its own after the edit. */
export function insideAnEdit(line: number, edits: readonly LineEdit[]): boolean {
  return edits.some((e) => e.from < line && e.to >= line);
}

/**
 * `line` after `edits` (each against the text before the edit): moved by the lines added or deleted
 * above it; inside a replaced range, at its `start` or at the `end` of what replaced it.
 */
export function lineAfter(line: number, edits: readonly LineEdit[], inside: 'start' | 'end'): number {
  let at = line;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    if (at > e.to) at += e.lines - (e.to - e.from);
    else if (at > e.from) at = inside === 'start' ? e.from : e.from + e.lines;
  }
  return Math.max(0, at);
}
