// List commands: toggleBulletList, toggleNumberedList, toggleTaskList, toggleTask, the list half
// of Tab and Shift+Tab (indentListItems), renumbering after an edit (renumberAfter), and the
// marker a new item starts with (newItemMarker).

import type { ChangeSpec, EditorState, Line, Transaction } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { Feature } from '../features';
import { headingLevel, NO_INLINE } from '../markdown/nodes';
import { PARSE_PAST, treeFor, treeForLine } from '../markdown/tree';
import { canEdit } from '../modes';
import { asPanelCommand, COMMAND_EVENT, type StateCommand } from './base';
import {
  columnOf,
  cutsRawBlock,
  lineInfo,
  markerOf,
  touchedLines,
  type LineMarks,
  type ListKind,
  type ListMarker,
} from './lineInfo';

// ---------------------------------------------------------------------------
// Shifting lines

function linesOfNode(state: EditorState, node: SyntaxNode): Line[] {
  const out: Line[] = [];
  const first = state.doc.lineAt(node.from).number;
  const last = state.doc.lineAt(Math.max(node.from, node.to)).number;
  for (let n = first; n <= last; n++) out.push(state.doc.line(n));
  return out;
}

/**
 * When an item's marker grows by `delta` columns, the lines after its first (its continuation
 * text and children) move right by as much, so they stay inside it. Lines indented less than
 * the item's old content column (lazy lines) are left as they are.
 */
function shiftItemBody(state: EditorState, tree: Tree, marker: ListMarker, delta: number, changes: ChangeSpec[]): void {
  if (delta <= 0) return;
  const contentColumn = columnOf(state, marker.contentFrom);
  const [, ...rest] = linesOfNode(state, marker.item);
  for (const line of rest) {
    const info = lineInfo(state, tree, line);
    if (info.blank || columnOf(state, info.textFrom) < contentColumn) continue;
    changes.push({ from: info.quoteEnd, insert: ' '.repeat(delta) });
  }
}

/** Moves every non-blank line of a list item (children included) right by `delta` spaces. */
function indentLines(state: EditorState, tree: Tree, node: SyntaxNode, delta: number, changes: ChangeSpec[]): void {
  for (const line of linesOfNode(state, node)) {
    const info = lineInfo(state, tree, line);
    if (info.blank) continue;
    changes.push({ from: info.quoteEnd, insert: ' '.repeat(delta) });
  }
}

/** Moves every line of a list item (children included) left by up to `delta` spaces. */
function outdentLines(state: EditorState, tree: Tree, node: SyntaxNode, delta: number, changes: ChangeSpec[]): void {
  for (const line of linesOfNode(state, node)) {
    const info = lineInfo(state, tree, line);
    if (info.blank) continue;
    const spaces = Math.min(delta, info.textFrom - info.quoteEnd);
    if (spaces > 0) changes.push({ from: info.quoteEnd, to: info.quoteEnd + spaces });
  }
}

// ---------------------------------------------------------------------------
// List toggles

/**
 * The lines a list command acts on: every touched line that starts an item, the item's own
 * marker line for a touched line inside an item, and every other line of plain text. Blank
 * lines, code, tables, rules and Setext headings are left out.
 */
function listTargets(state: EditorState, tree: Tree, lines: LineMarks[]): LineMarks[] {
  const byLine = new Map<number, LineMarks>();
  for (const info of lines) {
    if (info.marker) byLine.set(info.line.number, info);
    else if (info.owner && !(info.code && info.code.from < info.owner.from)) {
      const ownerLine = lineInfo(state, tree, state.doc.lineAt(info.owner.from));
      if (ownerLine.marker) byLine.set(ownerLine.line.number, ownerLine);
    } else if (!info.blank && !info.code && !info.table && !info.rule && !info.heading?.setext) {
      byLine.set(info.line.number, info);
    }
  }
  return [...byLine.values()].sort((a, b) => a.line.number - b.line.number);
}

