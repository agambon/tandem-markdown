// Inline formatting commands: toggleBold, toggleItalic, toggleStrikethrough, toggleCode,
// toggleHighlight, insertLink.
//
// They work from the syntax tree: "already bold" means the selection sits inside a
// `StrongEmphasis` node, never that the text happens to hold `**`. A toggle wraps or unwraps
// the selection (`toggleSelection`), or at a cursor the word there (`toggleCursor`). Inside
// code spans or code blocks nothing happens (toggleCode unwraps a code span). An empty pair a
// command left behind is tracked (`pairField`) so typing.ts can remove it when the cursor
// leaves it without typing, and the same command again removes it at once. The insert menu
// leaves the same pairs (`emptyPair`, `insertPair`).

import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSet,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { Feature } from '../features';
import { webAddress } from '../links/read';
import { LINK_NODES } from '../markdown/nodes';
import { codeAt, treeForLine } from '../markdown/tree';
import { linkDestination, longestRun } from '../markdown/writing';
import { canEdit } from '../modes';
import { asPanelCommand, COMMAND_EVENT, type StateCommand } from './base';
import { lineInfo } from './lineInfo';

// ---------------------------------------------------------------------------
// Empty pairs left by a command

/** One pair of marks inserted by a command, with nothing typed between them yet. */
export interface PairMember {
  id: string;
  open: string;
  close: string;
}

/**
 * Empty pairs nested around one cursor (`**|**`, or `***|***` after Bold then Italic). The
 * document holds the members' opening marks from `from` to `cursor` (outermost first) and
 * their closing marks from `cursor` to `to` (innermost first).
 */
interface PairStack {
  from: number;
  cursor: number;
  to: number;
  members: PairMember[];
}

export const setPairsEffect = StateEffect.define<PairStack | null>();

/** The empty pairs at the cursor, until something is typed between them or the document changes around them. */
export const pairField = StateField.define<PairStack | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setPairsEffect)) return effect.value;
    if (!value || !tr.docChanged) return value;
    let inside = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA < value.to && toA > value.from) inside = true;
    });
    if (inside) return null;
    return {
      from: tr.changes.mapPos(value.from, 1),
      cursor: tr.changes.mapPos(value.cursor, 1),
      to: tr.changes.mapPos(value.to, -1),
      members: value.members,
    };
  },
});

/** The changes and the stack left when one member of a pair stack is removed. */
export function removePairMember(
  stack: PairStack,
  index: number,
): { changes: ChangeSpec[]; stack: PairStack | null; cursor: number } {
  const member = stack.members[index]!;
  let openFrom = stack.from;
  for (let i = 0; i < index; i++) openFrom += stack.members[i]!.open.length;
  let closeFrom = stack.cursor;
  for (let i = stack.members.length - 1; i > index; i--) closeFrom += stack.members[i]!.close.length;
  const changes = [
    { from: openFrom, to: openFrom + member.open.length },
    { from: closeFrom, to: closeFrom + member.close.length },
  ];
  const members = stack.members.filter((_, i) => i !== index);
  const cursor = stack.cursor - member.open.length;
  const next = members.length
    ? { from: stack.from, cursor, to: stack.to - member.open.length - member.close.length, members }
    : null;
  return { changes, stack: next, cursor };
}

/** Adds a pair at `pos`: to the stack there, or as a new stack. */
function pushPair(stack: PairStack | null | undefined, pos: number, member: PairMember): PairStack {
  if (stack && stack.cursor === pos) {
    return {
      from: stack.from,
      cursor: pos + member.open.length,
      to: stack.to + member.open.length + member.close.length,
      members: [...stack.members, member],
    };
  }
  return {
    from: pos,
    cursor: pos + member.open.length,
    to: pos + member.open.length + member.close.length,
    members: [member],
  };
}

/**
 * `member`'s marks inserted at `pos` with the cursor between them, kept as an empty pair: it goes
 * again when the cursor leaves it with nothing typed, as the pair an inline command leaves does.
 */
export function insertPair(state: EditorState, pos: number, member: PairMember): TransactionSpec {
  return {
    changes: { from: pos, insert: member.open + member.close },
    selection: EditorSelection.cursor(pos + member.open.length),
    effects: setPairsEffect.of(pushPair(state.field(pairField, false), pos, member)),
  };
}

// ---------------------------------------------------------------------------
// Reading the tree

