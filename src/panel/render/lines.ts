// The document's lines and block nodes, read once per document and per tree and shared by
// every feature: the line table (`linesOf`) and the block index (`blocksOf`, `blocksIn`).

import { syntaxTree } from '@codemirror/language';
import { StateField, type ChangeDesc, type EditorState, type Text } from '@codemirror/state';
import { IterMode, type SyntaxNode, type Tree, type TreeCursor } from '@lezer/common';
import { isSpaceOrTab } from '../../core/markdownText';
import { QUOTE_LEVELS } from '../markdown/nodes';

export interface Span {
  from: number;
  to: number;
}

interface LineInfo {
  /** 1-based. */
  number: number;
  from: number;
  to: number;
  text: string;
}

/** The document's lines: start offsets and texts. Far cheaper than `doc.line(n)` in a loop. */
export class Lines {
  /** starts[n] is the offset of line n (1-based); starts[count + 1] is the length plus one. */
  private readonly starts: Int32Array;
  private readonly texts: string[];
  readonly count: number;

  private constructor(starts: Int32Array, texts: string[]) {
    this.starts = starts;
    this.texts = texts;
    this.count = texts.length - 1;
  }

  /** Every line of `doc`, read in one pass. */
  static of(doc: Text): Lines {
    const count = doc.lines;
    const starts = new Int32Array(count + 2);
    const texts = new Array<string>(count + 1);
    texts[0] = '';
    let n = 1;
    let pos = 0;
    for (const iter = doc.iterLines(); !iter.next().done; n++) {
      starts[n] = pos;
      texts[n] = iter.value;
      pos += iter.value.length + 1;
    }
    starts[count + 1] = pos;
    return new Lines(starts, texts);
  }

  /**
   * The table of `doc`, which is this table's document after `changes`: the lines the changes
   * touch are read from `doc`, the others are shifted.
   */
  mapped(changes: ChangeDesc, doc: Text): Lines {
    const count = doc.lines;
    const starts = new Int32Array(count + 2);
    const texts = new Array<string>(count + 1);
    texts[0] = '';
    // Line `oldLine` of this table is copied to line `newLine`, with its offset moved by `shift`.
    let oldLine = 1;
    let newLine = 1;
    const copyUpTo = (lastOld: number, shift: number) => {
      for (; oldLine <= lastOld; oldLine++, newLine++) {
        starts[newLine] = this.starts[oldLine]! + shift;
        texts[newLine] = this.texts[oldLine]!;
      }
    };
    const readUpTo = (lastNew: number) => {
      for (; newLine <= lastNew; newLine++) {
        const line = doc.line(newLine);
        starts[newLine] = line.from;
        texts[newLine] = line.text;
      }
    };
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      // The lines before the change are shifted (none, when the change before ended on this
      // change's first line); the lines it touches are read.
      copyUpTo(this.numberAt(fromA) - 1, fromB - fromA);
      readUpTo(doc.lineAt(toB).number);
      oldLine = this.numberAt(toA) + 1;
    });
    copyUpTo(this.count, doc.length - this.length);
    starts[count + 1] = doc.length + 1;
    return new Lines(starts, texts);
  }

  get length(): number {
    return this.starts[this.count + 1]! - 1;
  }
  start(n: number): number {
    return this.starts[n]!;
  }
  /** The offset just after the line's last character. */
  end(n: number): number {
    return this.starts[n + 1]! - 1;
  }
  text(n: number): string {
    return this.texts[n]!;
  }
  /** The number of the line holding `pos`. */
  numberAt(pos: number): number {
    let lo = 1;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  get(n: number): LineInfo {
    return { number: n, from: this.starts[n]!, to: this.starts[n + 1]! - 1, text: this.texts[n]! };
  }
  at(pos: number): LineInfo {
    return this.get(this.numberAt(pos));
  }
}

const linesCache = new WeakMap<Text, Lines>();

/** The line table of `doc`, built on first use and kept while the document lives. */
export function linesOf(doc: Text): Lines {
  let lines = linesCache.get(doc);
  if (!lines) linesCache.set(doc, (lines = Lines.of(doc)));
  return lines;
}

/**
 * Keeps the line table of each new document, made from the previous one, so a keystroke
 * does not read every line again. First in `renderFramework`, so its update runs before any
 * feature asks for the new table.
 */
export const linesField = StateField.define<Lines>({
  create: (state) => linesOf(state.doc),
  update(lines, tr) {
    if (!tr.docChanged) return lines;
    let next = linesCache.get(tr.state.doc);
    if (!next) linesCache.set(tr.state.doc, (next = lines.mapped(tr.changes, tr.state.doc)));
    return next;
  },
});