/** The bullet character of the bullet list nearest `pos` in the file, else `-`. */
function nearestBullet(state: EditorState, tree: Tree, pos: number): string {
  let best: { distance: number; bullet: string } | null = null;
  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'BulletList') {
        const distance = pos < ref.from ? ref.from - pos : pos > ref.to ? pos - ref.to : 0;
        const mark = ref.node.firstChild?.firstChild;
        const bullet = mark?.name === 'ListMark' ? state.doc.sliceString(mark.from, mark.to) : '';
        if (/^[-*+]$/.test(bullet) && (!best || distance < best.distance)) best = { distance, bullet };
      }
      return (
        ref.name === 'Document' ||
        ref.name === 'BulletList' ||
        ref.name === 'OrderedList' ||
        ref.name === 'ListItem' ||
        ref.name === 'Blockquote'
      );
    },
  });
  return (best as { bullet: string } | null)?.bullet ?? '-';
}

/**
 * The numbered item a new numbered line at `column` continues: the item of the nearest line
 * above with text (blank lines between are fine, as a list may be loose), when it is at the
 * same column. Otherwise the new list counts from 1.
 */
function numberBefore(state: EditorState, tree: Tree, line: Line, column: number): { n: number; delimiter: string } {
  for (let n = line.number - 1; n >= 1; n--) {
    const info = lineInfo(state, tree, state.doc.line(n));
    if (info.blank) continue;
    const marker = info.marker ?? (info.owner ? markerOf(state, tree, info.owner) : null);
    if (marker?.kind === 'ordered' && columnOf(state, marker.from) === column)
      return { n: marker.number, delimiter: marker.delimiter };
    break;
  }
  return { n: 0, delimiter: '.' };
}

/**
 * The marker that starts a new item of `kind` at `column` of `line`: the bullet of the nearest
 * bullet list, or the number after the numbered item it continues, as the list toggles choose
 * them. A task's marker is a bullet's with `[ ] ` after it.
 */
export function newItemMarker(state: EditorState, tree: Tree, line: Line, column: number, kind: ListKind): string {
  if (kind === 'ordered') {
    const before = numberBefore(state, tree, line, column);
    return `${before.n + 1}${before.delimiter} `;
  }
  const bullet = nearestBullet(state, tree, line.from);
  return kind === 'task' ? `${bullet} [ ] ` : `${bullet} `;
}

/** The width of a new marker's list part (`- ` or `1. `), without a task marker. */
function listPartWidth(marker: string): number {
  return marker.replace(/\[ \] $/, '').length;
}

function toggleList(kind: ListKind): StateCommand {
  return (state) => {
    if (!canEdit(state)) return null;
    const { tree, lines } = touchedLines(state);
    if (cutsRawBlock(state, lines)) return null;
    const targets = listTargets(state, tree, lines);
    if (!targets.length) return null;
    const changes: ChangeSpec[] = [];
    if (targets.every((t) => t.marker?.kind === kind)) {
      // Already this kind: the markers go and the lines become plain text.
      for (const t of targets) changes.push({ from: t.marker!.from, to: t.marker!.to });
    } else {
      const bullet = nearestBullet(state, tree, targets[0]!.line.from);
      const counters = new Map<number, { n: number; delimiter: string }>();
      for (const t of targets) {
        const column = columnOf(state, t.marker ? t.marker.from : t.textFrom);
        for (const c of [...counters.keys()]) if (c > column) counters.delete(c);
        let insert: string;
        if (kind === 'ordered') {
          const before = counters.get(column) ?? numberBefore(state, tree, t.line, column);
          const next = { n: before.n + 1, delimiter: before.delimiter };
          counters.set(column, next);
          if (t.marker?.kind === 'ordered' && t.marker.number === next.n && t.marker.delimiter === next.delimiter)
            continue;
          insert = `${next.n}${next.delimiter} `;
        } else if (kind === 'bullet') {
          if (t.marker?.kind === 'bullet') continue;
          insert = `${t.marker?.bullet || bullet} `;
        } else {
          if (t.marker?.kind === 'task') continue;
          insert = `${t.marker?.bullet || bullet} [ ] `;
        }
        if (t.marker) {
          changes.push({ from: t.marker.from, to: t.marker.to, insert });
          const grows = listPartWidth(insert) - (t.marker.contentFrom - t.marker.from);
          shiftItemBody(state, tree, t.marker, grows, changes);
        } else {
          changes.push({ from: t.textFrom, insert });
        }
      }
    }
    if (!changes.length) return null;
    return state.update({ changes, userEvent: COMMAND_EVENT, scrollIntoView: true });
  };
}

