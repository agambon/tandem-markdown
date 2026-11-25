// Where a new block of markdown goes, as a block of its own inside whatever quote or list item
// holds the place it goes, and the blank lines around it. Paste, Insert Table, the block
// commands and the insert menu all place blocks here: in place of a range (`placeBlock`), at the
// cursor's line (`blockAtLine`), or as a line of its own below it (`lineOfItsOwn`).

import { EditorSelection, type ChangeSpec, type EditorState, type Line, type Transaction } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { markdownParser } from '../markdown';
import { treeForLine } from '../markdown/tree';
import { COMMAND_EVENT } from './base';
import { containerPrefix, lineInfo, type LineMarks } from './lineInfo';

/**
 * Where the line's own text starts, past its quote marks, list marker and a list item's
 * continuation indent. A task marker or heading marks are the line's own text.
 */
function contentStartOf(info: LineMarks): number {
  // On a list item's later line, its indent belongs to the item.
  const item = info.marker ? info.marker.contentFrom : info.owner ? info.textFrom : info.quoteEnd;
  return Math.max(info.quoteEnd, item);
}

/** A line as a place for a block (`containerAt`). */
export interface BlockPlace {
  info: LineMarks;
  /** Where the line's own text starts (`contentStartOf`). */
  contentStart: number;
  /** What a new line beside it starts with to stay in the same quotes and list items (`containerPrefix`). */
  prefix: string;
  /** A blank line in the same place: the prefix with no trailing spaces. */
  blank: string;
  /** The line has no text of its own: nothing but the marks of the quote or list item that holds it. */
  empty: boolean;
  /**
   * On an empty list item's own line, where a block's first line goes: one space past the
   * marker (which takes the place of any spaces there), the column the item's later lines take.
   */
  itemStart: number | null;
}

export function containerAt(state: EditorState, tree: Tree, line: Line): BlockPlace {
  const info = lineInfo(state, tree, line);
  const contentStart = contentStartOf(info);
  const prefix = containerPrefix(state, tree, info);
  const empty = state.doc.sliceString(contentStart, line.to).trim() === '';
  return {
    info,
    contentStart,
    prefix,
    blank: prefix.trimEnd(),
    empty,
    itemStart: empty && info.marker ? info.marker.markTo : null,
  };
}

/**
 * The line has no text of its own: nothing but the marks of the quote or list item that holds
 * it. An empty list item's line is one: a blank line straight after it would end the item.
 */
export function lineIsBlank(state: EditorState, lineNumber: number): boolean {
  const line = state.doc.line(lineNumber);
  const contentStart = contentStartOf(lineInfo(state, treeForLine(state, line.from), line));
  return state.doc.sliceString(contentStart, line.to).trim() === '';
}

// ---------------------------------------------------------------------------
// The blank lines around a block

/** `text`, read on its own by the panel's parser, is one block of the kind `name`. */
function oneBlock(text: string, name: string): SyntaxNode | null {
  const only = markdownParser.parse(text).topNode.firstChild;
  return only && only.name === name && !only.nextSibling ? only : null;
}

/**
 * A new block takes a blank line on each side where the line beside it has text, so neither
 * runs into the other. Not in a list item, where a blank line makes a tight list loose, when the
 * block needs none: one fenced code block, closed (a fence may interrupt a paragraph, and its
 * closing fence ends it), or a rule that cannot underline the text above it as a heading (any
 * but `---`). `containers` are the quotes and list items holding it, outermost first.
 */
function takesBlankLines(containers: readonly SyntaxNode[], block: string): boolean {
  if (containers[containers.length - 1]?.name !== 'ListItem') return true;
  const fence = oneBlock(block, 'FencedCode');
  if (fence) return fence.getChildren('CodeMark').length < 2;
  return !oneBlock(block, 'HorizontalRule') || block.trimStart().startsWith('-');
}

