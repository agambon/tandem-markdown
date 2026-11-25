// Which parts of the document a block feature must draw again after a change (`docDamage`),
// found by comparing the block index of the old and new trees once per transaction, and whether
// a change may have touched a kind of top-level block (`damageTouches`).

import { syntaxTree } from '@codemirror/language';
import type { Transaction } from '@codemirror/state';
import { IterMode, type SyntaxNode, type Tree, type TreeCursor } from '@lezer/common';
import {
  entriesOf,
  lastTop,
  linesOf,
  nextTop,
  prevTop,
  topEndingAtOrAfter,
  type BlockEntry,
  type Lines,
  type Span,
} from './lines';

/**
 * A partial draw covering more than this share of the parsed document draws it all instead.
 * Text past the end of the tree has no blocks, so it costs nothing to draw.
 */
const PARTIAL_LIMIT = 0.5;

function sameEntry(a: BlockEntry, b: BlockEntry, map: (pos: number, assoc: number) => number): boolean {
  return (
    a.name === b.name &&
    map(a.from, -1) === b.from &&
    map(a.to, 1) === b.to &&
    a.listDepth === b.listDepth &&
    a.quoteDepth === b.quoteDepth &&
    a.top === b.top
  );
}

/**
 * Widens [from, to] to whole top-level blocks and whole lines. With `context`, also takes
 * in the top-level block before and the one after, and the blank lines between: a block's
 * drawing may depend on its neighbors (a gap above it, a run of blank lines), never further.
 */
export function widenToBlocks(tree: Tree, lines: Lines, from: number, to: number, context: boolean): Span {
  const first = topEndingAtOrAfter(tree, from);
  const last = topEndingAtOrAfter(tree, to);
  // The block the span starts with; null when it starts before the first block.
  let head: SyntaxNode | null;
  if (!first) head = lastTop(tree);
  else if (context || first.from > from) head = prevTop(first);
  else head = first;
  // The block the span ends with; null when it runs to the end of the document.
  const tail = context && last ? nextTop(last) : last;
  const start = head ? Math.min(from, head.from) : 0;
  const end = tail ? Math.max(to, tail.to) : lines.end(lines.count);
  return { from: lines.start(lines.numberAt(start)), to: lines.end(lines.numberAt(end)) };
}

export function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else out.push({ ...span });
  }
  return out;
}

const docDamageCache = new WeakMap<Transaction, Span[] | null>();

/**
 * The parts of the new document whose block drawing may differ after `tr` (a change to the
 * text or a grown tree), as whole top-level blocks with one neighbor each side. Null when
 * drawing everything again is as cheap. Shared by every block feature through a cache.
 */
export function docDamage(tr: Transaction): Span[] | null {
  if (docDamageCache.has(tr)) return docDamageCache.get(tr)!;
  const result = computeDocDamage(tr);
  docDamageCache.set(tr, result);
  return result;
}

/**
 * The top-level blocks of the two trees that may differ, as two lists of entries; the blocks
 * before and after them are the same in both trees. Null when they run on for more than
 * PARTIAL_LIMIT of the parsed text, which is then drawn again whole.
 *
 * Markdown is parsed line by line, so every block closed before the first changed line is
 * parsed alike in both trees: a block is closed once the block after it has started. After
 * the changes, once a top-level block is the same in both trees (same place, same blocks
 * inside), every block after it is the same too. So only the blocks between are compared.
 */
function blocksBetween(
  tr: Transaction,
  dirtyFrom: number,
  dirtyTo: number,
): { before: BlockEntry[]; now: BlockEntry[] } | null {
  const oldTree = syntaxTree(tr.startState);
  const newTree = syntaxTree(tr.state);
  const oldLines = linesOf(tr.startState.doc);
  const newLines = linesOf(tr.state.doc);
  const limit = PARTIAL_LIMIT * newTree.length;

  // The last block that was closed before the first changed line began.
  const firstLineStart = newLines.start(newLines.numberAt(dirtyFrom));
  const afterClosed = topEndingAtOrAfter(newTree, firstLineStart);
  let closed = afterClosed ? prevTop(afterClosed) : lastTop(newTree);
  let closedOld: SyntaxNode | null = null;
  for (; closed; closed = prevTop(closed)) {
    const next = nextTop(closed);
    if (!next || next.from >= firstLineStart) continue;
    closedOld = topEndingAtOrAfter(oldTree, closed.to);
    if (closedOld && closedOld.from === closed.from && closedOld.to === closed.to && closedOld.name === closed.name)
      break;
  }
  const startNew = closed ? nextTop(closed) : topEndingAtOrAfter(newTree, 0);
  const startOld = closed && closedOld ? nextTop(closedOld) : topEndingAtOrAfter(oldTree, 0);

  // The first block after the last changed line that is the same in both trees.
  const shift = tr.state.doc.length - tr.startState.doc.length;
  const lastLineEnd = newLines.end(newLines.numberAt(dirtyTo));
  let same: SyntaxNode | null = topEndingAtOrAfter(newTree, lastLineEnd + 1);
  while (same && same.from <= lastLineEnd) same = nextTop(same);
  let sameOld: SyntaxNode | null = null;
  for (; same; same = nextTop(same)) {
    if (same.from - firstLineStart > limit) return null;
    const old = topEndingAtOrAfter(oldTree, same.from - shift);
    if (old && old.from === same.from - shift && sameTop(old, same, oldLines, newLines, shift)) {
      sameOld = old;
      break;
    }
  }

  const before: BlockEntry[] = [];
  const endOld = sameOld ? sameOld.from : Infinity;
  for (let top = startOld; top && top.from < endOld; top = nextTop(top)) entriesOf(top, oldLines, before);
  const now: BlockEntry[] = [];
  const endNew = same ? same.from : Infinity;
  for (let top = startNew; top && top.from < endNew; top = nextTop(top)) entriesOf(top, newLines, now);
  return { before, now };
}

