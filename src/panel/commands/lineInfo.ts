// Reading one line's block marks (quote marks, list marker, task marker, heading marks) and the
// blocks that hold it, from the syntax tree, never by matching text. Every command that acts on
// lines reads them through `lineInfo`; `containerPrefix` writes what a new line beside one
// starts with to stay in the same quotes and list items.

import type { EditorState, Line } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { isSpaceOrTab } from '../../core/markdownText';
import { columnsBetween, skipSpaces } from '../markdown/chars';
import { isAtxHeading, isSetextHeading, NO_INLINE, RAW_BLOCKS } from '../markdown/nodes';
import { treeForLine } from '../markdown/tree';

export type ListKind = 'bullet' | 'ordered' | 'task';

export interface ListMarker {
  /** The `ListItem` this marker starts. */
  item: SyntaxNode;
  /** Its `BulletList` or `OrderedList`. */
  list: SyntaxNode;
  kind: ListKind;
  /** The marker's first character (after any indentation). */
  from: number;
  /** The end of `-` or `1.`. */
  markTo: number;
  /** Where the item's content starts: the column its children line up with. */
  contentFrom: number;
  /** Where the item's text starts: after a task marker and its space too. */
  to: number;
  /** `-`, `*` or `+`; empty for a numbered item. */
  bullet: string;
  /** A numbered item's number; 0 otherwise. */
  number: number;
  /** `.` or `)` for a numbered item; empty otherwise. */
  delimiter: string;
  /** The `[ ]` or `[x]`, when the item is a task. */
  task: { from: number; to: number; checked: boolean } | null;
}

interface HeadingInfo {
  node: SyntaxNode;
  level: number;
  setext: boolean;
  /** ATX: the opening `#` run. Setext: the underline's mark. */
  markFrom: number;
  markTo: number;
  /** ATX: where the heading's text starts (after the `#` run and its spaces). Setext: the text's start. */
  contentFrom: number;
  /** ATX: where the text ends, before a closing `#` run. */
  contentTo: number;
  /** ATX: the closing `#` run, when there is one. */
  close: { from: number; to: number } | null;
  /** Setext: the underline line. */
  underline: Line | null;
}

export interface LineMarks {
  line: Line;
  /** Nothing but quote marks and spaces. */
  blank: boolean;
  quoteMarks: { from: number; to: number }[];
  /** After the last quote mark and one space; the line start when there is none. */
  quoteEnd: number;
  /** The first non-space after the quote marks: where a new block mark goes. */
  textFrom: number;
  /** The line lies in a quote (by the tree; a lazy line has no mark of its own). */
  inQuote: boolean;
  /** The list marker that starts on this line. */
  marker: ListMarker | null;
  /** The innermost list item holding the line. */
  owner: SyntaxNode | null;
  /** The quotes and list items holding the line, outermost first (`containerPrefix` writes them). */
  containers: SyntaxNode[];
  /** The heading this line belongs to (a Setext heading's text or underline line, or an ATX line). */
  heading: HeadingInfo | null;
  /** The line is a Setext heading's underline. */
  setextUnderline: boolean;
  /** Where the line's text starts after every block mark on it. */
  contentFrom: number;
  /** Where the line's text ends (before trailing spaces and an ATX closing run). */
  contentTo: number;
  /** A code block, front matter, HTML block or link definition holding the line. */
  code: SyntaxNode | null;
  /** The table holding the line. */
  table: SyntaxNode | null;
  /** The line is a horizontal rule. */
  rule: boolean;
}

function trimEndAt(text: string, end: number, floor: number): number {
  while (end > floor && isSpaceOrTab(text.charCodeAt(end - 1))) end--;
  return end;
}

/** The marker of a `ListItem` node (read from the line it starts on). */
export function markerOf(state: EditorState, tree: Tree, item: SyntaxNode): ListMarker | null {
  return lineInfo(state, tree, state.doc.lineAt(item.from)).marker;
}