/** One block node (a heading, paragraph, list, list item, quote, code block...) with what features ask of it. */
export interface BlockEntry {
  readonly node: SyntaxNode;
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** The lines it starts and ends on (1-based). */
  readonly firstLine: number;
  readonly lastLine: number;
  /** True for a block directly inside the document. */
  readonly top: boolean;
  /** How many list items hold it, itself included. */
  readonly listDepth: number;
  /** How many quotes hold it, itself included; a box counts as a quote (`QUOTE_LEVELS`). */
  readonly quoteDepth: number;
}

/** Appends the block at `cursor` and every block inside it, parents before children. */
function addBlock(
  cursor: TreeCursor,
  lines: Lines,
  top: boolean,
  listDepth: number,
  quoteDepth: number,
  out: BlockEntry[],
): void {
  const type = cursor.type;
  const name = type.name;
  const list = listDepth + (name === 'ListItem' ? 1 : 0);
  const quote = quoteDepth + (QUOTE_LEVELS.has(name) ? 1 : 0);
  const from = cursor.from;
  const to = cursor.to;
  out.push({
    node: cursor.node,
    name,
    from,
    to,
    firstLine: lines.numberAt(from),
    lastLine: lines.numberAt(to),
    top,
    listDepth: list,
    quoteDepth: quote,
  });
  if (!type.is('BlockContext') || !cursor.firstChild()) return;
  do if (cursor.type.is('Block')) addBlock(cursor, lines, false, list, quote, out);
  while (cursor.nextSibling());
  cursor.parent();
}

/** The entries of one top-level block: itself, then every block inside it. */
export function entriesOf(top: SyntaxNode, lines: Lines, out: BlockEntry[] = []): BlockEntry[] {
  addBlock(top.cursor(IterMode.IgnoreMounts), lines, true, 0, 0, out);
  return out;
}

// The top-level blocks of a tree, found by position. The document node's children sit in a
// balanced tree, so finding one is logarithmic and stepping to a neighbor is cheap.

/** The first top-level block of `tree` ending at or after `pos`, or null. */
export function topEndingAtOrAfter(tree: Tree, pos: number): SyntaxNode | null {
  const cursor = tree.cursor(IterMode.IgnoreMounts);
  if (!cursor.childAfter(pos - 1)) return null;
  do if (cursor.type.is('Block')) return cursor.node;
  while (cursor.nextSibling());
  return null;
}

export function lastTop(tree: Tree): SyntaxNode | null {
  const cursor = tree.cursor(IterMode.IgnoreMounts);
  if (!cursor.lastChild()) return null;
  do if (cursor.type.is('Block')) return cursor.node;
  while (cursor.prevSibling());
  return null;
}

export function nextTop(node: SyntaxNode): SyntaxNode | null {
  let next = node.nextSibling;
  while (next && !next.type.is('Block')) next = next.nextSibling;
  return next;
}

export function prevTop(node: SyntaxNode): SyntaxNode | null {
  let prev = node.prevSibling;
  while (prev && !prev.type.is('Block')) prev = prev.prevSibling;
  return prev;
}

const allBlocksCache = new WeakMap<Tree, BlockEntry[]>();

/** Every block node of the state's tree in document order (parents before children), from one walk per tree. */
export function blocksOf(state: EditorState): readonly BlockEntry[] {
  const tree = syntaxTree(state);
  let entries = allBlocksCache.get(tree);
  if (!entries) {
    entries = [];
    const lines = linesOf(state.doc);
    for (let top = topEndingAtOrAfter(tree, 0); top; top = nextTop(top)) entriesOf(top, lines, entries);
    allBlocksCache.set(tree, entries);
  }
  return entries;
}

/** The spans `blocksIn` read, per tree: every block feature asks for the same spans after an edit. */
const spanBlocksCache = new WeakMap<Tree, Map<string, BlockEntry[]>>();
const SPAN_CACHE_SIZE = 8;

/** The blocks inside [from, to], which a partial draw always aligns to whole top-level blocks. */
export function blocksIn(state: EditorState, from: number, to: number): BlockEntry[] {
  const tree = syntaxTree(state);
  let spans = spanBlocksCache.get(tree);
  if (!spans) spanBlocksCache.set(tree, (spans = new Map()));
  const key = `${from}:${to}`;
  let entries = spans.get(key);
  if (!entries) {
    entries = [];
    const lines = linesOf(state.doc);
    for (let top = topEndingAtOrAfter(tree, from); top && top.from <= to; top = nextTop(top)) {
      entriesOf(top, lines, entries);
    }
    if (spans.size >= SPAN_CACHE_SIZE) spans.clear();
    spans.set(key, entries);
  }
  return entries;
}

/** True for an empty line or one of spaces and tabs only. */
export function isBlankLine(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (!isSpaceOrTab(text.charCodeAt(i))) return false;
  return true;
}