interface InlineKind {
  id: string;
  /** The node that holds a phrase of this kind. */
  node: string;
  /** The mark a new phrase gets (the code mark grows with the backticks inside). */
  mark: string;
}

const BOLD: InlineKind = { id: 'bold', node: 'StrongEmphasis', mark: '**' };
const ITALIC: InlineKind = { id: 'italic', node: 'Emphasis', mark: '*' };
const STRIKE: InlineKind = { id: 'strikethrough', node: 'Strikethrough', mark: '~~' };
const CODE: InlineKind = { id: 'code', node: 'InlineCode', mark: '`' };
const HIGHLIGHT: InlineKind = { id: 'highlight', node: 'Highlight', mark: '==' };

/** The inline formats by name: the kinds above, and a link. */
type InlineFormat = 'bold' | 'italic' | 'strikethrough' | 'code' | 'highlight' | 'link';

/** The empty pair a link command leaves at a cursor: the text's brackets, then an empty address. */
const LINK_PAIR: PairMember = { id: 'link', open: '[', close: ']()' };

/** Inline nodes a mark may not cut into: a selection touching one is widened to all of it. */
const ATOMIC = new Set([
  'InlineCode',
  'Autolink',
  'URL',
  'Image',
  'Wikilink',
  'Embed',
  'HTMLTag',
  'Entity',
  'Escape',
  'FootnoteRef',
  'Comment',
]);
/** Inline nodes with text inside that may hold other marks. */
const CONTAINERS = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'Highlight', 'Link']);

interface Marks {
  open: { from: number; to: number };
  close: { from: number; to: number };
}

/** A phrase node's opening and closing marks; a code span's single padding spaces count as marks. */
function marksOf(state: EditorState, node: SyntaxNode): Marks | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open.from === close.from || !/Mark$/.test(open.name) || !/Mark$/.test(close.name)) return null;
  const marks = { open: { from: open.from, to: open.to }, close: { from: close.from, to: close.to } };
  if (node.name === 'InlineCode') {
    const inner = state.doc.sliceString(open.to, close.from);
    if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
      marks.open.to++;
      marks.close.from--;
    }
  }
  return marks;
}

/** The innermost node named `name` that holds all of `[from, to]`. */
function enclosing(tree: Tree, name: string, from: number, to: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) {
    if (n.name === name && n.from <= from && to <= n.to) return n;
  }
  return null;
}

/** The innermost node named `name` that holds `pos` strictly inside it. */
function around(tree: Tree, name: string, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 0); n; n = n.parent) {
    if (n.name === name && n.from < pos && pos < n.to) return n;
  }
  return null;
}

/** `[from, to]` lies inside a code span's text (not just over the span as a whole). */
function insideCodeSpan(state: EditorState, tree: Tree, from: number, to: number): SyntaxNode | null {
  const span = enclosing(tree, 'InlineCode', from, to);
  if (!span) return null;
  const marks = marksOf(state, span);
  return marks && marks.open.to <= from && to <= marks.close.from ? span : null;
}

interface Part {
  from: number;
  to: number;
}

function trimPart(state: EditorState, from: number, to: number): Part | null {
  const text = state.doc.sliceString(from, to);
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return start < end ? { from: from + start, to: from + end } : null;
}

/**
 * The parts of `[from, to]` a mark applies to: on each line, the text after its block marks
 * (quote, list, task, heading), trimmed of spaces; in a table row, each cell's text. Lines of
 * code, rules and Setext underlines have none.
 */
function partsOf(state: EditorState, tree: Tree, from: number, to: number): Part[] {
  const out: Part[] = [];
  const doc = state.doc;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  for (let n = first; n <= last; n++) {
    const info = lineInfo(state, tree, doc.line(n));
    if (info.blank || info.code || info.setextUnderline || info.rule) continue;
    const s = Math.max(from, info.contentFrom);
    const e = Math.min(to, info.contentTo);
    if (s >= e) continue;
    if (info.table) {
      tree.iterate({
        from: info.line.from,
        to: info.line.to,
        enter: (ref) => {
          if (ref.name !== 'TableCell') return true;
          const part = trimPart(state, Math.max(s, ref.from), Math.min(e, ref.to));
          if (part && part.from < part.to) out.push(part);
          return false;
        },
      });
      continue;
    }
    const part = trimPart(state, s, e);
    if (part) out.push(part);
  }
  return out;
}