function readMarker(
  state: EditorState,
  line: Line,
  listMark: SyntaxNode,
  taskMark: SyntaxNode | null,
): ListMarker | null {
  const item = listMark.parent;
  const list = item?.parent;
  if (!item || !list || item.name !== 'ListItem') return null;
  const text = line.text;
  const ordered = list.name === 'OrderedList';
  const markText = state.doc.sliceString(listMark.from, listMark.to);
  const at = listMark.to - line.from;
  const after = skipSpaces(text, at);
  const spaces = after - at;
  const restBlank = after >= text.length;
  const contentFrom = line.from + (restBlank ? after : spaces > 4 ? at + 1 : after);
  let task: ListMarker['task'] = null;
  let to = contentFrom;
  if (taskMark && taskMark.parent?.parent && taskMark.parent.parent.from === item.from) {
    const flag = state.doc.sliceString(taskMark.from + 1, taskMark.from + 2);
    task = { from: taskMark.from, to: taskMark.to, checked: flag === 'x' || flag === 'X' };
    to = line.from + skipSpaces(text, taskMark.to - line.from);
  }
  const numbered = /^(\d+)([.)])$/.exec(markText);
  return {
    item,
    list,
    kind: task ? 'task' : ordered ? 'ordered' : 'bullet',
    from: listMark.from,
    markTo: listMark.to,
    contentFrom,
    to,
    bullet: ordered ? '' : markText,
    number: numbered ? Number(numbered[1]) : 0,
    delimiter: numbered ? numbered[2]! : '',
    task,
  };
}

function setextInfo(state: EditorState, node: SyntaxNode): HeadingInfo {
  const mark = node.lastChild?.name === 'HeaderMark' ? node.lastChild : null;
  const underline = mark ? state.doc.lineAt(mark.from) : null;
  const first = state.doc.lineAt(node.from);
  return {
    node,
    level: Number(node.name.slice(-1)),
    setext: true,
    markFrom: mark?.from ?? node.to,
    markTo: mark?.to ?? node.to,
    contentFrom: node.from,
    contentTo: underline && underline.number > first.number ? state.doc.line(underline.number - 1).to : node.to,
    close: null,
    underline,
  };
}