export const toggleBulletList: StateCommand = toggleList('bullet');
export const toggleNumberedList: StateCommand = toggleList('ordered');
export const toggleTaskList: StateCommand = toggleList('task');

/** Flips `[ ]` and `[x]` on the items touched; a plain list item gets `[ ]`. */
export const toggleTask: StateCommand = (state) => {
  if (!canEdit(state)) return null;
  const { tree, lines } = touchedLines(state);
  if (cutsRawBlock(state, lines)) return null;
  const changes: ChangeSpec[] = [];
  for (const t of listTargets(state, tree, lines)) {
    const marker = t.marker;
    if (!marker) continue;
    if (marker.task)
      changes.push({ from: marker.task.from + 1, to: marker.task.from + 2, insert: marker.task.checked ? ' ' : 'x' });
    else changes.push({ from: marker.contentFrom, insert: '[ ] ' });
  }
  if (!changes.length) return null;
  return state.update({ changes, userEvent: COMMAND_EVENT, scrollIntoView: true });
};

// ---------------------------------------------------------------------------
// Tab and Shift+Tab in a list

/** The list item holding the main selection's line, if any (outside code). */
export function listItemAt(state: EditorState): SyntaxNode | null {
  const head = state.selection.main.head;
  const tree = treeForLine(state, head);
  const info = lineInfo(state, tree, state.doc.lineAt(head));
  if (info.code && (!info.owner || info.code.from > info.owner.from)) return null;
  return info.owner;
}

function prevItem(item: SyntaxNode): SyntaxNode | null {
  for (let n = item.prevSibling; n; n = n.prevSibling) if (n.name === 'ListItem') return n;
  return null;
}

function lastChildList(item: SyntaxNode): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let n = item.firstChild; n; n = n.nextSibling)
    if (n.name === 'BulletList' || n.name === 'OrderedList') found = n;
  return found;
}

function firstItem(list: SyntaxNode): SyntaxNode | null {
  for (let n = list.firstChild; n; n = n.nextSibling) if (n.name === 'ListItem') return n;
  return null;
}

function lastItem(list: SyntaxNode): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let n = list.firstChild; n; n = n.nextSibling) if (n.name === 'ListItem') found = n;
  return found;
}

/**
 * The column of a list item's marker. (A nested `ListItem` node starts at its parent's
 * content column, not at its own marker, when it is indented further than that.)
 */
function markColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark');
  return columnOf(state, mark ? mark.from : item.from);
}

/** How far this list's own nested lists sit in from their parent items, when it has any. */
function ownIndentWidth(state: EditorState, list: SyntaxNode): number | null {
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue;
    const child = lastChildList(item);
    const first = child && firstItem(child);
    if (first) return markColumn(state, first) - markColumn(state, item);
  }
  return null;
}

/** Replaces a numbered marker's number; when it gets wider, its body moves right to match. */
function renumber(state: EditorState, tree: Tree, marker: ListMarker, n: number, changes: ChangeSpec[]): void {
  if (marker.number === n) return;
  const digits = String(marker.number).length;
  const text = String(n);
  changes.push({ from: marker.from, to: marker.from + digits, insert: text });
  shiftItemBody(state, tree, marker, text.length - digits, changes);
}

/**
 * Tab (`dir` 1) and Shift+Tab (`dir` -1) on the list items the selection touches. Indenting
 * makes an item (with its children) a child of the item before it, at that item's child
 * column, or the list's own nesting width, never less than the parent marker's width.
 * Outdenting moves it to its parent's column. A numbered item starts its new list at 1, or
 * continues the list it joins. Null when no item can move.
 */