/**
 * Widens `[s, e]` until it cuts into no inline node: an atomic node (code span, URL, image,
 * wikilink...) it touches is taken whole, and so is a phrase or link it only partly covers.
 * A range inside a link's text stays there; one touching its address takes the whole link.
 */
function widen(tree: Tree, s: number, e: number): [number, number] {
  // Each pass can only widen the range; the bound is a stop against a tree that keeps offering more.
  for (let guard = 0; guard < 50; guard++) {
    let ns = s;
    let ne = e;
    tree.iterate({
      from: s,
      to: e,
      enter: (ref) => {
        if (ref.to <= s || ref.from >= e) return false;
        const atomic = ATOMIC.has(ref.name);
        if (!atomic && !CONTAINERS.has(ref.name)) return true;
        const covers = ref.from >= s && ref.to <= e;
        const holds = ref.from <= s && e <= ref.to;
        if (atomic) {
          if (!covers) {
            ns = Math.min(ns, ref.from);
            ne = Math.max(ne, ref.to);
          }
          return false;
        }
        if (ref.name === 'Link' && holds && !covers) {
          const marks = ref.node.getChildren('LinkMark');
          if (marks.length >= 2 && s >= marks[0]!.to && e <= marks[1]!.from) return true; // inside the link's text
          ns = Math.min(ns, ref.from);
          ne = Math.max(ne, ref.to);
          return false;
        }
        if (!covers && !holds) {
          ns = Math.min(ns, ref.from);
          ne = Math.max(ne, ref.to);
          return false;
        }
        return true;
      },
    });
    if (ns === s && ne === e) break;
    s = ns;
    e = ne;
  }
  return [s, e];
}

/** The marks a new phrase of `kind` around `text` gets. */
function newMarks(kind: InlineKind, text: string): { open: string; close: string } {
  if (kind !== CODE) return { open: kind.mark, close: kind.mark };
  const ticks = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return { open: ticks + pad, close: pad + ticks };
}

interface Wrapped extends Part {
  open: string;
  close: string;
}

/**
 * Wraps `[s, e]` (widened as `widen` says) in `kind`, merging phrases of the kind inside it.
 * Gives the range wrapped and the marks put around it.
 */
function wrap(state: EditorState, tree: Tree, kind: InlineKind, s: number, e: number, changes: ChangeSpec[]): Wrapped {
  [s, e] = widen(tree, s, e);
  tree.iterate({
    from: s,
    to: e,
    enter: (ref) => {
      if (ref.name !== kind.node || ref.from < s || ref.to > e) return true;
      const marks = marksOf(state, ref.node);
      if (marks)
        changes.push({ from: marks.open.from, to: marks.open.to }, { from: marks.close.from, to: marks.close.to });
      return true;
    },
  });
  const { open, close } = newMarks(kind, state.doc.sliceString(s, e));
  changes.push({ from: s, insert: open }, { from: e, insert: close });
  return { from: s, to: e, open, close };
}

/**
 * Where the text of a wrapped range lands: just inside its new marks. (Mapping its ends with
 * `mapPos` alone is not enough: a merged phrase's mark deleted at the same place makes the
 * insertion a replacement, and a position at a replacement's edge maps to its start.)
 */
function wrappedText(set: ChangeSet, w: Wrapped): { from: number; to: number } {
  return { from: set.mapPos(w.from, -1) + w.open.length, to: set.mapPos(w.to, 1) - w.close.length };
}

/** Removes a phrase's marks. */
function unwrapNode(marks: Marks, changes: ChangeSpec[]): void {
  changes.push({ from: marks.open.from, to: marks.open.to }, { from: marks.close.from, to: marks.close.to });
}

/**
 * Unwraps `part` from the phrase `node`: the whole phrase when the part covers its text, else
 * just the part. A phrase that spans lines is given all its selected parts at once, as one span.
 */