/** Reads one line's block marks and what holds it, from the syntax tree. */
export function lineInfo(state: EditorState, tree: Tree, line: Line): LineMarks {
  const text = line.text;
  const quoteMarks: { from: number; to: number }[] = [];
  let listMark: SyntaxNode | null = null;
  let taskMark: SyntaxNode | null = null;
  const headerMarks: SyntaxNode[] = [];
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (ref.to < line.from || ref.from > line.to) return false;
      const own = ref.from >= line.from && ref.from <= line.to;
      switch (ref.name) {
        case 'QuoteMark':
          if (own) quoteMarks.push({ from: ref.from, to: ref.to });
          return false;
        case 'ListMark':
          if (own) listMark = ref.node;
          return false;
        case 'TaskMarker':
          if (own) taskMark = ref.node;
          return false;
        case 'HeaderMark':
          if (own) headerMarks.push(ref.node);
          return false;
        default:
          return true;
      }
    },
  });
  quoteMarks.sort((a, b) => a.from - b.from);
  const lastQuote = quoteMarks[quoteMarks.length - 1];
  const quoteEnd = lastQuote ? lastQuote.to + (text[lastQuote.to - line.from] === ' ' ? 1 : 0) : line.from;
  const textFrom = line.from + skipSpaces(text, quoteEnd - line.from);
  const blank = textFrom >= line.to;

  // What holds the line: resolve at its text (or, when blank, after its quote marks).
  let code: SyntaxNode | null = null;
  let table: SyntaxNode | null = null;
  let owner: SyntaxNode | null = null;
  let inQuote = quoteMarks.length > 0;
  let rule = false;
  let heading: HeadingInfo | null = null;
  const anchor = blank ? quoteEnd : textFrom;
  for (let n: SyntaxNode | null = tree.resolveInner(anchor, 1); n; n = n.parent) {
    if (NO_INLINE.has(n.name) && !code && n.from <= anchor && anchor <= n.to) code = n;
    else if (n.name === 'Table') table = n;
    else if (n.name === 'Blockquote') inQuote = true;
    else if (n.name === 'ListItem' && !owner && n.from <= anchor && anchor <= n.to) owner = n;
    else if (n.name === 'HorizontalRule') rule = true;
    else if (!heading && isSetextHeading(n.name)) heading = setextInfo(state, n);
  }
  if (code && code.from > line.to) code = null;

  // Read at the line's text; a blank line at its last quote mark, which only its innermost quote
  // holds, or at its start.
  const containers: SyntaxNode[] = [];
  const held = blank ? (lastQuote ? lastQuote.from : line.from) : textFrom;
  for (let n: SyntaxNode | null = tree.resolveInner(held, 1); n; n = n.parent) {
    if (n.name === 'Blockquote' || n.name === 'ListItem') containers.unshift(n);
  }

  let setextUnderline = false;
  let contentTo = trimEndAt(text, text.length, textFrom - line.from) + line.from;
  for (const mark of headerMarks) {
    const parent = mark.parent;
    if (!parent) continue;
    if (isSetextHeading(parent.name)) {
      setextUnderline = true;
      heading = setextInfo(state, parent);
    } else if (isAtxHeading(parent.name) && mark.from === parent.from) {
      const close =
        parent.lastChild && parent.lastChild.name === 'HeaderMark' && parent.lastChild.from > mark.from
          ? parent.lastChild
          : null;
      const contentFrom = line.from + skipSpaces(text, mark.to - line.from);
      const end = close ? trimEndAt(text, close.from - line.from, contentFrom - line.from) + line.from : contentTo;
      heading = {
        node: parent,
        level: Number(parent.name.slice(-1)),
        setext: false,
        markFrom: mark.from,
        markTo: mark.to,
        contentFrom: Math.min(contentFrom, close ? close.from : line.to),
        contentTo: Math.max(end, Math.min(contentFrom, line.to)),
        close: close ? { from: close.from, to: close.to } : null,
        underline: null,
      };
      contentTo = heading.contentTo;
    }
  }

  const marker = listMark ? readMarker(state, line, listMark, taskMark) : null;
  if (marker) owner = marker.item;
  let contentFrom = textFrom;
  if (marker) contentFrom = Math.max(contentFrom, marker.to);
  if (heading && !heading.setext) contentFrom = Math.max(contentFrom, heading.contentFrom);
  if (contentTo < contentFrom) contentTo = contentFrom;

  return {
    line,
    blank,
    quoteMarks,
    quoteEnd,
    textFrom,
    inQuote,
    marker,
    owner,
    containers,
    heading,
    setextUnderline,
    contentFrom,
    contentTo,
    code,
    table,
    rule,
  };
}

function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return columnsBetween(line.text, 0, pos - line.from);
}

/**
 * The column a list item's content lines up with; one past its marker when nothing follows the
 * marker on its line.
 */
function itemContentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark');
  if (!mark) return columnAt(state, item.from);
  const line = state.doc.lineAt(mark.from);
  const marker = readMarker(state, line, mark, null);
  if (!marker || marker.contentFrom >= line.to) return columnAt(state, mark.to) + 1;
  return columnAt(state, marker.contentFrom);
}

/**
 * The column where the content inside `containers` (outermost first) starts on `line`: past
 * each quote's mark and the one space or tab after it that the mark takes, and past each list
 * item's indent.
 */
function innerColumn(state: EditorState, tree: Tree, line: Line, containers: readonly SyntaxNode[]): number {
  const marks = lineInfo(state, tree, line).quoteMarks;
  let column = 0;
  let quote = 0;
  containers.forEach((node, i) => {
    if (node.name === 'ListItem') {
      column += itemIndent(state, tree, containers.slice(0, i + 1));
      return;
    }
    const mark = marks[quote++];
    if (!mark) return;
    column =
      columnAt(state, mark.to) + (isSpaceOrTab(state.doc.sliceString(mark.to, mark.to + 1).charCodeAt(0)) ? 1 : 0);
  });
  return column;
}