/** Line `n` exists and has text of its own, so a new block beside it needs a blank line between. */
function hasText(state: EditorState, n: number): boolean {
  return n >= 1 && n <= state.doc.lines && !lineIsBlank(state, n);
}

/**
 * A block's first line `line`, as it is written after `before`: a list marker of `bullet` and
 * what follows it on its line. A rule of the bullet's own character would read with it as one
 * rule and the item would be lost, so it is written in the other one (`***` after `-`, `---`
 * after `*`), as Insert Rule writes `***` in a list item.
 */
function clearOfBullet(bullet: string, before: string, line: string): string {
  if (!oneBlock(line, 'HorizontalRule') || !oneBlock(before + line, 'HorizontalRule')) return line;
  return bullet === '-' ? '***' : '---';
}

// ---------------------------------------------------------------------------
// Placing a block

/** Where `placeBlock` puts a block. */
interface PlacedBlock {
  /** The change: `insert` in place of `[from, to]`. */
  from: number;
  to: number;
  insert: string;
  /** Where the block's own text starts and ends once inserted (its first line's container marks come before `start`). */
  start: number;
  end: number;
  /** A line follows the block once inserted. */
  lineAfter: boolean;
  /** Where each line of the block starts once inserted, past the marks that hold it. */
  lineStarts: number[];
}

/**
 * `block` (one or more lines of markdown) in place of `range`, as a block of its own: blank
 * lines around it where text would otherwise run into it (`takesBlankLines`), every line carrying
 * the quote or list container the range is in. With no text of the line's own before it, the
 * block starts a list item's text after its marker (a rule that would read with the marker as
 * one is written in the other character, `clearOfBullet`), and elsewhere takes the line in place
 * of its marks. A blank line of the block carries the marks trimmed, but `keepPrefix`, the line
 * the caller puts the cursor on, carries them whole, so what is typed there stays inside them.
 */
export function placeBlock(
  state: EditorState,
  block: string,
  range: { from: number; to: number },
  keepPrefix = -1,
): PlacedBlock {
  const doc = state.doc;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(range.to);
  const place = containerAt(state, treeForLine(state, first.from), first);
  const { contentStart, prefix, blank, info } = place;
  let from = Math.max(range.from, contentStart);
  let to = Math.max(range.to, from);
  const textBefore = doc.sliceString(contentStart, from);
  // With no text of the line's own before it, the block starts the list item's text.
  const marker = textBefore.trim() === '' ? info.marker : null;
  const lines = block.replace(/\r\n?/g, '\n').split('\n');
  if (marker) {
    const before =
      place.itemStart === null
        ? doc.sliceString(marker.from, from)
        : `${doc.sliceString(marker.from, place.itemStart)} `;
    lines[0] = clearOfBullet(marker.bullet, before, lines[0]!);
  }
  const text = lines.join('\n');
  const gap = takesBlankLines(info.containers, text) ? `${blank}\n` : '';

  let lead = '';
  if (textBefore.trim() !== '') {
    // End the paragraph here; the block follows, after a blank line where it takes one.
    from -= textBefore.length - textBefore.trimEnd().length;
    lead = `\n${gap}${prefix}`;
  } else if (marker) {
    // The block starts the list item's text: on an empty item, one space past its marker.
    if (place.itemStart !== null) {
      from = place.itemStart;
      lead = ' ';
    }
  } else {
    from = first.from;
    lead = (gap && hasText(state, first.number - 1) ? gap : '') + prefix;
  }

  let tail = '';
  const textAfter = doc.sliceString(to, last.to);
  if (textAfter.trim() !== '') {
    to += textAfter.length - textAfter.trimStart().length;
    tail = `\n${gap}${prefix}`;
  } else {
    to = last.to;
    if (gap && hasText(state, last.number + 1)) tail = `\n${blank}`;
  }

  const start = from + lead.length;
  const lineStarts: number[] = [];
  let at = start;
  const written = lines.map((line, i) => {
    const marks = i === 0 ? '' : line.trim() === '' && i !== keepPrefix ? blank : prefix;
    lineStarts.push(at + marks.length);
    at += marks.length + line.length + 1;
    return marks + line;
  });
  const body = written.join('\n');
  return {
    from,
    to,
    insert: lead + body + tail,
    start,
    end: start + body.length,
    lineAfter: tail !== '' || to < doc.length,
    lineStarts,
  };
}