function unwrapPart(state: EditorState, node: SyntaxNode, part: Part, changes: ChangeSpec[]): void {
  const marks = marksOf(state, node);
  if (!marks) return;
  const text = trimPart(state, marks.open.to, marks.close.from);
  const innerFrom = text?.from ?? marks.open.to;
  const innerTo = text?.to ?? marks.close.from;
  if (part.from <= innerFrom && part.to >= innerTo) {
    unwrapNode(marks, changes);
    return;
  }
  const doc = state.doc;
  let left = Math.max(part.from, innerFrom);
  while (left > innerFrom && /\s/.test(doc.sliceString(left - 1, left))) left--;
  let right = Math.min(part.to, innerTo);
  while (right < innerTo && /\s/.test(doc.sliceString(right, right + 1))) right++;
  const openText = doc.sliceString(marks.open.from, marks.open.to);
  const closeText = doc.sliceString(marks.close.from, marks.close.to);
  const leftEmpty = left <= innerFrom;
  const rightEmpty = right >= innerTo;
  if (leftEmpty && rightEmpty) unwrapNode(marks, changes);
  else if (leftEmpty) changes.push({ from: marks.open.from, to: marks.open.to }, { from: right, insert: openText });
  else if (rightEmpty) changes.push({ from: left, insert: closeText }, { from: marks.close.from, to: marks.close.to });
  else changes.push({ from: left, insert: closeText }, { from: right, insert: openText });
}

function rangeLike(range: SelectionRange, from: number, to: number): SelectionRange {
  return range.anchor > range.head ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
}

// ---------------------------------------------------------------------------
// The toggles

interface RangeResult {
  changes: ChangeSpec;
  range: SelectionRange;
  pairs?: PairStack | null;
}

/**
 * A toggle over selected text:
 *   - inside a node of the kind: exactly its inside or the whole node unwraps it; part of its
 *     inside is unwrapped from it (`**a b c**` with `b` selected gives `**a** b **c**`);
 *   - otherwise the selection is wrapped. Marks go inside its leading and trailing spaces. A
 *     selection that cuts into another inline node (a link, a code span, other emphasis) is
 *     widened to the whole node first, and nodes of the same kind inside it are merged into
 *     the new one, so the result always parses as intended;
 *   - across several lines, paragraphs or table cells, each part is wrapped separately; when
 *     every part is already of the kind, every part is unwrapped.
 */
function toggleSelection(state: EditorState, tree: Tree, kind: InlineKind, range: SelectionRange): RangeResult | null {
  const parts = partsOf(state, tree, range.from, range.to).filter(
    (p) => kind === CODE || !insideCodeSpan(state, tree, p.from, p.to),
  );
  if (!parts.length) return null;
  const inside = parts.map((p) =>
    kind === CODE
      ? (insideCodeSpan(state, tree, p.from, p.to) ?? enclosing(tree, kind.node, p.from, p.to))
      : enclosing(tree, kind.node, p.from, p.to),
  );
  const changes: ChangeSpec[] = [];
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (inside.every(Boolean)) {
    // Parts in one phrase (it spans lines) are unwrapped together: the span from the first to the last.
    const byNode = new Map<string, { node: SyntaxNode; part: Part }>();
    parts.forEach((p, i) => {
      const node = inside[i]!;
      const key = `${node.from}:${node.to}`;
      const group = byNode.get(key);
      if (group) group.part = { from: Math.min(group.part.from, p.from), to: Math.max(group.part.to, p.to) };
      else byNode.set(key, { node, part: { from: p.from, to: p.to } });
    });
    for (const { node, part } of byNode.values()) unwrapPart(state, node, part, changes);
    if (!changes.length) return null;
    const set = state.changes(changes);
    return { changes: set, range: rangeLike(range, set.mapPos(first.from, 1), set.mapPos(last.to, -1)) };
  }
  // The new selection covers what was wrapped, widened as it was, so the same command again unwraps it.
  const wrapped = new Map<Part, Wrapped>();
  parts.forEach((p, i) => {
    if (!inside[i]) wrapped.set(p, wrap(state, tree, kind, p.from, p.to, changes));
  });
  if (!changes.length) return null;
  const set = state.changes(changes);
  const firstWrap = wrapped.get(first);
  const lastWrap = wrapped.get(last);
  const from = firstWrap ? wrappedText(set, firstWrap).from : set.mapPos(first.from, 1);
  const to = lastWrap ? wrappedText(set, lastWrap).to : set.mapPos(last.to, -1);
  return { changes: set, range: rangeLike(range, from, to) };
}

/**
 * A toggle at a cursor: inside a node of the kind, it is unwrapped; on a word, the word is
 * toggled; otherwise the pair is inserted with the cursor between.
 */