/** Whether a top-level block of the old tree and one of the new, `shift` further on, are the same blocks. */
function sameTop(old: SyntaxNode, now: SyntaxNode, oldLines: Lines, newLines: Lines, shift: number): boolean {
  if (old.tree && old.tree === now.tree) return true;
  const a = entriesOf(old, oldLines);
  const b = entriesOf(now, newLines);
  const map = (pos: number) => pos + shift;
  return a.length === b.length && a.every((entry, i) => sameEntry(entry, b[i]!, map));
}

function computeDocDamage(tr: Transaction): Span[] | null {
  const oldTree = syntaxTree(tr.startState);
  const newTree = syntaxTree(tr.state);
  const map = (pos: number, assoc: number) => tr.changes.mapPos(pos, assoc);
  let from = Infinity;
  let to = -Infinity;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  // Where the trees may differ: the changed text, and where one is parsed further than the other.
  let dirtyFrom = from;
  let dirtyTo = to;
  const oldEnd = map(oldTree.length, 1);
  if (oldEnd !== newTree.length) {
    dirtyFrom = Math.min(dirtyFrom, oldEnd, newTree.length);
    dirtyTo = Math.max(dirtyTo, oldEnd, newTree.length);
  }
  if (dirtyFrom > dirtyTo) {
    // The tree changed in place (a code block's language was parsed when it loaded): nothing says where.
    dirtyFrom = 0;
    dirtyTo = tr.state.doc.length;
  }
  const between = blocksBetween(tr, dirtyFrom, dirtyTo);
  if (!between) return null;
  const { before, now } = between;
  let head = 0;
  while (head < before.length && head < now.length && sameEntry(before[head]!, now[head]!, map)) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < now.length - head &&
    sameEntry(before[before.length - 1 - tail]!, now[now.length - 1 - tail]!, map)
  ) {
    tail++;
  }
  if (head < now.length - tail) {
    from = Math.min(from, now[head]!.from);
    to = Math.max(to, now[now.length - 1 - tail]!.to);
  }
  if (head < before.length - tail) {
    // Blocks went away: the damage is where they were.
    from = Math.min(from, map(before[head]!.from, -1));
    to = Math.max(to, map(before[before.length - 1 - tail]!.to, 1));
  }
  if (from > to) return [];
  const span = widenToBlocks(newTree, linesOf(tr.state.doc), from, to, true);
  if (Math.min(span.to, newTree.length) - span.from > PARTIAL_LIMIT * newTree.length) return null;
  return [span];
}

/** Whether [from, to] touches none of `spans`. */
export function outside(spans: readonly Span[], from: number, to: number): boolean {
  for (const span of spans) if (from <= span.to && to >= span.from) return false;
  return true;
}

/** Whether a top-level block of `tree` overlapping [from, to] is one that `is` accepts. */
function topBlockIn(tree: Tree, from: number, to: number, is: (top: TreeCursor) => boolean): boolean {
  const cursor = tree.cursor(IterMode.IgnoreMounts);
  if (!cursor.childAfter(from - 1)) return false;
  do {
    if (cursor.from > to) return false;
    if (is(cursor)) return true;
  } while (cursor.nextSibling());
  return false;
}

/**
 * Whether `tr` may have changed a top-level block that `is` accepts: one lies where the blocks
 * may differ (`docDamage`), in the new tree or, mapped back, in the old one. True when
 * everything is drawn again.
 */
export function damageTouches(tr: Transaction, is: (top: TreeCursor) => boolean): boolean {
  const damage = docDamage(tr);
  if (!damage) return true;
  const back = tr.changes.invertedDesc;
  const before = syntaxTree(tr.startState);
  const after = syntaxTree(tr.state);
  return damage.some(
    (span) =>
      topBlockIn(after, span.from, span.to, is) ||
      topBlockIn(before, back.mapPos(span.from, -1), back.mapPos(span.to, 1), is),
  );
}