export function indentListItems(state: EditorState, dir: 1 | -1): Transaction | null {
  if (!canEdit(state)) return null;
  const { tree, lines } = touchedLines(state);
  const markers: ListMarker[] = [];
  for (const info of lines) {
    const marker = info.marker ?? (info.owner ? markerOf(state, tree, info.owner) : null);
    if (marker && !markers.some((m) => m.item.from === marker.item.from)) markers.push(marker);
  }
  // An item moves with its parent: leave out items inside another item that moves.
  const moving = markers.filter(
    (m) => !markers.some((o) => o !== m && o.item.from < m.item.from && m.item.to <= o.item.to),
  );
  const changes: ChangeSpec[] = [];
  for (const m of moving) {
    const column = columnOf(state, m.from);
    const numbered = m.list.name === 'OrderedList';
    if (dir > 0) {
      const parent = prevItem(m.item);
      const parentMarker = parent && markerOf(state, tree, parent);
      if (!parent || !parentMarker) continue;
      const children = lastChildList(parent);
      const firstChild = children && firstItem(children);
      let target: number;
      if (firstChild) target = markColumn(state, firstChild);
      else {
        const width = ownIndentWidth(state, m.list) ?? parentMarker.contentFrom - parentMarker.from;
        target = Math.max(columnOf(state, parentMarker.from) + width, columnOf(state, parentMarker.contentFrom));
      }
      const delta = target - column;
      if (delta <= 0) continue;
      indentLines(state, tree, m.item, delta, changes);
      if (numbered) {
        const joins = children?.name === 'OrderedList' ? lastItem(children) : null;
        const joinsMarker = joins && markerOf(state, tree, joins);
        renumber(
          state,
          tree,
          m,
          joinsMarker && joinsMarker.delimiter === m.delimiter ? joinsMarker.number + 1 : 1,
          changes,
        );
      }
    } else {
      const parent = m.list.parent;
      const parentMarker = parent?.name === 'ListItem' ? markerOf(state, tree, parent) : null;
      if (!parentMarker) continue;
      const delta = column - columnOf(state, parentMarker.from);
      if (delta <= 0) continue;
      outdentLines(state, tree, m.item, delta, changes);
      if (numbered && parentMarker.list.name === 'OrderedList' && parentMarker.delimiter === m.delimiter) {
        renumber(state, tree, m, parentMarker.number + 1, changes);
      }
    }
  }
  if (!changes.length) return null;
  return state.update({ changes, userEvent: dir > 0 ? 'indent.more' : 'indent.less', scrollIntoView: true });
}

// ---------------------------------------------------------------------------
// Renumbering after an edit

function itemsOf(list: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let n = list.firstChild; n; n = n.nextSibling) if (n.name === 'ListItem') out.push(n);
  return out;
}

function listDepth(list: SyntaxNode): number {
  let depth = 0;
  for (let n = list.parent; n; n = n.parent) if (n.name === 'ListItem') depth++;
  return depth;
}

/** A numbered item's mark and number, read straight from its `ListMark` (fast: lists may be long). */
function numberOf(state: EditorState, item: SyntaxNode): { from: number; to: number; number: number } | null {
  const mark = item.firstChild;
  if (!mark || mark.name !== 'ListMark') return null;
  const m = /^(\d+)[.)]$/.exec(state.doc.sliceString(mark.from, mark.to));
  return m ? { from: mark.from, to: mark.to, number: Number(m[1]) } : null;
}

function inSequence(state: EditorState, list: SyntaxNode): boolean {
  let prev: number | null = null;
  for (const item of itemsOf(list)) {
    const m = numberOf(state, item);
    if (!m) return false;
    if (prev !== null && m.number !== prev + 1) return false;
    prev = m.number;
  }
  return true;
}

/** Blocks that hold no list, so a search for lists need not look inside them. */
const NO_LISTS = new Set([...NO_INLINE, 'Paragraph', 'Table', 'HorizontalRule']);

/** The numbered lists (at any depth) that overlap or touch `[from, to]`, each once. */
function orderedListsTouching(tree: Tree, from: number, to: number, out: SyntaxNode[]): void {
  tree.iterate({
    from: Math.max(0, from - 1),
    to: to + 1,
    enter: (ref) => {
      if (ref.name === 'OrderedList') out.push(ref.node);
      return !NO_LISTS.has(ref.name) && !headingLevel(ref.name);
    },
  });
}

/**
 * The numbered lists that touch `[from, to]` (as `orderedListsTouching` finds them) in a tree
 * parsed past their ends. A list the parse has not finished stops on the last line the parse
 * reached, so the parse goes on until none does, or to the end of the note.
 */