function toggleCursor(state: EditorState, tree: Tree, kind: InlineKind, range: SelectionRange): RangeResult | null {
  const pos = range.head;
  const code = codeAt(tree, pos);
  if (code?.kind === 'block') return null;
  const stack = state.field(pairField, false);
  if (stack && stack.cursor === pos) {
    const index = stack.members.map((m) => m.id).lastIndexOf(kind.id);
    if (index >= 0) {
      const removed = removePairMember(stack, index);
      return { changes: removed.changes, range: EditorSelection.cursor(removed.cursor), pairs: removed.stack };
    }
  }
  let node: SyntaxNode | null = null;
  if (code) {
    if (kind !== CODE) return null;
    node = code.node;
  } else {
    node = around(tree, kind.node, pos);
  }
  if (node) {
    const marks = marksOf(state, node);
    if (!marks) return null;
    const changes: ChangeSpec[] = [];
    unwrapNode(marks, changes);
    const set = state.changes(changes);
    return { changes: set, range: EditorSelection.cursor(set.mapPos(pos, -1)) };
  }
  const word = state.wordAt(pos);
  if (word && !insideCodeSpan(state, tree, word.from, word.to)) {
    const changes: ChangeSpec[] = [];
    wrap(state, tree, kind, word.from, word.to, changes);
    const set = state.changes(changes);
    return { changes: set, range: EditorSelection.cursor(set.mapPos(pos, pos >= word.to ? -1 : 1)) };
  }
  const { open, close } = newMarks(kind, '');
  const member = { id: kind.id, open, close };
  return {
    changes: { from: pos, insert: open + close },
    range: EditorSelection.cursor(pos + open.length),
    pairs: pushPair(stack, pos, member),
  };
}

/** The empty pair an inline command leaves at a cursor with no word: `**`, `*`, `~~`, `` ` ``, `==`, or a link's. */
export function emptyPair(format: InlineFormat): PairMember {
  if (format === 'link') return LINK_PAIR;
  const kind = { bold: BOLD, italic: ITALIC, strikethrough: STRIKE, code: CODE, highlight: HIGHLIGHT }[format];
  return { id: kind.id, ...newMarks(kind, '') };
}

function toggleInline(kind: InlineKind): StateCommand {
  return (state) => {
    if (!canEdit(state)) return null;
    const ranges = state.selection.ranges;
    const tree = treeForLine(state, ranges[ranges.length - 1]!.to);
    let changed = false;
    let pairs: PairStack | null | undefined;
    const single = ranges.length === 1;
    const result = state.changeByRange((range) => {
      const out = range.empty ? toggleCursor(state, tree, kind, range) : toggleSelection(state, tree, kind, range);
      if (!out) return { range };
      changed = true;
      if (single && out.pairs !== undefined) pairs = out.pairs;
      return { changes: out.changes, range: out.range };
    });
    if (!changed) return null;
    return state.update({
      ...result,
      effects: pairs !== undefined ? setPairsEffect.of(pairs) : [],
      userEvent: COMMAND_EVENT,
      scrollIntoView: true,
    });
  };
}

export const toggleBold: StateCommand = toggleInline(BOLD);
export const toggleItalic: StateCommand = toggleInline(ITALIC);
export const toggleStrikethrough: StateCommand = toggleInline(STRIKE);
export const toggleCode: StateCommand = toggleInline(CODE);
export const toggleHighlight: StateCommand = toggleInline(HIGHLIGHT);

// ---------------------------------------------------------------------------
// Links

/**
 * The link node holding `[from, to]`: a link, image, autolink, wikilink or bare web address. A
 * selection of exactly a bare web address is not "inside" it: Link makes that a link.
 */
function linkNodeAt(tree: Tree, from: number, to: number): SyntaxNode | null {
  const inside =
    from === to ? (n: SyntaxNode) => n.from < from && to < n.to : (n: SyntaxNode) => n.from <= from && to <= n.to;
  for (let n: SyntaxNode | null = tree.resolveInner(from, from === to ? 0 : 1); n; n = n.parent) {
    if (!LINK_NODES.has(n.name) || !inside(n)) continue;
    if (n.name !== 'URL') return n;
    if (n.parent && LINK_NODES.has(n.parent.name)) return n.parent;
    if (from === to || from > n.from || to < n.to) return n;
  }
  return null;
}