/**
 * `lines` as a block of their own at the main cursor's line (`placeBlock` at its end): in place
 * of that line when it has no text of its own (on an empty list item's line, after its marker),
 * otherwise below it. The cursor goes to `cursor`, a line of `lines` and a column in it.
 */
export function blockAtLine(
  state: EditorState,
  lines: readonly string[],
  cursor: { line: number; column: number },
): Transaction {
  const line = state.doc.lineAt(state.selection.main.head);
  const placed = placeBlock(state, lines.join('\n'), { from: line.to, to: line.to }, cursor.line);
  return state.update({
    changes: { from: placed.from, to: placed.to, insert: placed.insert },
    selection: EditorSelection.cursor(placed.lineStarts[cursor.line]! + cursor.column),
    userEvent: COMMAND_EVENT,
    scrollIntoView: true,
  });
}

/**
 * `text` on a line of its own at the main cursor's line, with a blank line before it where
 * `text` takes one (`takesBlankLines`: so a rule cannot become a Setext underline, nor a
 * contents marker run into a paragraph), and the cursor on the line after it, in the same
 * quotes and list items. A blank line with a blank line before it becomes that line.
 */
export function lineOfItsOwn(state: EditorState, text: string): Transaction {
  const doc = state.doc;
  const line = doc.lineAt(state.selection.main.head);
  const place = containerAt(state, treeForLine(state, line.from), line);
  const { prefix, blank } = place;
  const written = `${prefix}${text}`;
  let from = line.to;
  let insert: string;
  if (place.empty && !place.info.marker && !hasText(state, line.number - 1)) {
    // This blank line becomes the new line.
    from = line.from;
    insert = written;
  } else {
    // Below this line, after a blank line: this one, when it has no text of its own. Straight
    // below an empty list item's line, which a blank line would end and a rule cannot underline.
    const gap = !place.empty && takesBlankLines(place.info.containers, text);
    insert = gap ? `\n${blank}\n${written}` : `\n${written}`;
  }
  const end = from + insert.length;
  // The cursor goes to the line after it: the blank line there, or a new one. That line starts
  // with the prefix, so what is typed there stays in the quotes and list items.
  const changes: ChangeSpec[] = [];
  const next = line.number + 1;
  if (next <= doc.lines && lineIsBlank(state, next)) {
    const after = doc.line(next);
    if (after.text !== prefix) changes.push({ from: after.from, to: after.to, insert: prefix });
  } else {
    insert += `\n${prefix}`;
  }
  changes.unshift({ from, to: line.to, insert });
  return state.update({
    changes,
    selection: EditorSelection.cursor(end + 1 + prefix.length),
    userEvent: COMMAND_EVENT,
    scrollIntoView: true,
  });
}

/**
 * The blank lines that go around `block` when it takes the place of lines `first` to `last` in
 * `containers` (outermost first), as a code block wraps them, where the lines beside it have
 * text: `blank` and a line break before it, a line break and `blank` after it.
 */
export function blankLinesAround(
  state: EditorState,
  containers: readonly SyntaxNode[],
  block: string,
  first: number,
  last: number,
  blank: string,
): { before: string; after: string } {
  const spaced = takesBlankLines(containers, block);
  return {
    before: spaced && hasText(state, first - 1) ? `${blank}\n` : '',
    after: spaced && hasText(state, last + 1) ? `\n${blank}` : '',
  };
}