function wholeListsTouching(state: EditorState, from: number, to: number): { tree: Tree; lists: SyntaxNode[] } {
  const doc = state.doc;
  let upto = to + PARSE_PAST;
  for (;;) {
    const tree = treeFor(state, upto);
    const lists: SyntaxNode[] = [];
    orderedListsTouching(tree, from, to, lists);
    const lastLine = doc.lineAt(Math.max(0, tree.length - 1)).number;
    const unfinished = tree.length < doc.length && lists.some((l) => doc.lineAt(l.to).number >= lastLine);
    if (!unfinished || tree.length < upto) return { tree, lists };
    upto = tree.length + PARSE_PAST;
  }
}

/**
 * The changes that renumber the numbered lists an edit touched, in the coordinates of the
 * edit's result. A list is renumbered only when it was one list before the edit, numbered in
 * sequence: two lists the edit joined into one keep the numbers they were written with. An
 * item whose number the edit itself wrote (or typed) keeps it, and the items after it count
 * on from it.
 */
export function renumberAfter(tr: Transaction): ChangeSpec[] {
  const before = tr.startState;
  const edits: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
  let lines = false;
  let wroteMarker = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    edits.push({ fromA, toA, fromB, toB });
    const text = inserted.toString();
    if (text.includes('\n') || before.doc.sliceString(fromA, toA).includes('\n')) lines = true;
    if (/\d[.)]/.test(text)) wroteMarker = true;
  });
  if (!edits.length) return [];
  // One span over all the edits (an Enter in a long list comes with one small edit per
  // number lang-markdown rewrote). Lists in the span that the edits missed are unchanged, so
  // looking at them too changes nothing.
  const fromA = edits[0]!.fromA;
  const toA = edits[edits.length - 1]!.toA;
  const fromB = edits[0]!.fromB;
  const toB = edits[edits.length - 1]!.toB;
  const oldTree = treeFor(before, toA + PARSE_PAST);
  // Quick exits, for typing: an edit within one line that touches no list marker and writes
  // none cannot change any list's numbering.
  const touching: SyntaxNode[] = [];
  orderedListsTouching(oldTree, fromA, toA, touching);
  if (!touching.length && !wroteMarker) return [];
  if (!lines && !wroteMarker) {
    let marker = false;
    for (const e of edits) {
      oldTree.iterate({
        from: Math.max(0, e.fromA - 1),
        to: e.toA + 1,
        enter: (ref) => {
          if (ref.name === 'ListMark' && ref.from <= e.toA && e.fromA <= ref.to) marker = true;
          return !marker;
        },
      });
    }
    if (!marker) return [];
  }

  const state = tr.state;
  const { tree, lists: newLists } = wholeListsTouching(state, fromB, toB);
  if (!newLists.length) return [];
  const back = tr.changes.invertedDesc;
  /** The edit wrote into this mark (edits are in document order, so a binary search finds it). */
  const touched = (m: { from: number; to: number }) => {
    let lo = 0;
    let hi = edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (edits[mid]!.toB < m.from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < edits.length && edits[i]!.fromB <= m.to; i++) {
      const e = edits[i]!;
      if ((e.fromB < m.to && e.toB > m.from) || (e.fromB === e.toB && e.fromB > m.from && e.fromB < m.to)) return true;
    }
    return false;
  };

  const changes: ChangeSpec[] = [];
  for (const list of newLists) {
    // The same list before the edit: the numbered lists at its depth in its range, mapped back.
    const depth = listDepth(list);
    const earlier = wholeListsTouching(before, back.mapPos(list.from, 1), back.mapPos(list.to, -1)).lists;
    const matching = earlier.filter((o) => listDepth(o) === depth);
    if (matching.length !== 1 || !inSequence(before, matching[0]!)) continue;
    let prev: number | null = null;
    for (const item of itemsOf(list)) {
      const m = numberOf(state, item);
      if (!m) break;
      if (prev === null || touched(m)) {
        prev = m.number;
        continue;
      }
      prev = prev + 1;
      if (m.number === prev) continue;
      // Only an item that needs a new number is read in full (its body may have to move).
      const marker = markerOf(state, tree, item);
      if (marker) renumber(state, tree, marker, prev, changes);
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// The commands

export const listCommands: Feature = {
  id: 'listCommands',
  commands: {
    toggleBulletList: asPanelCommand(toggleBulletList),
    toggleNumberedList: asPanelCommand(toggleNumberedList),
    toggleTaskList: asPanelCommand(toggleTaskList),
    toggleTask: asPanelCommand(toggleTask),
  },
};