/**
 * Where a link's address is: its URL; a reference link's label; the cursor between empty
 * parentheses (`[text]()`); a shortcut reference's text (`[text]`, the text is the label).
 */
function addressOf(state: EditorState, link: SyntaxNode): { from: number; to: number } | null {
  if (link.name === 'URL') return { from: link.from, to: link.to };
  if (link.name === 'Wikilink' || link.name === 'Embed') {
    const target = link.getChild('WikilinkTarget');
    return target ? { from: target.from, to: target.to } : null;
  }
  const url = link.getChild('URL');
  if (url) return { from: url.from, to: url.to };
  const label = link.getChild('LinkLabel');
  if (label) return { from: label.from + 1, to: Math.max(label.from + 1, label.to - 1) };
  const marks = link.getChildren('LinkMark');
  if (marks.length >= 3 && state.doc.sliceString(marks[2]!.from, marks[2]!.to) === '(')
    return { from: marks[2]!.to, to: marks[2]!.to };
  if (marks.length >= 2) return { from: marks[0]!.to, to: marks[1]!.from };
  return null;
}

/**
 * Link: with a selection that is a web address, `[](address)` with the cursor in the text;
 * with other selected text, `[text]()` with the cursor in the address; with none, `[]()` with
 * the cursor in the text. Inside an existing link, its address is selected.
 */
export const insertLink: StateCommand = (state) => {
  if (!canEdit(state)) return null;
  const range = state.selection.main;
  const doc = state.doc;
  const tree = treeForLine(state, range.to);
  const link = linkNodeAt(tree, range.from, range.to);
  if (link) {
    const address = addressOf(state, link);
    if (!address) return null;
    return state.update({
      selection: EditorSelection.range(address.from, address.to),
      scrollIntoView: true,
      userEvent: 'select',
    });
  }
  if (codeAt(tree, range.from) || codeAt(tree, range.to)) return null;
  if (range.empty) {
    return state.update({
      ...insertPair(state, range.head, LINK_PAIR),
      userEvent: COMMAND_EVENT,
      scrollIntoView: true,
    });
  }
  if (doc.lineAt(range.from).number !== doc.lineAt(range.to).number) return null;
  const part = trimPart(state, range.from, range.to);
  if (!part) return null;
  const address = webAddress(doc.sliceString(part.from, part.to));
  if (address) {
    return state.update({
      changes: { from: part.from, to: part.to, insert: `[](${linkDestination(address)})` },
      selection: EditorSelection.cursor(part.from + 1),
      userEvent: COMMAND_EVENT,
      scrollIntoView: true,
    });
  }
  const [s, e] = widen(tree, part.from, part.to);
  return state.update({
    changes: [
      { from: s, insert: '[' },
      { from: e, insert: ']()' },
    ],
    selection: EditorSelection.cursor(e + 3),
    userEvent: COMMAND_EVENT,
    scrollIntoView: true,
  });
};

// ---------------------------------------------------------------------------
// What the toolbar asks

const FORMAT_OF: Record<string, InlineFormat> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strikethrough',
  InlineCode: 'code',
  Highlight: 'highlight',
  Link: 'link',
  Image: 'link',
  Autolink: 'link',
  Wikilink: 'link',
  Embed: 'link',
  URL: 'link',
};

/** The inline formats the main selection sits in: a cursor strictly inside a phrase, or a selection inside it. */
export function inlineFormatsAt(state: EditorState, tree: Tree): Set<InlineFormat> {
  const out = new Set<InlineFormat>();
  const range = state.selection.main;
  const start = range.empty ? tree.resolveInner(range.head, 0) : tree.resolveInner(range.from, 1);
  for (let n: SyntaxNode | null = start; n; n = n.parent) {
    const format = FORMAT_OF[n.name];
    if (!format) continue;
    const holds = range.empty ? n.from < range.head && range.head < n.to : n.from <= range.from && range.to <= n.to;
    if (holds) out.add(format);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The commands

export const inlineCommands: Feature = {
  id: 'inlineCommands',
  commands: {
    toggleBold: asPanelCommand(toggleBold),
    toggleItalic: asPanelCommand(toggleItalic),
    toggleStrikethrough: asPanelCommand(toggleStrikethrough),
    toggleCode: asPanelCommand(toggleCode),
    toggleHighlight: asPanelCommand(toggleHighlight),
    insertLink: asPanelCommand(insertLink),
  },
};