/**
 * How far the last of `containers`, a list item, indents its content past the content of the
 * containers holding it, on its marker's line.
 */
function itemIndent(state: EditorState, tree: Tree, containers: readonly SyntaxNode[]): number {
  const item = containers[containers.length - 1]!;
  const markerLine = state.doc.lineAt(item.getChild('ListMark')?.from ?? item.from);
  return Math.max(0, itemContentColumn(state, item) - innerColumn(state, tree, markerLine, containers.slice(0, -1)));
}

/**
 * The line's own marks hold it in `containers` (outermost first): a quote mark for each quote
 * and indent to each list item's content column. A lazy line, which runs on the paragraph above
 * it without them, does not.
 */
export function marksHold(state: EditorState, tree: Tree, info: LineMarks, containers: readonly SyntaxNode[]): boolean {
  const quotes = containers.filter((c) => c.name === 'Blockquote').length;
  if (info.quoteMarks.length < quotes) return false;
  return columnAt(state, info.textFrom) >= innerColumn(state, tree, info.line, containers);
}

/**
 * What a new line beside `info`'s line starts with to sit in `containers` (by default all that
 * hold the line), as CommonMark reads a line: each list item as spaces to its content column,
 * each quote as `> `. A mark the line writes bare before the next quote's mark (`>>`) stays
 * bare. Never a list marker, which would start a new item, and no indent past an item's
 * content column. A blank line in the same place takes this trimmed.
 */
export function containerPrefix(
  state: EditorState,
  tree: Tree,
  info: LineMarks,
  containers: readonly SyntaxNode[] = info.containers,
): string {
  let prefix = '';
  let quote = 0;
  containers.forEach((node, i) => {
    if (node.name === 'ListItem') {
      prefix += ' '.repeat(itemIndent(state, tree, containers.slice(0, i + 1)));
      return;
    }
    const mark = info.quoteMarks[quote++];
    const bare =
      mark !== undefined &&
      containers[i + 1]?.name === 'Blockquote' &&
      state.doc.sliceString(mark.to, mark.to + 1) === '>';
    prefix += bare ? '>' : '> ';
  });
  return prefix;
}

/**
 * The lines the selection touches, in order, each once, and a tree parsed past them. A
 * multi-line range that ends at the very start of a line does not touch that line.
 */
export function touchedLines(state: EditorState): { tree: Tree; lines: LineMarks[] } {
  const numbers = new Set<number>();
  let last = 0;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    let end = state.doc.lineAt(range.to);
    if (!range.empty && end.number > first.number && range.to === end.from) end = state.doc.line(end.number - 1);
    for (let n = first.number; n <= end.number; n++) numbers.add(n);
    last = Math.max(last, end.to);
  }
  const tree = treeForLine(state, last);
  const lines = [...numbers].sort((a, b) => a - b).map((n) => lineInfo(state, tree, state.doc.line(n)));
  return { tree, lines };
}

/**
 * The lines take in part of a code block (or an HTML block): some of its lines but not all of
 * them, both fences included. A command that inserts or deletes marks at line starts (quote,
 * lists, task, headings) then does nothing.
 */
export function cutsRawBlock(state: EditorState, lines: readonly LineMarks[]): boolean {
  const selected = new Set(lines.map((l) => l.line.number));
  const seen = new Set<number>();
  for (const info of lines) {
    const block = info.code;
    if (!block || !RAW_BLOCKS.has(block.name) || seen.has(block.from)) continue;
    seen.add(block.from);
    const last = state.doc.lineAt(block.to).number;
    for (let n = state.doc.lineAt(block.from).number; n <= last; n++) if (!selected.has(n)) return true;
  }
  return false;
}

/** A position's column in its line, counted in characters (the quote marks included). */
export function columnOf(state: EditorState, pos: number): number {
  return pos - state.doc.lineAt(pos).from;
}
